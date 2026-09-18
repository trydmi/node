/**
 * DMI challenge harness: automated theorem proving in Lean 4 (lean-proofs, L2).
 *
 * Shipped to every participant inside the task payload. The SAME code the coordinator runs on the
 * hidden problem set.
 *
 * The submission is a tactic, not a proof. It is compiled against statements it has never seen, so
 * a lookup table of answers is worth nothing and only something that generalises scores.
 *
 * Objective: `unsolved`, the number of hidden statements the tactic failed to close. Lower is
 * better. Deterministic: the same tactic on the same statements closes the same ones.
 *
 * A statement counts as closed only when both hold:
 *   1. Lean compiled the theorem with no error.
 *   2. `#print axioms` lists nothing outside Lean's own three: propext, Classical.choice, Quot.sound.
 *
 * The second check is the whole anti-cheat. Measured on Lean 4.33.1:
 *   `sorry`          -> depends on axioms: [sorryAx]
 *   a declared axiom -> depends on axioms: [thatAxiom]
 *   `native_decide`  -> depends on axioms: [t._native.native_decide.ax_1_1]
 * All three are rejected, so a tactic cannot claim a goal it did not actually prove.
 *
 * Submission contract: one Lean file that defines a tactic named `dmi_auto`, usually as a macro.
 * Rules enforced before Lean runs (loadPolicySource):
 *   - at most 64 KB of source
 *   - defines dmi_auto
 *   - no `sorry`, no `axiom`, no `native_decide`, no `@[implemented_by]`
 *   - no `import` beyond core Lean, and no `IO`, `unsafe`, or `#eval`
 *
 * Needs `lean` on PATH, or DMI_LEAN_BIN. No mathlib, which keeps the image small and a run short.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Lean's own axioms. Anything else in the list means the proof leaned on something it invented. */
export const ALLOWED_AXIOMS = new Set(['propext', 'Classical.choice', 'Quot.sound'])
export const TACTIC = 'dmi_auto'
export const MAX_SOURCE_BYTES = 64 * 1024
export const TOOL_VERSION = '4.33'

/** What the challenge measures, for the registry and the site. */
export const HARDWARE = { toolchain: 'leanprover/lean4:v4.33.1', mathlib: false }

const BANNED = [
  [/\bsorry\b/, 'sorry'],
  [/\baxiom\b/, 'the axiom keyword'],
  [/\bnative_decide\b/, 'native_decide'],
  [/\bimplemented_by\b/, '@[implemented_by]'],
  [/\bunsafe\b/, 'unsafe'],
  [/^\s*#eval\b/m, '#eval'],
  [/\bIO\.\w/, 'IO'],
  [/^\s*import\s+(?!Init\b|Lean\b)/m, 'importing anything outside core Lean'],
]

/** Comments removed, so a banned word inside a comment does not fail an honest submission. */
export function stripComments(src) {
  return String(src).replace(/\/-[\s\S]*?-\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** Throws with the rule that was broken. Returns { source, sha256 }. */
export function loadPolicySource(source) {
  const src = String(source ?? '')
  if (Buffer.byteLength(src, 'utf8') > MAX_SOURCE_BYTES) throw new Error(`artifact must be under 64 KB`)
  const code = stripComments(src)
  if (!new RegExp(`\\b${TACTIC}\\b`).test(code)) throw new Error(`the artifact must define a tactic named ${TACTIC}`)
  for (const [re, what] of BANNED) if (re.test(code)) throw new Error(`${what} is not allowed`)
  return { source: src, sha256: crypto.createHash('sha256').update(src).digest('hex') }
}

const findBinary = (name, env) => {
  const fromEnv = process.env[env]
  if (fromEnv) return fromEnv
  const r = spawnSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' })
  const p = (r.stdout ?? '').trim().split('\n')[0]
  if (!p) throw new Error(`${name} is not on PATH and ${env} is not set`)
  return p
}
export const resolveLean = () => findBinary('lean', 'DMI_LEAN_BIN')
export const haveLean = () => { try { resolveLean(); return true } catch { return false } }

/** The problem set as written by gen-problems.mjs. */
export function loadTrace(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const problems = doc.problems ?? doc
  if (!Array.isArray(problems) || problems.length === 0) throw new Error(`${file} holds no problems`)
  return { path: file, seed: doc.seed ?? null, problems }
}

/** One Lean file: the submitted tactic, then every goal, then an axiom report for each. */
export function buildSource(tactic, problems) {
  // Definitions a statement needs go first, once each. A family can repeat a definition across
  // problems and Lean will not take it twice.
  const defs = [...new Set(problems.map((p) => p.preamble).filter(Boolean))].join('\n')
  const head = `set_option maxHeartbeats 40000\n${defs}\n${tactic}\n`
  const body = problems.map((p) => `theorem ${p.id} ${p.sig} := by\n  ${TACTIC}`).join('\n')
  const report = problems.map((p) => `#print axioms ${p.id}`).join('\n')
  return `${head}\n${body}\n\n${report}\n`
}

/**
 * Reads Lean's output. A goal counts as closed only when its axiom line is present and every axiom
 * on it is one of Lean's own. A theorem that failed to compile has no axiom line, so it is unsolved.
 */
export function parseResult(stdout, stderr, problems) {
  const out = `${stdout ?? ''}\n${stderr ?? ''}`
  const solved = []
  const rejected = []
  for (const p of problems) {
    const none = new RegExp(`'${p.id}' does not depend on any axioms`).test(out)
    const m = out.match(new RegExp(`'${p.id}' depends on axioms: \\[([^\\]]*)\\]`))
    if (none) { solved.push(p.id); continue }
    if (!m) continue
    const axioms = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    const bad = axioms.filter((a) => !ALLOWED_AXIOMS.has(a))
    if (bad.length) rejected.push({ id: p.id, axioms: bad })
    else solved.push(p.id)
  }
  return { solved, rejected }
}

/**
 * Compiles the tactic against every statement and counts what it closed.
 * Throws when Lean is missing or the run exceeds its budget.
 */
export function simulate(trace, policy, { stepBudgetMs = 300000, bin } = {}) {
  const lean = bin || resolveLean()
  const dir = fs.mkdtempSync(path.join(process.env.DMI_TMP_DIR || os.tmpdir(), 'dmi-lean-'))
  const started = Date.now()
  try {
    const file = path.join(dir, 'Submission.lean')
    fs.writeFileSync(file, buildSource(policy.source, trace.problems))
    const r = spawnSync(lean, [file], {
      cwd: dir,
      encoding: 'utf8',
      timeout: Math.max(1, stepBudgetMs),
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LEAN_NUM_THREADS: process.env.LEAN_NUM_THREADS ?? '2' },
    })
    if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL') throw new Error(`lean exceeded the ${stepBudgetMs} ms budget`)
    const { solved, rejected } = parseResult(r.stdout, r.stderr, trace.problems)
    const total = trace.problems.length
    const canon = JSON.stringify([...solved].sort())
    return {
      unsolved: total - solved.length,
      solved: solved.length,
      total,
      solvedRatio: +(solved.length / total).toFixed(4),
      rejectedForAxioms: rejected,
      hardSolved: trace.problems.filter((p) => p.hard && solved.includes(p.id)).length,
      hardTotal: trace.problems.filter((p) => p.hard).length,
      wallMs: Date.now() - started,
      // Two tactics that close exactly the same goals are the same tactic, whatever they look like.
      fingerprint: crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16),
      source_sha256: policy.sha256,
      lean: TOOL_VERSION,
    }
  } finally {
    // A child killed at the budget can still be writing here. Retry, then drop a failed delete:
    // a throw from finally would replace the real reason the run ended.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* the OS temp sweep gets it */ }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [srcFile, traceFile] = process.argv.slice(2)
  if (!srcFile) { console.error('usage: node harness.js <tactic.lean> [problems.json]'); process.exit(2) }
  const trace = loadTrace(traceFile || path.join(here, 'public-problems.json'))
  const policy = loadPolicySource(fs.readFileSync(srcFile, 'utf8'))
  console.log(JSON.stringify(simulate(trace, policy), null, 2))
}
