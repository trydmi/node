/**
 * DMI challenge harness: a synthesizable FIFO with an in-line CRC-8, checked in Verilator and scored by area and
 * timing after synthesis in Yosys (rtl-synth-fifo, L4).
 *
 * Shipped to every participant inside the task payload. The SAME code the coordinator runs on the hidden trace.
 *
 * Two stages, in this order:
 *   1. Functional check. tb.cpp (compiled with the submission by Verilator) drives the seeded push and pop
 *      stimulus and compares every output, every cycle, against a golden C++ model. One disagreement fails the
 *      submission and synthesis never runs, so a smaller design that is wrong scores nothing.
 *   2. Synthesis. Yosys reads the design, runs `synth -flatten`, maps flops with dfflibmap and logic with abc
 *      against the vendored sky130_fd_sc_hd typical-corner liberty file, then `stat -liberty` reports the cell
 *      area and abc's `stime` reports the critical combinational path.
 *
 * Objective: ppa = area (square microns) times critical path (ns). Lower is better. Deterministic: same source,
 * same tool versions, same number (proved by running the flow twice and comparing the netlists).
 *
 * Submission contract: one Verilog file with module dmi_fifo_crc and exactly this port list (see PORTS).
 * Rules enforced here before Verilator runs (loadPolicySource):
 *   - at most 64 KB of source, one module named dmi_fifo_crc, the port names exactly as listed
 *   - no system tasks except $signed, $unsigned, $clog2, $bits (so no $system, $fopen, $display, $c, $readmem)
 *   - no DPI, no `include, no directives outside `define/`ifdef/`ifndef/`elsif/`else/`endif/`undef/`default_nettype
 *   - no delays (#), no initial blocks other than constant assignments, no fork, wait, force, release, event
 *   - no verilator metacomments
 * Verilator's default warnings are fatal. Yosys warnings are fatal too (a latch, an undriven wire, a width
 * mismatch it noticed); the message comes back in the error.
 *
 * Time budget: 300 s per trace for the whole run, of which synthesis gets at most 180 s. The baseline takes
 * about 3 s end to end on a laptop. Needs Verilator and Yosys on PATH, or env DMI_VERILATOR_BIN and DMI_YOSYS_BIN.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const TESTBENCH = path.join(here, 'tb.cpp')
export const VERILATOR_MIN = '5.006'
export const YOSYS_MIN = '0.33' // Debian bookworm's package; every command below was checked on 0.68 (measured)

/** The vendored standard cell library. Apache-2.0, from the SkyWater open PDK; see REGISTRY.md for provenance. */
export const LIBERTY = {
  name: 'sky130_fd_sc_hd__tt_025C_1v80',
  file: path.join(here, 'sky130_fd_sc_hd__tt_025C_1v80.lib.gz'),
  sha256: 'ec0e1067a35c8bf20b11e58d1e8ac53326067e4dac84a125cc1b917a3518d0d9', // of the decompressed .lib
  areaUnit: 'um2',
  timeUnit: 'ns',
  // Cells the mapper must not use: low-power flow cells, probes, clock buffers and delay cells. The same list
  // OpenROAD-flow-scripts marks dont_use for this platform, spelled as globs for dfflibmap and abc.
  dontUse: ['sky130_fd_sc_hd__lpflow_*', 'sky130_fd_sc_hd__probe*', 'sky130_fd_sc_hd__clk*', 'sky130_fd_sc_hd__dly*'],
  // abc's timing assumptions: every input is driven by a buf_1, every output sees 5 fF.
  constr: 'set_driving_cell sky130_fd_sc_hd__buf_1\nset_load 5\n',
}

/** The FIFO the testbench models. Not part of the submission. */
export const HARDWARE = {
  depth: 32, width: 32, almostFullAt: 28, almostEmptyAt: 4,
  crc: { bits: 8, polynomial: 0x07, init: 0x00, reflected: false, over: 'every accepted pushed word, most significant byte first' },
  showAhead: true, resetCycles: 2,
}

/** The port list every submission must declare, name for name. Widths are checked by Verilator (WIDTH is fatal). */
export const PORTS = [
  ['input', 'clk', 1], ['input', 'rst_n', 1],
  ['input', 'push', 1], ['input', 'din', 32], ['input', 'pop', 1],
  ['output', 'dout', 32], ['output', 'full', 1], ['output', 'empty', 1], ['output', 'almost_full', 1], ['output', 'almost_empty', 1],
  ['output', 'count', 6], ['output', 'crc', 8],
]
export const MODULE = 'dmi_fifo_crc'
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

/** Finds an executable: the env override, else `name` on PATH. */
function findBinary(name, envKey, bin = process.env[envKey]) {
  if (bin) { if (!fs.existsSync(bin)) throw new Error(`${name} not found at ${bin} (${envKey})`); return bin }
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(d, name)
    // Inside the evaluator worker the permission model denies the stat; the child process itself is not restricted.
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch (e) { if (e?.code === 'ERR_ACCESS_DENIED') return p }
  }
  throw new Error(`${name} not found on PATH; set ${envKey}`)
}
export const resolveBinary = (bin) => findBinary('verilator', 'DMI_VERILATOR_BIN', bin)
export const resolveYosys = (bin) => findBinary('yosys', 'DMI_YOSYS_BIN', bin)
export const haveVerilator = () => { try { resolveBinary(); return true } catch { return false } }
export const haveYosys = () => { try { resolveYosys(); return true } catch { return false } }
export const haveTools = () => haveVerilator() && haveYosys()

const childEnv = () => {
  const env = { PATH: process.env.PATH ?? '' }
  for (const k of ['VERILATOR_ROOT', 'HOME', 'TMPDIR', 'LD_LIBRARY_PATH']) if (process.env[k]) env[k] = process.env[k]
  return env
}

/** The exact Verilator command line. Every flag was checked against Verilator 5.052 on 2026-09-08. */
export const verilatorArgs = (mdir) => [
  '--cc', '--exe', '--build', '-j', '2',
  '--x-initial', '0', '--x-assign', '0', '-O3',
  '--top-module', MODULE, '--Mdir', mdir, '-o', 'sim',
  'tb.cpp', 'design.v',
]

/**
 * The Yosys script, run with `yosys -q -l synth.log -p <script>` in the scratch directory. Every command was
 * checked by running it on Yosys 0.68 on 2026-09-08:
 *   read_verilog -sv            parses the design (SystemVerilog constructs Verilator also accepts)
 *   synth -flatten              the generic flow. `-latches error` would say it in one word, but that option
 *                               only exists from Yosys 0.68 and the scoring image runs 0.52, so parseSynth
 *                               fails on the "Latch inferred" line instead. Yosys 0.52 prints that line at
 *                               plain log level, not as a warning, so the warning rule alone would miss it.
 *   dfflibmap -liberty          maps flops to the library's flops
 *   abc -liberty -constr        maps logic to library cells and, because of -constr, ends with `stime -p`,
 *                               which prints "Delay = <ps>" for the longest combinational path
 *   opt_clean                   drops what the mapping left unused
 *   tee -o stat.json stat -liberty -json   cell counts and area from the liberty file, as JSON
 */
export const yosysScript = (lib) => {
  const du = LIBERTY.dontUse.map((g) => `-dont_use ${g}`).join(' ')
  return [
    'read_verilog -sv design.v',
    `synth -top ${MODULE} -flatten`,
    `dfflibmap -liberty ${lib} ${du}`,
    `abc -liberty ${lib} -constr constr.txt ${du}`,
    'opt_clean',
    `tee -q -o stat.json stat -liberty ${lib} -json`,
  ].join('; ')
}

const spawnTimed = (exe, args, { cwd, timeoutMs, maxBuffer = 64 * 1024 * 1024 }) =>
  spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL', maxBuffer, env: childEnv() })

/** Decompresses the vendored liberty file into `dir` and checks its hash. Returns the path. */
export function writeLiberty(dir) {
  const lib = zlib.gunzipSync(fs.readFileSync(LIBERTY.file))
  const sha = crypto.createHash('sha256').update(lib).digest('hex')
  if (sha !== LIBERTY.sha256) throw new Error(`liberty file ${LIBERTY.name} has sha256 ${sha}, expected ${LIBERTY.sha256}`)
  const p = path.join(dir, `${LIBERTY.name}.lib`)
  fs.writeFileSync(p, lib)
  return p
}

/**
 * Checks the submission in Verilator and, when every output matched the model, synthesizes it in Yosys.
 * `trace` is what loadTrace() returns. Throws when a stage exceeds its budget (compile, simulation and synthesis
 * share stepBudgetMs; synthesis alone is also capped at synthBudgetMs), when Verilator or Yosys rejects the
 * design, when the design disagrees with the model, or when the simulation did not run every cycle of the trace.
 */
export function simulate(trace, policy, { stepBudgetMs = 300000, synthBudgetMs = 180000, bin, yosysBin } = {}) {
  const p = typeof policy === 'string' || typeof policy === 'function' ? loadPolicySource(policy) : policy
  if (!p?.source) throw new Error('policy must come from loadPolicySource()')
  const verilator = resolveBinary(bin)
  const yosys = resolveYosys(yosysBin)
  const dir = fs.mkdtempSync(path.join(process.env.DMI_TMP_DIR ?? os.tmpdir(), 'dmi-synth-'))
  const started = Date.now()
  const remaining = () => stepBudgetMs - (Date.now() - started)
  try {
    fs.writeFileSync(path.join(dir, 'design.v'), p.source)
    fs.copyFileSync(TESTBENCH, path.join(dir, 'tb.cpp'))
    const mdir = path.join(dir, 'obj')

    // Stage 1: functional check.
    const c = spawnTimed(verilator, verilatorArgs(mdir), { cwd: dir, timeoutMs: remaining() })
    const compileMs = Date.now() - started
    if (c.error?.code === 'ETIMEDOUT' || (c.signal && remaining() <= 50)) throw new Error(`compile exceeded time budget (${stepBudgetMs} ms)`)
    if (c.error) throw new Error(`verilator failed to start: ${c.error.message}`)
    if (c.status !== 0) {
      const lines = (c.stderr || c.stdout || '').split('\n').filter((l) => /^%(Error|Warning)/.test(l))
      throw new Error(`verilator rejected the design: ${(lines.length ? lines : [(c.stderr || c.stdout || '').trim().split('\n').slice(-3).join(' | ')]).join(' | ').slice(0, 600)}`)
    }
    const sim = path.join(mdir, 'sim')
    if (!fs.existsSync(sim)) throw new Error('verilator produced no executable')
    const r = spawnTimed(sim, [trace.path], { cwd: dir, timeoutMs: remaining(), maxBuffer: 16 * 1024 * 1024 })
    const simMs = Date.now() - started - compileMs
    if (r.error?.code === 'ETIMEDOUT' || (r.signal && remaining() <= 50)) throw new Error(`simulation exceeded time budget (${stepBudgetMs} ms)`)
    if (r.error) throw new Error(`simulation failed to start: ${r.error.message}`)
    if (r.status !== 0) throw new Error(`simulation exited with ${r.status ?? r.signal}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
    const f = parseFunctional(r.stdout)
    if (f.mismatches > 0) throw new Error(`functional check failed: ${f.firstMismatch}`)
    if (f.cycles !== trace.lines) throw new Error(`simulation ran ${f.cycles} cycles, trace has ${trace.lines}`)

    // Stage 2: synthesis.
    const lib = writeLiberty(dir)
    fs.writeFileSync(path.join(dir, 'constr.txt'), LIBERTY.constr)
    const synthStart = Date.now()
    const y = spawnTimed(yosys, ['-q', '-l', 'synth.log', '-p', yosysScript(path.basename(lib))], { cwd: dir, timeoutMs: Math.min(remaining(), synthBudgetMs) })
    const synthMs = Date.now() - synthStart
    const log = fs.existsSync(path.join(dir, 'synth.log')) ? fs.readFileSync(path.join(dir, 'synth.log'), 'utf8') : ''
    if (y.error?.code === 'ETIMEDOUT' || (y.signal && (remaining() <= 50 || synthMs >= synthBudgetMs - 50))) throw new Error(`synthesis exceeded time budget (${Math.min(stepBudgetMs, synthBudgetMs)} ms)`)
    if (y.error) throw new Error(`yosys failed to start: ${y.error.message}`)
    if (y.status !== 0) {
      const err = log.split('\n').filter((l) => /^ERROR:/.test(l)).concat((y.stderr || '').split('\n').filter((l) => /ERROR/.test(l)))
      throw new Error(`yosys rejected the design: ${(err.length ? err : [(y.stderr || y.stdout || log).trim().split('\n').slice(-3).join(' | ')]).join(' | ').slice(0, 600)}`)
    }
    const s = parseSynth(log, path.join(dir, 'stat.json'))
    const wallMs = Date.now() - started
    const canon = [`outputHash=${f.outputHash}`, `area=${s.areaUm2}`, `delayPs=${s.delayPs}`, ...Object.keys(s.cellsByType).sort().map((k) => `${k}=${s.cellsByType[k]}`)].join('\n')
    return {
      valid: true,
      ppa: s.ppa, areaUm2: s.areaUm2, sequentialAreaUm2: s.sequentialAreaUm2, delayNs: s.delayNs, delayPs: s.delayPs,
      cells: s.cells, flops: s.flops, cellsByType: s.cellsByType, criticalPath: s.criticalPath,
      cycles: f.cycles, pushes: f.pushes, pops: f.pops, maxCount: f.maxCount, mismatches: 0, outputHash: f.outputHash,
      fingerprint: crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16), source_sha256: p.sha256,
      liberty: { name: LIBERTY.name, sha256: LIBERTY.sha256 },
      compileMs, simMs, synthMs, wallMs,
    }
  } finally {
    // A child killed at the budget can still be writing here. Retry, then drop a failed delete:
    // a throw from finally would replace the real reason the run ended.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* the OS temp sweep gets it */ }
  }
}

/** The testbench prints one JSON line. */
export function parseFunctional(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('{'))
  if (!line) throw new Error('simulation produced no result line')
  let s
  try { s = JSON.parse(line) } catch (e) { throw new Error(`simulation result is not JSON: ${e.message}`) }
  for (const k of ['cycles', 'pushes', 'pops', 'maxCount', 'mismatches']) if (!Number.isInteger(s[k]) || s[k] < 0) throw new Error(`stat ${k} missing or not an integer`)
  if (typeof s.outputHash !== 'string') throw new Error('outputHash missing')
  return s
}

/**
 * Reads the Yosys log and stat.json. Any Yosys warning is fatal (abc's own "ABC: Warning" lines are chatter about
 * its internal network and are not), and so is an inferred latch, which Yosys 0.52 reports at plain log level.
 * Area comes from stat, delay from abc's stime line. ppa = area * delay in ns.
 */
export function parseSynth(log, statFile) {
  const warnings = log.split('\n').filter((l) => /^Warning:/.test(l))
  if (warnings.length) throw new Error(`yosys warning is fatal: ${[...new Set(warnings)].slice(0, 3).join(' | ').slice(0, 500)}`)
  const latches = log.split('\n').filter((l) => /^Latch inferred/.test(l))
  if (latches.length) throw new Error(`inferred latch: ${[...new Set(latches)].slice(0, 3).join(' | ').slice(0, 500)}. Every state element must be a flop.`)
  const delayLine = log.split('\n').find((l) => /^ABC: WireLoad = .*Delay =/.test(l))
  if (!delayLine) throw new Error('synthesis produced no delay report (abc stime line missing)')
  const delayPs = Number(delayLine.match(/Delay =\s*([0-9.]+) ps/)?.[1])
  if (!Number.isFinite(delayPs) || delayPs <= 0) throw new Error(`cannot parse delay from "${delayLine.trim().slice(0, 120)}"`)
  const pathLines = []
  const lines = log.split('\n')
  const at = lines.indexOf(delayLine)
  for (let i = at + 1; i < lines.length && /^ABC: (Path|Start-point)/.test(lines[i]); i++) pathLines.push(lines[i].replace(/^ABC: /, '').replace(/\s+/g, ' ').trim())
  if (!fs.existsSync(statFile)) throw new Error('synthesis produced no stat.json')
  let stat
  try { stat = JSON.parse(fs.readFileSync(statFile, 'utf8')) } catch (e) { throw new Error(`stat.json is not JSON: ${e.message}`) }
  const mod = stat.modules?.[`\\${MODULE}`] ?? Object.values(stat.modules ?? {})[0]
  if (!mod || typeof mod.area !== 'number') throw new Error('stat.json has no area for the top module')
  if (mod.num_memories > 0 || mod.num_processes > 0 || mod.num_submodules > 0) throw new Error('synthesis left unmapped memories, processes or submodules')
  const cellsByType = {}
  let flops = 0
  for (const [k, v] of Object.entries(mod.num_cells_by_type ?? {})) {
    if (k.startsWith('$')) throw new Error(`synthesis left an unmapped internal cell ${k}`)
    cellsByType[k] = v
    if (/__(e?dfxtp|dfrtp|dfstp|dfbbn|dfbbp|dfxbp|dfrbp|dfrtn|dfsbp|sdf|sedf|dlxtp|dlxtn|dlrtp|dlrbp|dlxbp|dlrbn|dlrtn|edfxbp)_/.test(k)) flops += v
  }
  const areaUm2 = +mod.area.toFixed(4)
  const delayNs = +(delayPs / 1000).toFixed(5)
  return {
    areaUm2, sequentialAreaUm2: +(mod.sequential_area ?? 0).toFixed(4), delayPs, delayNs,
    ppa: +(areaUm2 * delayNs).toFixed(3),
    cells: mod.num_cells, flops, cellsByType, criticalPath: pathLines,
  }
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
  if (!policyFile) { console.error('usage: node harness.js <design.v> [trace.trace]'); process.exit(2) }
  const result = simulate(loadTrace(traceFile), loadPolicySource(fs.readFileSync(policyFile, 'utf8')))
  console.log(JSON.stringify(result, null, 2))
}
