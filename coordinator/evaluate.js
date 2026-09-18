/**
 * Run a policy in a fresh child process. node:vm alone is a fault boundary, not a
 * security boundary, so every evaluation gets its own process with a hard timeout.
 * Reproduction is a second, independent run of the same source on the same trace.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evaluate-worker.js')
const findOnPath = (name) => { for (const d of (process.env.PATH ?? '').split(path.delimiter)) { const p = path.join(d, name); try { fs.accessSync(p, fs.constants.X_OK); return p } catch {} } return null }

// Bounded evaluation queue: at most MAX_CONCURRENT child processes at once, at most MAX_QUEUE waiting.
// Beyond that the caller gets a busy error instead of the box forking itself to death.
const MAX_CONCURRENT = Number(process.env.DMI_EVAL_CONCURRENCY ?? 4)
const MAX_QUEUE = Number(process.env.DMI_EVAL_QUEUE ?? 64)
let running = 0
const waiting = []
export const queueStats = () => ({ running, waiting: waiting.length, maxConcurrent: MAX_CONCURRENT, maxQueue: MAX_QUEUE })
function acquire() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(true) }
  if (waiting.length >= MAX_QUEUE) return Promise.resolve(false)
  return new Promise((resolve) => waiting.push(resolve))
}
function release() {
  const next = waiting.shift()
  if (next) next(true); else running--
}

// Remote mode: when DMI_EVALUATOR_URL is set, the coordinator forwards jobs to the evaluator service, which holds no
// secrets. The job names the challenge and which trace to use; the evaluator resolves paths on its own disk.
const REMOTE = (process.env.DMI_EVALUATOR_URL ?? '').replace(/\/$/, '')
const REMOTE_TOKEN = process.env.DMI_EVALUATOR_TOKEN ?? ''
function jobFor(tracePath, harnessPath, opts = {}) {
  const challenge = opts.challenge ?? path.basename(path.dirname(harnessPath))
  const trace = opts.hiddenTrace ? (tracePath === opts.hiddenTrace ? 'hidden' : 'public') : path.basename(tracePath).includes('hidden') ? 'hidden' : 'public'
  return { challenge, trace }
}
const remoteFor = (challenge) => (process.env[`DMI_EVALUATOR_URL_${challenge.toUpperCase().replace(/-/g, '_')}`] ?? REMOTE).replace(/\/$/, '')
export async function evaluate(source, tracePath, harnessPath, opts = {}) {
  const { challenge, trace } = jobFor(tracePath, harnessPath, opts)
  // A sponsored instance runs on the evaluator of its base challenge.
  const remote = remoteFor(opts.base ?? challenge)
  if (!remote) return runLocal(source, tracePath, harnessPath, opts)
  try {
    const r = await fetch(`${remote}/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-evaluator-token': REMOTE_TOKEN }, body: JSON.stringify({ source, challenge, trace, stepBudgetMs: opts.stepBudgetMs ?? 10000 }), signal: AbortSignal.timeout((opts.killAfterMs ?? 60000) + 15000) })
    const body = await r.json()
    if (r.status === 503) return { ok: false, busy: true, error: body.error ?? 'evaluator busy' }
    return body
  } catch (e) { return { ok: false, busy: true, error: `evaluator unreachable: ${e.message}` } }
}

export async function runLocal(source, tracePath, harnessPath, opts = {}) {
  const slot = await acquire()
  if (!slot) return { ok: false, busy: true, error: 'evaluator busy: the queue is full, retry in a minute' }
  try { return await runChild(source, tracePath, harnessPath, opts) } finally { release() }
}

function runChild(source, tracePath, harnessPath, { stepBudgetMs = 10000, killAfterMs = 60000, worker, tools = null } = {}) {
  return new Promise((resolve) => {
    // Scrubbed env (no keys, no seeds), memory cap, and the Node permission model: no child processes, no worker threads,
    // and filesystem reads limited to the harness directory and the trace. Containers replace this in the evaluator service.
    // Contest-mirror harnesses are thin wrappers over challenges/_contest/harness.js, so that directory is always readable.
    const allow = [path.dirname(harnessPath), tracePath, WORKER, path.join(path.dirname(WORKER), '..', 'node_modules'), path.join(path.dirname(WORKER), 'challenges', '_contest')]
    const flags = ['--max-old-space-size=768', '--experimental-permission', ...allow.map((p) => `--allow-fs-read=${p}`)]
    const env = { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' }
    // Simulator-backed challenges (L2 and up) spawn a pinned binary and write a config into scratch space.
    // Their real boundary is the container they run in; the worker flags only widen what that challenge needs.
    if (worker?.allowChildProcess) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-eval-'))
      flags.push('--allow-child-process', `--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`)
      // The worker cannot stat anything outside its allowlist, so binaries are resolved here and handed over by path.
      // The same directory twice (verilator and yosys both in /opt/homebrew/bin) crashes Node's permission model, so each is allowed once.
      const allowed = new Set()
      // nvcc is resolved only for a challenge that asks for it (`tools` on the registry entry). Every other
      // challenge sees the same four binaries and the same flags it saw before, on a box with CUDA installed too.
      const bins = [['DMI_RAMULATOR_BIN', null], ['DMI_VERILATOR_BIN', 'verilator'], ['DMI_YOSYS_BIN', 'yosys'], ['DMI_CXX_BIN', 'c++']]
      if (tools?.includes('nvcc')) bins.push(['DMI_NVCC_BIN', 'nvcc'])
      for (const [k, name] of bins) {
        const bin = process.env[k] || (name && findOnPath(name))
        if (!bin) continue
        env[k] = bin
        // nvcc is a front end: it reaches for cicc, ptxas, nvlink and the toolkit headers under its own ../include
        // and ../nvvm, so the toolkit root is read, not just the bin directory.
        const d = name === 'nvcc' ? path.dirname(path.dirname(bin)) : path.dirname(bin)
        if (!allowed.has(d)) { allowed.add(d); flags.push(`--allow-fs-read=${d}`) }
      }
      for (const k of ['LD_LIBRARY_PATH', 'VERILATOR_ROOT', 'CUDA_HOME', 'CUDA_PATH', 'CUDA_VISIBLE_DEVICES']) if (process.env[k]) env[k] = process.env[k]
      env.TMPDIR = scratch; env.DMI_TMP_DIR = scratch
    }
    const child = spawn(process.execPath, [...flags, WORKER], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let out = ''
    let err = ''
    let done = false
    const t0 = Date.now()
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(hard); if (process.env.DMI_DEBUG) console.error(`[eval] ${Date.now() - t0} ms ${path.basename(tracePath)} ${v.ok ? 'ok ' + Math.round(v.result.bytesPerToken ?? v.result.cycles ?? v.result.medianMs ?? v.result.compressedBytes ?? 0) : 'ERR ' + v.error} stderr=${err.slice(0, 200).replace(/\n/g, ' ')}`); resolve(v) }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: `evaluation killed after ${killAfterMs} ms` }) }, killAfterMs)
    // Safety net: if the child neither closes nor errors, never hang the caller.
    const hard = setTimeout(() => { try { child.kill('SIGKILL') } catch {} finish({ ok: false, error: 'evaluator did not respond' }) }, killAfterMs + 10000)
    child.on('error', (e) => finish({ ok: false, error: `evaluator spawn failed: ${e.message}` }))
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', () => {
      try { finish(JSON.parse(out)) } catch { finish({ ok: false, error: `worker produced no result: ${err.slice(0, 300)}` }) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ source, tracePath, harnessPath, stepBudgetMs }))
  })
}

/** Two values agree within a percent band of the smaller one. Zero agrees only with zero. */
export function withinTolerance(a, b, pct) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const lo = Math.min(a, b), hi = Math.max(a, b)
  if (lo <= 0) return lo === hi
  return ((hi - lo) / lo) * 100 <= pct
}

/**
 * Two independent runs must agree byte for byte on the objective. A timing challenge (opts.kind === 'timing') is
 * the one exception: its objective is wall time, so the rerun must land within opts.tolerancePct of the first run.
 */
export async function reproduce(source, tracePath, harnessPath, first, opts) {
  const second = await evaluate(source, tracePath, harnessPath, opts)
  if (!second.ok) return { reproduced: false, reason: second.error }
  // Same objective value and the same decision fingerprint, whatever the challenge measures.
  const objective = opts?.objective ?? 'bytesPerToken'
  const sameFp = (second.result.fingerprint ?? null) === (first.fingerprint ?? null)
  if (opts?.kind === 'timing') {
    const pct = opts.tolerancePct ?? 3
    const same = sameFp && withinTolerance(second.result[objective], first[objective], pct)
    return { reproduced: same, reason: same ? `independent rerun within ${pct}% (${first[objective]} vs ${second.result[objective]})` : `rerun outside the ${pct}% band (${first[objective]} vs ${second.result[objective]})` }
  }
  const same = second.result[objective] === first[objective] && sameFp
  return { reproduced: same, reason: same ? 'independent rerun matched' : 'rerun disagreed with first run' }
}

/** In remote mode, push a replaced hidden trace to the evaluator so both sides score the same window. */
export async function pushHiddenTrace(challengeId, buffer) {
  if (!REMOTE) return { ok: true, local: true }
  const r = await fetch(`${REMOTE}/traces/${challengeId}/hidden`, { method: 'PUT', headers: { 'x-evaluator-token': REMOTE_TOKEN }, body: buffer })
  return r.json()
}
export const evaluatorMode = () => (REMOTE ? 'remote' : 'local')
