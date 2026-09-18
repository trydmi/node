/**
 * DMI challenge harness: DRAM memory controller policy scored in Ramulator 2.0 (dram-controller, L2).
 *
 * Shipped to every participant inside the task payload. The SAME code the coordinator runs on the hidden trace.
 *
 * Model:
 *   - A memory-bound accelerator runs LLM decode. The trace (see gen-trace.mjs) is every DRAM transaction of a few
 *     decode steps: weight streams, paged KV-cache reads that repeat every step, and the new token's KV writes.
 *   - Ramulator 2.0 replays the trace through its LoadStoreTrace frontend, which offers the next request every
 *     frontend tick and stalls when the controller's queue is full. The memory system is DDR4-3200AA, 4 channels,
 *     2 ranks, 64-byte transactions. That hardware is fixed. The submission chooses the controller policy.
 *
 * Objective: memory_system_cycles, the DRAM cycles (tCK = 625 ps) until the last request of the trace is
 * accepted. Lower is better. It is the effective bandwidth of the controller on this workload.
 *
 * Policy contract (a JSON document, not code; // comments allowed):
 *
 *   {
 *     "scheduler": "FRFCFS",                                    // only FRFCFS exists for the Generic controller
 *     "refresh": "AllBank",                                     // only AllBank exists for the Generic controller
 *     "row_policy": { "impl": "OpenRowPolicy" }                 // or { "impl": "ClosedRowPolicy", "cap": 1..4096 }
 *     "addr_mapper": "RoBaRaCoCh" | "ChRaBaRoCo" | "MOP4CLXOR",
 *     "wr_low_watermark": 0.2,  "wr_high_watermark": 0.8       // write-drain thresholds, 0..1, low < high
 *   }
 *
 *   Any key outside this list, any value outside its range, throws. A missing key takes the baseline value.
 *
 * Time budget: 120 s per trace. Ramulator runs as a child process and is killed at the budget.
 * Needs the Ramulator 2.0 binary: env DMI_RAMULATOR_BIN (or /opt/ramulator2/ramulator2 in the challenge image).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const RAMULATOR_COMMIT = '5e58d25f1a6efbbe6a4dceb42025d4af43fc75c6' // Ramulator 2.0, CMU-SAFARI/ramulator2, 2026-01-06
export const DEFAULT_BIN = '/opt/ramulator2/ramulator2'

/** The hardware. Not part of the submission. */
export const HARDWARE = {
  dram: 'DDR4', orgPreset: 'DDR4_8Gb_x8', channels: 4, ranks: 2, timingPreset: 'DDR4_3200AA', tCKps: 625,
  transactionBytes: 64, frontendClockRatio: 8, memoryClockRatio: 1,
}

/** Allowlist: every key a submission may set, and the values Ramulator 2.0's Generic controller accepts for it. */
export const ALLOWED = {
  scheduler: ['FRFCFS'],
  refresh: ['AllBank'],
  row_policy: ['OpenRowPolicy', 'ClosedRowPolicy'],
  cap: { min: 1, max: 4096 },
  addr_mapper: ['RoBaRaCoCh', 'ChRaBaRoCo', 'MOP4CLXOR'],
  watermark: { min: 0, max: 1 },
}
/** Baseline: the controller block of Ramulator 2.0's shipped example_config.yaml plus the Generic controller's watermark defaults. */
export const DEFAULTS = Object.freeze({
  scheduler: 'FRFCFS', refresh: 'AllBank', row_policy: { impl: 'ClosedRowPolicy', cap: 4 }, addr_mapper: 'RoBaRaCoCh',
  wr_low_watermark: 0.2, wr_high_watermark: 0.8,
})

const TOP_KEYS = ['scheduler', 'refresh', 'row_policy', 'addr_mapper', 'wr_low_watermark', 'wr_high_watermark']
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const oneOf = (key, v, list) => { if (typeof v !== 'string' || !list.includes(v)) throw new Error(`${key} must be one of ${list.join(', ')}; got ${JSON.stringify(v)}`); return v }
const number = (key, v, { min, max }) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${key} must be a number in [${min}, ${max}]; got ${JSON.stringify(v)}`); return v }

/**
 * Parses and validates a policy document. Accepts a JSON string (// and block comments allowed) or an object.
 * Throws on anything outside the allowlist. Returns the full, merged policy.
 */
export function loadPolicySource(source) {
  let doc = source
  if (typeof source === 'string') {
    if (source.length > 20_000) throw new Error('policy document must be under 20 KB')
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    try { doc = JSON.parse(stripped) } catch (e) { throw new Error(`policy is not a JSON document: ${e.message}`) }
  }
  if (!isPlainObject(doc)) throw new Error('policy must be a JSON object')
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) throw new Error(`unknown key "${k}"; allowed keys: ${TOP_KEYS.join(', ')}`)
  const p = { ...DEFAULTS, row_policy: { ...DEFAULTS.row_policy } }
  if ('scheduler' in doc) p.scheduler = oneOf('scheduler', doc.scheduler, ALLOWED.scheduler)
  if ('refresh' in doc) p.refresh = oneOf('refresh', doc.refresh, ALLOWED.refresh)
  if ('addr_mapper' in doc) p.addr_mapper = oneOf('addr_mapper', doc.addr_mapper, ALLOWED.addr_mapper)
  if ('wr_low_watermark' in doc) p.wr_low_watermark = number('wr_low_watermark', doc.wr_low_watermark, ALLOWED.watermark)
  if ('wr_high_watermark' in doc) p.wr_high_watermark = number('wr_high_watermark', doc.wr_high_watermark, ALLOWED.watermark)
  if (p.wr_low_watermark >= p.wr_high_watermark) throw new Error('wr_low_watermark must be below wr_high_watermark')
  if ('row_policy' in doc) {
    const rp = doc.row_policy
    if (!isPlainObject(rp)) throw new Error('row_policy must be an object like { "impl": "OpenRowPolicy" }')
    for (const k of Object.keys(rp)) if (!['impl', 'cap'].includes(k)) throw new Error(`unknown row_policy key "${k}"; allowed: impl, cap`)
    const impl = oneOf('row_policy.impl', rp.impl, ALLOWED.row_policy)
    if (impl === 'OpenRowPolicy') { if ('cap' in rp) throw new Error('row_policy.cap only applies to ClosedRowPolicy'); p.row_policy = { impl } }
    else {
      const cap = 'cap' in rp ? rp.cap : DEFAULTS.row_policy.cap
      if (!Number.isInteger(cap)) throw new Error(`row_policy.cap must be an integer; got ${JSON.stringify(cap)}`)
      p.row_policy = { impl, cap: number('row_policy.cap', cap, ALLOWED.cap) }
    }
  }
  return p
}

/** The exact YAML Ramulator 2.0 runs: hardware fixed, policy merged in. */
export function renderConfig(policy, tracePath) {
  const h = HARDWARE
  const rp = policy.row_policy.impl === 'ClosedRowPolicy' ? `      impl: ClosedRowPolicy\n      cap: ${policy.row_policy.cap}` : '      impl: OpenRowPolicy'
  return [
    'Frontend:', '  impl: LoadStoreTrace', `  clock_ratio: ${h.frontendClockRatio}`, `  path: ${tracePath}`, '',
    'MemorySystem:', '  impl: GenericDRAM', `  clock_ratio: ${h.memoryClockRatio}`,
    '  DRAM:', `    impl: ${h.dram}`, '    org:', `      preset: ${h.orgPreset}`, `      channel: ${h.channels}`, `      rank: ${h.ranks}`, '    timing:', `      preset: ${h.timingPreset}`,
    '  Controller:', '    impl: Generic', `    wr_low_watermark: ${policy.wr_low_watermark}`, `    wr_high_watermark: ${policy.wr_high_watermark}`,
    '    Scheduler:', `      impl: ${policy.scheduler}`, '    RefreshManager:', `      impl: ${policy.refresh}`, '    RowPolicy:', rp,
    '  AddrMapper:', `    impl: ${policy.addr_mapper}`, '',
  ].join('\n')
}

/** Ramulator prints its stats as YAML on stdout after two log lines. This pulls every "key: value" pair out of that block. */
export function parseStats(stdout) {
  const start = stdout.indexOf('\nFrontend:')
  const block = start >= 0 ? stdout.slice(start + 1) : stdout.startsWith('Frontend:') ? stdout : ''
  if (!block) throw new Error('ramulator produced no stats block')
  const pairs = []
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s+(\S.*?)\s*$/)
    if (m && m[1] !== 'impl' && m[1] !== 'id') pairs.push([m[1], m[2]])
  }
  const sum = (re) => pairs.filter(([k]) => re.test(k)).reduce((a, [, v]) => a + Number(v), 0)
  const one = (k) => { const hit = pairs.find(([kk]) => kk === k); if (!hit) throw new Error(`stat ${k} missing`); return Number(hit[1]) }
  const cycles = one('memory_system_cycles')
  const reads = one('total_num_read_requests'), writes = one('total_num_write_requests')
  const rowHits = sum(/^row_hits_\d+$/), rowMisses = sum(/^row_misses_\d+$/), rowConflicts = sum(/^row_conflicts_\d+$/)
  const readLatency = sum(/^read_latency_\d+$/)
  // Hash of every stat, sorted, so the fingerprint does not depend on Ramulator's map iteration order.
  const canon = pairs.map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const fingerprint = crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16)
  return { cycles, reads, writes, rowHits, rowMisses, rowConflicts, readLatency, fingerprint, stats: Object.fromEntries(pairs) }
}

export function resolveBinary(bin = process.env.DMI_RAMULATOR_BIN) {
  const candidate = bin || DEFAULT_BIN
  if (!fs.existsSync(candidate)) throw new Error(`ramulator binary not found at ${candidate}; set DMI_RAMULATOR_BIN`)
  return candidate
}

/**
 * Runs Ramulator on the trace with the policy. `trace` is what loadTrace() returns. Throws when the run exceeds
 * stepBudgetMs, when Ramulator exits non-zero, or when the stats do not account for every request in the trace.
 */
export function simulate(trace, policy, { stepBudgetMs = 120000, bin } = {}) {
  if (typeof policy === 'function') policy = policy() // tolerate a factory
  const p = loadPolicySource(policy)
  const exe = resolveBinary(bin)
  const dir = fs.mkdtempSync(path.join(process.env.DMI_TMP_DIR ?? os.tmpdir(), 'dmi-dram-'))
  const started = Date.now()
  try {
    const cfg = path.join(dir, 'config.yaml')
    fs.writeFileSync(cfg, renderConfig(p, trace.path))
    const r = spawnSync(exe, ['-f', cfg], { cwd: dir, encoding: 'utf8', timeout: stepBudgetMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}) } })
    const wallMs = Date.now() - started
    if (r.error?.code === 'ETIMEDOUT' || (r.signal && wallMs >= stepBudgetMs - 50)) throw new Error(`policy exceeded time budget (${stepBudgetMs} ms)`)
    if (r.error) throw new Error(`ramulator failed to start: ${r.error.message}`)
    if (r.status !== 0) throw new Error(`ramulator exited with ${r.status ?? r.signal}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
    const s = parseStats(r.stdout)
    if (s.reads + s.writes !== trace.lines) throw new Error(`ramulator accepted ${s.reads + s.writes} requests, trace has ${trace.lines}`)
    const rowTotal = s.rowHits + s.rowMisses + s.rowConflicts
    const bytes = trace.lines * HARDWARE.transactionBytes
    return {
      cycles: s.cycles,
      /** Row-buffer hit rate over every scheduled read and write, the closest thing to a cache hit rate here. */
      hitRate: rowTotal ? s.rowHits / rowTotal : 0,
      rowHits: s.rowHits, rowMisses: s.rowMisses, rowConflicts: s.rowConflicts,
      /** Mean read latency in DRAM cycles over accepted reads (Ramulator's own avg_read_latency divides by send attempts, which includes rejected ones). */
      readLatencyAvg: s.reads ? s.readLatency / s.reads : 0,
      bandwidthGBps: s.cycles ? bytes / (s.cycles * HARDWARE.tCKps * 1e-12) / 1e9 : 0,
      requests: trace.lines, reads: s.reads, writes: s.writes,
      policy: p, fingerprint: s.fingerprint, wallMs,
    }
  } finally {
    // A child killed at the budget can still be writing here. Retry, then drop a failed delete:
    // a throw from finally would replace the real reason the run ended.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* the OS temp sweep gets it */ }
  }
}

/** A trace is a LoadStoreTrace file on disk. Returns { path, lines, seed } (seed from the sidecar .meta.json when present). */
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
  const here = path.dirname(fileURLToPath(import.meta.url))
  const [policyFile, traceFile = path.join(here, 'public-trace.trace')] = process.argv.slice(2)
  if (!policyFile) { console.error('usage: DMI_RAMULATOR_BIN=... node harness.js <policy.json> [trace.trace]'); process.exit(2) }
  const { stats, ...result } = simulate(loadTrace(traceFile), loadPolicySource(fs.readFileSync(policyFile, 'utf8')))
  console.log(JSON.stringify(result, null, 2))
}
