/**
 * DMI challenge harness: cache replacement and prefetch policy in synthesizable Verilog, scored in Verilator
 * (rtl-cache-controller, L3).
 *
 * Shipped to every participant inside the task payload. The SAME code the coordinator runs on the hidden trace.
 *
 * Model (tb.cpp, fixed):
 *   - a 16 KB, 4-way set-associative, 64-byte-line cache in front of an in-order core
 *   - the trace is one access per line ("R <hex>" or "W <hex>", 32-bit byte addresses)
 *   - a hit costs 1 cycle; a demand miss stalls until the fill returns (latency 40, one issue per 4 cycles on
 *     the channel, 4 fill slots); a prefetch takes a slot and channel time and never stalls the core
 *   - the submission decides which way every fill overwrites (victim_way) and may request prefetches
 *
 * Objective: cycles = accesses + stall cycles. Lower is better. Deterministic: same source, same trace, same count.
 *
 * Submission contract: one Verilog file with module dmi_cache_policy and exactly this port list (see PORTS).
 * Rules enforced here before Verilator runs (loadPolicySource):
 *   - at most 64 KB of source, one module named dmi_cache_policy, the port names exactly as listed
 *   - no system tasks except $signed, $unsigned, $clog2, $bits (so no $system, $fopen, $display, $c, $readmem)
 *   - no DPI, no `include, no directives outside `define/`ifdef/`ifndef/`elsif/`else/`endif/`undef/`default_nettype
 *   - no delays (#), no initial blocks other than constant assignments, no fork, wait, force, release, event
 *   - no verilator metacomments
 * Verilator's default warnings (WIDTH, UNOPTFLAT and the rest) are fatal; the message comes back in the error.
 *
 * Time budget: 150 s per trace for compile plus simulation. The baseline compiles in about 2 s and runs in
 * under 1 s on a laptop. Needs Verilator on PATH, or env DMI_VERILATOR_BIN.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const TESTBENCH = path.join(here, 'tb.cpp')
export const VERILATOR_MIN = '5.006' // Debian bookworm's package; the flags below exist there and in 5.052 (measured)

/** The cache and memory the testbench models. Not part of the submission. */
export const HARDWARE = {
  sets: 64, ways: 4, lineBytes: 64, capacityBytes: 16384, addrBits: 32,
  hitCycles: 1, missLatency: 40, issueIntervalCycles: 4, maxInflightFills: 4, writeBack: true, writeAllocate: true,
}

/** The port list every submission must declare, name for name. Widths are checked by Verilator (WIDTH is fatal). */
export const PORTS = [
  ['input', 'clk', 1], ['input', 'rst_n', 1],
  ['input', 'access_valid', 1], ['input', 'access_addr', 32], ['input', 'access_set', 6], ['input', 'access_hit', 1],
  ['input', 'access_way', 2], ['input', 'access_write', 1], ['input', 'access_prefetch', 1],
  ['output', 'victim_way', 2], ['output', 'prefetch_valid', 1], ['output', 'prefetch_addr', 32],
  ['input', 'prefetch_ready', 1],
]
export const MODULE = 'dmi_cache_policy'
export const MAX_SOURCE_BYTES = 64 * 1024

const ALLOWED_SYSTEM = new Set(['$signed', '$unsigned', '$clog2', '$bits'])
const ALLOWED_DIRECTIVES = new Set(['define', 'ifdef', 'ifndef', 'elsif', 'else', 'endif', 'undef', 'default_nettype'])
const BANNED_WORDS = ['fork', 'wait', 'force', 'release', 'event', 'import', 'export', 'DPI', 'program', 'class', 'interface', 'bind', 'specify']

/** Comments and string literals removed, so the rules below see only code. Strings are kept as "" so the position of the code holds. */
export function stripSource(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

/**
 * Validates a submission. Accepts the Verilog source as a string. Throws on any rule violation with a message
 * that says which rule. Returns { source, sha256 }.
 */
export function loadPolicySource(source) {
  if (typeof source === 'function') source = source()
  if (typeof source !== 'string') throw new Error('submission must be Verilog source text')
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) throw new Error(`source must be under ${MAX_SOURCE_BYTES / 1024} KB`)
  if (/\0/.test(source)) throw new Error('source contains a NUL byte')
  const comments = (source.match(/\/\*[\s\S]*?\*\//g) ?? []).concat(source.match(/\/\/[^\n]*/g) ?? [])
  for (const c of comments) if (/verilator/i.test(c)) throw new Error('verilator metacomments are not allowed')
  const code = stripSource(source)

  for (const m of code.matchAll(/`\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!ALLOWED_DIRECTIVES.has(m[1])) throw new Error(`directive \`${m[1]} is not allowed; allowed: ${[...ALLOWED_DIRECTIVES].map((d) => '`' + d).join(', ')}`)
  }
  for (const m of code.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (!ALLOWED_SYSTEM.has(m[0])) throw new Error(`system task ${m[0]} is not allowed; allowed: ${[...ALLOWED_SYSTEM].join(', ')}`)
  }
  for (const w of BANNED_WORDS) if (new RegExp(`(^|[^A-Za-z0-9_$])${w}([^A-Za-z0-9_$]|$)`).test(code)) throw new Error(`keyword ${w} is not allowed`)
  if (/#\s*[0-9(]/.test(code)) throw new Error('delays (#) are not allowed; the design must be synthesizable')
  if (/@\s*\(?\s*\*?\s*\)?\s*;/.test(code) || /@\s*\(\s*(negedge|posedge)?\s*[A-Za-z_][A-Za-z0-9_]*\s*\)\s*;/.test(code)) throw new Error('event waits (@ as a statement) are not allowed')
  for (const m of code.matchAll(/\binitial\b\s*(begin\b([\s\S]*?)\bend\b|([^;]*;))/g)) {
    const body = (m[2] ?? m[3] ?? '').trim()
    const stmts = body.split(';').map((s) => s.trim()).filter(Boolean)
    for (const s of stmts) if (!/^[A-Za-z_][A-Za-z0-9_]*(\s*\[[^\]]*\])?\s*<?=\s*[0-9]+('[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_]+)?$/.test(s) && !/^[0-9]*'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_]+$/.test(s)) throw new Error('initial blocks may only assign constants to registers; use rst_n for everything else')
  }

  const modules = [...code.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
  if (modules.filter((m) => m === MODULE).length !== 1) throw new Error(`source must define exactly one module named ${MODULE}; found ${modules.length ? modules.join(', ') : 'none'}`)
  const header = code.match(new RegExp(`\\bmodule\\s+${MODULE}\\s*(?:#\\s*\\([^)]*\\))?\\s*\\(([\\s\\S]*?)\\)\\s*;`))
  if (!header) throw new Error(`cannot parse the port list of ${MODULE}`)
  const names = []
  for (const decl of header[1].split(',')) {
    const t = decl.trim()
    if (!t) continue
    const m = t.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(\[[^\]]*\])?\s*$/)
    if (!m) throw new Error(`cannot parse port declaration "${t.slice(0, 40)}"`)
    names.push(m[1])
  }
  const expected = PORTS.map((p) => p[1])
  const missing = expected.filter((n) => !names.includes(n)), extra = names.filter((n) => !expected.includes(n))
  if (missing.length || extra.length || names.length !== expected.length) {
    throw new Error(`port list must be exactly: ${expected.join(', ')}` + (missing.length ? `; missing ${missing.join(', ')}` : '') + (extra.length ? `; unexpected ${extra.join(', ')}` : ''))
  }
  return { source, sha256: crypto.createHash('sha256').update(source).digest('hex') }
}

/** Finds the Verilator executable: DMI_VERILATOR_BIN, else `verilator` on PATH. */
export function resolveBinary(bin = process.env.DMI_VERILATOR_BIN) {
  if (bin) { if (!fs.existsSync(bin)) throw new Error(`verilator not found at ${bin} (DMI_VERILATOR_BIN)`); return bin }
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(d, 'verilator')
    // Inside the evaluator worker the permission model denies the stat; the child process itself is not restricted.
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch (e) { if (e?.code === 'ERR_ACCESS_DENIED') return p }
  }
  throw new Error('verilator not found on PATH; set DMI_VERILATOR_BIN')
}
export const haveVerilator = () => { try { resolveBinary(); return true } catch { return false } }

const childEnv = () => {
  const env = { PATH: process.env.PATH ?? '' }
  for (const k of ['VERILATOR_ROOT', 'HOME', 'TMPDIR', 'LD_LIBRARY_PATH']) if (process.env[k]) env[k] = process.env[k]
  return env
}

/** The exact Verilator command line. Every flag was checked against Verilator 5.052 on 2026-09-07. */
export const verilatorArgs = (mdir) => [
  '--cc', '--exe', '--build', '-j', '2',
  '--x-initial', '0', '--x-assign', '0', '-O3',
  '--top-module', MODULE, '--Mdir', mdir, '-o', 'sim',
  'tb.cpp', 'policy.v',
]

/**
 * Compiles the submission with the testbench and runs it on the trace. `trace` is what loadTrace() returns.
 * Throws when compile or run exceeds stepBudgetMs (compile and simulation share it), when Verilator rejects the
 * design, or when the simulation does not account for every access in the trace.
 */
export function simulate(trace, policy, { stepBudgetMs = 150000, bin } = {}) {
  const p = typeof policy === 'string' || typeof policy === 'function' ? loadPolicySource(policy) : policy
  if (!p?.source) throw new Error('policy must come from loadPolicySource()')
  const exe = resolveBinary(bin)
  const dir = fs.mkdtempSync(path.join(process.env.DMI_TMP_DIR ?? os.tmpdir(), 'dmi-rtl-'))
  const started = Date.now()
  const remaining = () => stepBudgetMs - (Date.now() - started)
  try {
    fs.writeFileSync(path.join(dir, 'policy.v'), p.source)
    fs.copyFileSync(TESTBENCH, path.join(dir, 'tb.cpp'))
    const mdir = path.join(dir, 'obj')
    const c = spawnSync(exe, verilatorArgs(mdir), { cwd: dir, encoding: 'utf8', timeout: Math.max(1, remaining()), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, env: childEnv() })
    const compileMs = Date.now() - started
    if (c.error?.code === 'ETIMEDOUT' || (c.signal && remaining() <= 50)) throw new Error(`compile exceeded time budget (${stepBudgetMs} ms)`)
    if (c.error) throw new Error(`verilator failed to start: ${c.error.message}`)
    if (c.status !== 0) {
      const lines = (c.stderr || c.stdout || '').split('\n').filter((l) => /^%(Error|Warning)/.test(l))
      throw new Error(`verilator rejected the design: ${(lines.length ? lines : [(c.stderr || c.stdout || '').trim().split('\n').slice(-3).join(' | ')]).join(' | ').slice(0, 600)}`)
    }
    const sim = path.join(mdir, 'sim')
    if (!fs.existsSync(sim)) throw new Error('verilator produced no executable')
    const r = spawnSync(sim, [trace.path], { cwd: dir, encoding: 'utf8', timeout: Math.max(1, remaining()), killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: childEnv() })
    const wallMs = Date.now() - started
    if (r.error?.code === 'ETIMEDOUT' || (r.signal && remaining() <= 50)) throw new Error(`simulation exceeded time budget (${stepBudgetMs} ms)`)
    if (r.error) throw new Error(`simulation failed to start: ${r.error.message}`)
    if (r.status !== 0) throw new Error(`simulation exited with ${r.status ?? r.signal}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
    const s = parseStats(r.stdout)
    if (s.accesses !== trace.lines) throw new Error(`simulation replayed ${s.accesses} accesses, trace has ${trace.lines}`)
    return {
      valid: true,
      cycles: s.cycles, stalls: s.stalls,
      hitRate: s.accesses ? s.hits / s.accesses : 0,
      hits: s.hits, misses: s.misses, prefetches: s.prefetches, prefetchHits: s.prefetchHits, prefetchDropped: s.prefetchDropped, writebacks: s.writebacks,
      accesses: s.accesses, reads: s.reads, writes: s.writes, events: s.events,
      fingerprint: s.fingerprint, source_sha256: p.sha256, compileMs, simMs: wallMs - compileMs, wallMs,
    }
  } finally {
    // A child killed at the budget can still be writing here. Retry, then drop a failed delete:
    // a throw from finally would replace the real reason the run ended.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* the OS temp sweep gets it */ }
  }
}

/** The testbench prints one JSON line. Fingerprint: hash of every statistic plus the decision hash, sorted by key. */
export function parseStats(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('{'))
  if (!line) throw new Error('simulation produced no result line')
  let s
  try { s = JSON.parse(line) } catch (e) { throw new Error(`simulation result is not JSON: ${e.message}`) }
  for (const k of ['accesses', 'cycles', 'stalls', 'hits', 'misses', 'prefetches', 'prefetchHits', 'prefetchDropped', 'writebacks', 'events', 'reads', 'writes']) {
    if (!Number.isInteger(s[k]) || s[k] < 0) throw new Error(`stat ${k} missing or not an integer`)
  }
  if (typeof s.decisionHash !== 'string') throw new Error('decisionHash missing')
  const canon = Object.keys(s).sort().map((k) => `${k}=${s[k]}`).join('\n')
  return { ...s, fingerprint: crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16) }
}

/** A trace is a text file on disk. Returns { path, lines, seed } (seed from the sidecar .meta.json when present). */
export function loadTrace(file) {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) throw new Error(`trace not found: ${abs}`)
  let lines = 0
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) for (let i = 0; i < n; i++) if (buf[i] === 10) lines++
  } finally { fs.closeSync(fd) }
  let seed = null
  try { seed = JSON.parse(fs.readFileSync(abs.replace(/\.trace$/, '') + '.meta.json', 'utf8')).seed ?? null } catch {}
  return { path: abs, lines, seed }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [policyFile, traceFile = path.join(here, 'public-trace.trace')] = process.argv.slice(2)
  if (!policyFile) { console.error('usage: node harness.js <policy.v> [trace.trace]'); process.exit(2) }
  const result = simulate(loadTrace(traceFile), loadPolicySource(fs.readFileSync(policyFile, 'utf8')))
  console.log(JSON.stringify(result, null, 2))
}
