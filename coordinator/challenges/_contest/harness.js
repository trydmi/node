/**
 * Generic contest harness: a contest's scorer as a DMI challenge (docs/internal/CONTEST_MIRROR.md).
 *
 * A contest ships a runner (a C++ driver or a run.py), a reference kernel, and input shapes. This module turns
 * that into the { loadPolicySource, simulate, loadTrace } trio every DMI harness exports, so the evaluator worker,
 * the evaluator service and compute nodes run it exactly like any other challenge.
 *
 * Runner protocol. The runner is invoked as
 *   <runner> [--kernel FILE] --<key> <value>... --repeats R --out DIR
 * with one --key value pair per field of the inputs file (a small JSON document such as { seed, n, cases }).
 * It writes DIR/outputs.bin (float32, little endian, every output in a fixed order) and DIR/result.json
 * ({ timesMs: [..], elements: M }). For a C++ runner the harness compiles driver + kernel into one executable.
 * For a Python runner it runs `python3 run.py --kernel <file> ...`.
 *
 * Scoring, in this order:
 *   1. static rules on the source (size, entry point, banned tokens, include allowlist)
 *   2. compile (C++ only)
 *   3. the reference kernel runs once through the same runner and dumps the reference outputs
 *   4. the submission runs once; outputs are compared element by element with atol/rtol; a miss is rejected here,
 *      before any timing counts
 *   5. the submission runs `repeats` times; the median wall time is the objective; the outputs of that pass are
 *      compared again so a kernel cannot behave differently once it is being timed
 *
 * Objective: medianMs, lower is better. Timing is not bit-deterministic, so agreement between two runs is a
 * tolerance band (challenge.tolerancePct) on the same hardware class, handled in coordinator/compute.js.
 *
 * The static rules are a courtesy, not a boundary. The container the evaluator runs in is the boundary.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const DEFAULT_TOLERANCE_PCT = 3
export const DEFAULT_REPEATS = 5
export const MAX_SOURCE_BYTES = 64 * 1024

/** A hardware class string: vendor and model, lower case, dashes. "NVIDIA H100 80GB HBM3" -> "nvidia-h100-80gb-hbm3". */
export function normalizeHardware(s) {
  const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return t || null
}

const CPP_BANNED = ['asm', '__asm__', '__asm', 'system', 'popen', 'fopen', 'freopen', 'open', 'exec', 'execve', 'execl', 'fork', 'vfork', 'dlopen', 'dlsym', 'socket', 'connect', 'mmap', 'mprotect', 'ptrace', 'syscall', 'thread', 'pthread_create', 'fork', 'omp', 'signal', 'raise', 'abort', 'exit', '_exit', 'atexit', 'getenv', 'setenv', 'main', '__attribute__', 'constructor', 'destructor', 'dmi_contest_result']
const DEFAULT_DIRECTIVES = ['include', 'define', 'undef', 'if', 'ifdef', 'ifndef', 'elif', 'else', 'endif']
const CPP_INCLUDES = new Set(['cstddef', 'cstdint', 'cmath', 'cstring', 'algorithm', 'immintrin.h', 'arm_neon.h', 'x86intrin.h', 'stdint.h', 'stddef.h', 'math.h', 'string.h'])
const PY_BANNED = ['subprocess', 'os.system', 'os.popen', 'socket', 'ctypes', 'importlib', '__import__', 'eval(', 'exec(', 'compile(', 'open(', 'shutil', 'pathlib', 'requests', 'urllib', 'multiprocessing', 'threading', 'signal', 'sys.exit', 'os.environ']

/** Comments removed; then comments and string literals removed, so the rules see only code. */
export const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
export function stripCpp(src) {
  return stripComments(src).replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
}
const word = (w) => new RegExp(`(^|[^A-Za-z0-9_])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`)

/** The fingerprint of a timing artifact is the artifact itself (whitespace and comments normalized), not its outputs: every correct kernel produces the same outputs. */
export function sourceFingerprint(source, language) {
  const norm = (language === 'python' ? source.replace(/#[^\n]*/g, '') : stripCpp(source)).replace(/\s+/g, ' ').trim()
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16)
}

/** Deterministic input files: a small JSON document the runner turns into data. Written when missing or when the seed changed. */
export function ensureContestInputs({ publicPath, hiddenPath, publicSeed = 1, hiddenSeed = 13, shape = {} }) {
  const write = (p, seed) => {
    let cur = null
    try { cur = JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
    const want = { seed, ...shape }
    if (cur && JSON.stringify(cur) === JSON.stringify(want)) return
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(want) + '\n')
  }
  if (!fs.existsSync(publicPath)) write(publicPath, publicSeed)
  write(hiddenPath, hiddenSeed)
}

/**
 * spec:
 *   id, language: 'cpp' | 'python'
 *   entry: RegExp the source must match (the kernel signature)
 *   runner: for cpp { driver, reference, cxxflags?, compiler?, sourceExt? }; for python { script, reference, python? }
 *     compiler: { bin, env?, what? } pins the compiler, e.g. { bin: 'nvcc', env: 'DMI_NVCC_BIN' }. Without it the host
 *     C++ compiler is used (DMI_CXX_BIN, CXX, then c++). sourceExt: the kernel file's extension, default cpp.
 *   repeats, tolerance: { atol, rtol, matchRatio }, hardwareClass, maxSourceBytes?, allowedIncludes?, bannedTokens?,
 *   allowedDirectives?
 */
export function createContestHarness(spec) {
  const language = spec.language ?? 'cpp'
  const repeats = spec.repeats ?? DEFAULT_REPEATS
  const tol = { atol: 1e-3, rtol: 1e-3, matchRatio: 1, ...(spec.tolerance ?? {}) }
  const maxBytes = spec.maxSourceBytes ?? MAX_SOURCE_BYTES
  const includes = new Set(spec.allowedIncludes ?? CPP_INCLUDES)
  const banned = spec.bannedTokens ?? (language === 'python' ? PY_BANNED : CPP_BANNED)
  // Preprocessor directives a kernel may use. A CUDA challenge adds pragma, because #pragma unroll is one of the
  // optimisations being measured; #pragma omp is still refused, by the omp token in the banned list.
  const directives = spec.allowedDirectives ?? DEFAULT_DIRECTIVES

  function loadPolicySource(source) {
    if (typeof source === 'function') source = source()
    if (typeof source !== 'string') throw new Error('submission must be kernel source text')
    if (Buffer.byteLength(source, 'utf8') > maxBytes) throw new Error(`source must be under ${maxBytes / 1024} KB`)
    if (/\0/.test(source)) throw new Error('source contains a NUL byte')
    if (language === 'cpp') {
      const code = stripCpp(source)
      for (const m of code.matchAll(/#\s*include\s*[<"]([^>"]+)[>"]/g)) if (!includes.has(m[1])) throw new Error(`#include <${m[1]}> is not allowed; allowed: ${[...includes].join(', ')}`)
      for (const m of code.matchAll(/#\s*([A-Za-z_]+)/g)) if (!directives.includes(m[1])) throw new Error(`#${m[1]} is not allowed`)
      for (const w of banned) if (word(w).test(code)) throw new Error(`token ${w} is not allowed in a kernel`)
      if (!spec.entry.test(stripComments(source))) throw new Error(`source must define the entry point ${spec.entryText ?? String(spec.entry)}`)
    } else {
      for (const w of banned) if (source.includes(w)) throw new Error(`token ${w} is not allowed in a kernel`)
      if (!spec.entry.test(source)) throw new Error(`source must define the entry point ${spec.entryText ?? String(spec.entry)}`)
    }
    return { source, sha256: crypto.createHash('sha256').update(source).digest('hex'), fingerprint: sourceFingerprint(source, language) }
  }

  /** The inputs file is a small JSON document. Returns { path, ...fields }. */
  function loadTrace(file) {
    const abs = path.resolve(file)
    if (!fs.existsSync(abs)) throw new Error(`inputs not found: ${abs}`)
    let doc
    try { doc = JSON.parse(fs.readFileSync(abs, 'utf8')) } catch (e) { throw new Error(`inputs file is not JSON: ${e.message}`) }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('inputs file must be a JSON object')
    for (const [k, v] of Object.entries(doc)) if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k) || !(typeof v === 'number' || typeof v === 'string')) throw new Error(`inputs field ${k} must be a number or string`)
    return { path: abs, ...doc }
  }

  const inputArgs = (trace) => Object.entries(trace).filter(([k]) => k !== 'path').flatMap(([k, v]) => [`--${k}`, String(v)])
  const childEnv = () => { const env = { PATH: process.env.PATH ?? '' }; for (const k of ['HOME', 'TMPDIR', 'LD_LIBRARY_PATH', 'CUDA_HOME', 'CUDA_PATH', 'CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES', 'PYTHONPATH']) if (process.env[k]) env[k] = process.env[k]; return env }

  function run(cmd, args, cwd, timeoutMs, what) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: childEnv() })
    if (r.error?.code === 'ETIMEDOUT') throw new Error(`${what} exceeded the time budget`)
    if (r.error) throw new Error(`${what} failed to start: ${r.error.message}`)
    if (r.status !== 0) throw new Error(`${what} exited with ${r.status ?? r.signal}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' | ').slice(0, 600)}`)
    return r
  }

  /** An executable on PATH, or null. ERR_ACCESS_DENIED means the worker's permission model hid the stat, not that the file is missing. */
  const onPath = (name) => {
    for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
      const p = path.join(d, name)
      try { fs.accessSync(p, fs.constants.X_OK); return p } catch (e) { if (e?.code === 'ERR_ACCESS_DENIED') return p }
    }
    return null
  }
  /**
   * The compiler for a compiled challenge. Without spec.runner.compiler this is the host C++ compiler, as before.
   * A challenge that pins its own compiler (nvcc, say) never falls back to c++: the score depends on that toolchain,
   * so a missing one has to fail with a message that names the binary and the env override, not with a compile error
   * about unknown syntax.
   */
  const cxx = () => {
    const c = spec.runner.compiler
    if (!c) return process.env.DMI_CXX_BIN || process.env.CXX || 'c++'
    const want = (c.env && process.env[c.env]) || c.bin
    const found = want.includes(path.sep) ? (fs.existsSync(want) ? want : null) : onPath(want)
    if (!found) throw new Error(`${spec.id} is compiled with ${c.bin}${c.what ? ` (${c.what})` : ''} and it was not found${want !== c.bin ? ` at ${want}` : ' on PATH'}${c.env ? `; set ${c.env} to its full path` : ''}`)
    return found
  }
  function compile(kernelFile, exe, cwd, timeoutMs) {
    const flags = spec.runner.cxxflags ?? ['-O2', '-std=c++17']
    run(cxx(), [...flags, '-o', exe, spec.runner.driver, kernelFile], cwd, timeoutMs, 'compile')
  }

  /** One pass through the runner. Returns { timesMs, outputs: Float32Array, elements }. */
  function invoke(kernelFile, exe, trace, n, outDir, cwd, timeoutMs, what) {
    fs.mkdirSync(outDir, { recursive: true })
    const args = [...(language === 'python' ? ['--kernel', kernelFile] : []), ...inputArgs(trace), '--repeats', String(n), '--out', outDir]
    if (language === 'python') run(spec.runner.python ?? process.env.DMI_PYTHON_BIN ?? 'python3', [spec.runner.script, ...args], cwd, timeoutMs, what)
    else run(exe, args, cwd, timeoutMs, what)
    let res
    try { res = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8')) } catch (e) { throw new Error(`${what}: runner wrote no result.json (${e.message})`) }
    if (!Array.isArray(res.timesMs) || res.timesMs.length !== n || !res.timesMs.every((t) => Number.isFinite(t) && t >= 0)) throw new Error(`${what}: runner reported ${res.timesMs?.length ?? 0} times, expected ${n}`)
    const buf = fs.readFileSync(path.join(outDir, 'outputs.bin'))
    if (buf.length % 4) throw new Error(`${what}: outputs.bin is not float32`)
    const outputs = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
    return { timesMs: res.timesMs, outputs, elements: outputs.length }
  }

  /** Element-wise |a - b| <= atol + rtol * |b|. Returns { matchRatio, maxAbsErr, finite }. */
  function compare(got, ref) {
    if (got.length !== ref.length) return { matchRatio: 0, maxAbsErr: Infinity, finite: false, reason: `${got.length} outputs, reference has ${ref.length}` }
    let ok = 0, maxAbs = 0, finite = true
    for (let i = 0; i < ref.length; i++) {
      const a = got[i], b = ref[i]
      if (!Number.isFinite(a)) { finite = false; continue }
      const d = Math.abs(a - b)
      if (d > maxAbs) maxAbs = d
      if (d <= tol.atol + tol.rtol * Math.abs(b)) ok++
    }
    return { matchRatio: ref.length ? ok / ref.length : 1, maxAbsErr: maxAbs, finite }
  }
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
  const hash = (f32) => crypto.createHash('sha256').update(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)).digest('hex').slice(0, 16)

  function simulate(trace, policy, { stepBudgetMs = 60000 } = {}) {
    const p = typeof policy === 'string' || typeof policy === 'function' ? loadPolicySource(policy) : policy
    if (!p?.source) throw new Error('policy must come from loadPolicySource()')
    const dir = fs.mkdtempSync(path.join(process.env.DMI_TMP_DIR ?? os.tmpdir(), `dmi-contest-${spec.id}-`))
    const started = Date.now()
    const remaining = () => stepBudgetMs - (Date.now() - started)
    try {
      // A CUDA challenge needs the kernel written as kernel.cu, because nvcc reads the extension to decide it is device code.
      const ext = spec.runner.sourceExt ?? (language === 'python' ? 'py' : 'cpp')
      const kernelFile = path.join(dir, `kernel.${ext}`)
      fs.writeFileSync(kernelFile, p.source)
      const subExe = path.join(dir, 'sub'), refExe = path.join(dir, 'ref')
      if (language === 'cpp') { compile(kernelFile, subExe, dir, remaining()); compile(spec.runner.reference, refExe, dir, remaining()) }
      const compileMs = Date.now() - started
      // Reference outputs come from a separate process running the contest's reference kernel on the same inputs.
      const ref = invoke(spec.runner.reference, refExe, trace, 1, path.join(dir, 'ref-out'), dir, remaining(), 'reference run')
      // Correctness gate. Nothing below runs unless the outputs match the reference.
      const check = invoke(kernelFile, subExe, trace, 1, path.join(dir, 'check-out'), dir, remaining(), 'correctness run')
      const c1 = compare(check.outputs, ref.outputs)
      if (c1.reason || !c1.finite || c1.matchRatio < tol.matchRatio) throw new Error(`rejected before timing: outputs differ from the reference (${c1.reason ?? `${(c1.matchRatio * 100).toFixed(2)}% of elements within atol ${tol.atol} rtol ${tol.rtol}, max abs error ${c1.finite ? c1.maxAbsErr.toExponential(2) : 'non-finite'}`})`)
      // Timing. The outputs of the timed pass are checked too.
      const timed = invoke(kernelFile, subExe, trace, repeats, path.join(dir, 'time-out'), dir, remaining(), 'timing run')
      const c2 = compare(timed.outputs, ref.outputs)
      if (c2.reason || !c2.finite || c2.matchRatio < tol.matchRatio) throw new Error(`timed pass produced different outputs from the correctness pass (${(c2.matchRatio * 100).toFixed(2)}% within tolerance); a kernel must do the same work when timed`)
      const wallMs = Date.now() - started
      return {
        valid: true,
        medianMs: median(timed.timesMs), minMs: Math.min(...timed.timesMs), maxMs: Math.max(...timed.timesMs), repeats,
        referenceMs: ref.timesMs[0], elements: ref.elements, matchRatio: c1.matchRatio, maxAbsErr: c1.maxAbsErr, outputHash: hash(timed.outputs),
        hardwareClass: spec.hardwareClass ?? null, fingerprint: p.fingerprint, source_sha256: p.sha256, compileMs, wallMs,
      }
    } finally {
      // A child killed at the budget can still be writing here. Retry, then drop a failed delete:
      // a throw from finally would replace the real reason the run ended.
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* the OS temp sweep gets it */ }
    }
  }

  return { loadPolicySource, simulate, loadTrace, SPEC: spec, repeats, tolerance: tol }
}
