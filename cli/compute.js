// `dmi compute`: run a compute node. The node is the evaluator service in client mode. It registers with the
// coordinator, pulls one scoring job at a time, runs the artifact in the same locked-down worker the evaluator
// uses (coordinator/run-job.js), and posts the result back. Accepted jobs pay compute credit to the node's key.
//
// The node holds one secret: its own DMI key. It never sees the admin key, the evaluator token, or the database.
// Traces are cached under the node directory (DMI_NODE_DIR, default ~/.dmi/node) and re-fetched when their hash changes.
//
// Capabilities. At start, and again after every ten minutes, the node probes the tools on this machine by running
// them (`verilator --version`, `yosys -V`, `nvcc --version`, the Ramulator binary with no arguments, the C++ compiler with --version) and reports
// the challenge ids it can run in the register call and in every lease call. The coordinator never hands it a job
// for a challenge outside that list, so a Mac without Verilator never answers an L3 job with an error and a strike.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { coordinatorUrl, isValidKey, KEY_ENV } from './install.js'
import { runJob } from '../coordinator/run-job.js'
import { CHALLENGES } from '../coordinator/challenge.js'
import { normalizeHardware } from '../coordinator/challenges/_contest/harness.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const NODE_DIR_ENV = 'DMI_NODE_DIR'
export const nodeDir = (override) => override || process.env[NODE_DIR_ENV] || path.join(homedir(), '.dmi', 'node')

export const CAPABILITY_REFRESH_MS = 10 * 60 * 1000

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

/**
 * Run one tool and read its answer. `want` is what a working tool prints; without it, exit 0 is the answer.
 * `pick` names the line to keep as the detail, for a tool that does not print its version first. nvcc is one:
 * `nvcc --version` opens with "nvcc: NVIDIA (R) Cuda compiler driver" and puts the release on the fourth line,
 * so without `pick` the detail carries no version and a pinned toolkit could never match.
 */
function probe(cmd, args, want, pick) {
  let r
  try { r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20 }) } catch (e) { return { ok: false, detail: `${cmd}: ${e.message}` } }
  if (r.error) return { ok: false, detail: `${cmd}: ${r.error.code === 'ENOENT' ? 'not found' : r.error.message}` }
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim()
  const lines = out.split('\n')
  const first = lines.find((l) => l.trim()) ?? ''
  const detail = (pick ? lines.find((l) => pick.test(l)) : null) ?? first
  const ok = want ? want.test(out) : r.status === 0
  return { ok, detail: ok ? detail.trim().slice(0, 120) : `${cmd} exited ${r.status ?? r.signal}: ${first.slice(0, 120)}` }
}

/** The tools an L2 or L3 challenge needs, each checked by running it. Keys match the `tools` field of the challenge registry. */
export function probeTools() {
  const tools = {}
  // dram-controller: Ramulator 2.0. Only DMI_RAMULATOR_BIN counts. Run with no arguments it prints its usage
  // (it requires -f) and exits non-zero, which is enough to show the binary starts on this machine.
  const ram = process.env.DMI_RAMULATOR_BIN
  if (!ram) tools.ramulator = { ok: false, detail: 'DMI_RAMULATOR_BIN is not set' }
  else {
    try { fs.accessSync(ram, fs.constants.X_OK) } catch { tools.ramulator = { ok: false, detail: `${ram} is not an executable file` } }
    tools.ramulator ??= probe(ram, [], /ramulator|usage|config/i)
  }
  // rtl-cache-controller: Verilator, plus the C++ compiler its --build step runs.
  tools.verilator = probe(process.env.DMI_VERILATOR_BIN || 'verilator', ['--version'], /^Verilator \d/m)
  const compilers = [process.env.CXX, 'g++', 'c++', 'clang++'].filter(Boolean)
  const tried = compilers.map((cxx) => probe(cxx, ['--version']))
  tools.cxx = tried.find((t) => t.ok) ?? { ok: false, detail: `no C++ compiler on PATH (tried ${compilers.join(', ')})` }
  // rtl-synth-fifo: Yosys on top of Verilator and the compiler. `yosys -V` prints "Yosys <version>".
  tools.yosys = probe(process.env.DMI_YOSYS_BIN || 'yosys', ['-V'], /^Yosys \d/m)
  // gemm-cuda: the CUDA compiler, on top of the host compiler nvcc drives. The release line is what the registry
  // pins (toolVersions.nvcc), so the probe keeps that line as its detail and not the banner.
  //
  // The line this expects is "Cuda compilation tools, release 12.6, V12.6.20". That format has NOT been read off a
  // run of nvcc on this machine, because there is no CUDA toolkit here; it is the documented output, and
  // test/gpu.test.mjs checks the parser against it with a stub. A real GPU node is what confirms it.
  tools.nvcc = probe(process.env.DMI_NVCC_BIN || 'nvcc', ['--version'], /release\s+\d+\.\d+/i, /release\s+\d+\.\d+/i)
  return tools
}

/** The version a tool printed, as major.minor, or null when its line did not carry one. */
export const toolVersion = (detail) => (String(detail ?? '').match(/\b(\d+\.\d+)/)?.[1] ?? null)

/**
 * Does this machine's toolchain match what the challenge pins? A challenge whose objective is a tool's own
 * measurement (area and delay out of abc, say) declares `toolVersions`, and a node runs it only on that exact
 * version, so two honest nodes never disagree because their toolchains differ. Challenges without the field
 * take any version that answered.
 */
const versionsMatch = (c, tools) =>
  Object.entries(c.toolVersions ?? {}).every(([t, want]) => toolVersion(tools[t]?.detail) === want)

/**
 * The hardware class this machine reports for timing challenges (docs/internal/CONTEST_MIRROR.md). DMI_HARDWARE wins; else the
 * first GPU nvidia-smi or rocm-smi names; else cpu-generic. Normalized to lower case and dashes, e.g. nvidia-h100-80gb-hbm3.
 */
export function probeHardware() {
  if (process.env.DMI_HARDWARE) return normalizeHardware(process.env.DMI_HARDWARE)
  const nv = probe('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], /\S/)
  if (nv.ok) return normalizeHardware(nv.detail)
  const amd = probe('rocm-smi', ['--showproductname'], /Card series:\s*\S/i)
  if (amd.ok) { let r; try { r = spawnSync('rocm-smi', ['--showproductname'], { encoding: 'utf8', timeout: 15000 }) } catch {} const m = (r?.stdout ?? '').match(/Card series:\s*(.+)/i); if (m) return normalizeHardware(`amd ${m[1]}`) }
  return 'cpu-generic'
}

/**
 * Challenge ids this machine can score: every registry entry whose `tools` all answered at the pinned version
 * and, for a timing challenge, whose hardware class is this machine's. L1 challenges list no tools.
 */
export function detectCapabilities(tools = probeTools(), hardware = probeHardware()) {
  const capabilities = Object.values(CHALLENGES)
    .filter((c) => (c.tools ?? []).every((t) => tools[t]?.ok) && versionsMatch(c, tools) && (!c.hardwareClass || c.hardwareClass === hardware))
    .map((c) => c.id).sort()
  return { capabilities, tools, hardware }
}
const describeTools = (tools) => Object.entries(tools).map(([k, t]) => `${k}: ${t.ok ? 'ok, ' : ''}${t.detail}`).join('; ')

const sleep = (ms, signal) => new Promise((resolve) => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true }) })

async function call(base, key, method, route, body, { signal, timeoutMs = 40000 } = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(new Error('request timed out')), timeoutMs)
  const onAbort = () => ac.abort(signal.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: body == null ? undefined : JSON.stringify(body), signal: ac.signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { json = { error: text.slice(0, 200) } }
    return { status: res.status, ok: res.ok, body: json }
  } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort) }
}

/**
 * Register this machine as a node. A saved key under dir/node.json is reused; an explicit key (a participant key)
 * attaches the node to that account; with neither, the coordinator mints a key and it is saved for next time.
 */
export async function registerNode({ url, key, handle, dir, capabilities = [], hardware = null } = {}) {
  const base = coordinatorUrl(url)
  const d = nodeDir(dir)
  const file = path.join(d, 'node.json')
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  const useKey = key || process.env[KEY_ENV] || saved?.key || ''
  if (useKey && !isValidKey(useKey)) throw new Error('key does not look like a DMI key (expected dmi_ followed by 24+ letters or digits)')
  const r = await call(base, null, 'POST', '/v1/compute/register', { ...(useKey ? { key: useKey } : { handle: handle ?? '' }), capabilities, hardware })
  if (!r.ok) throw new Error(`register failed: ${r.status} ${r.body?.error ?? ''}`)
  const reg = r.body
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ key: reg.key, nodeId: reg.nodeId, handle: reg.handle, coordinator: base, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  return { ...reg, base, dir: d, minted: !useKey }
}

/** Bring one trace (and its sidecar files) to local disk. Uses the bundled public trace when its hash matches; otherwise downloads and caches. */
async function ensureTrace(job, { base, key, dir, signal, log }) {
  const files = job.traces?.[job.trace]
  if (!files?.length) throw new Error(`coordinator offered no ${job.trace} trace for ${job.challenge}`)
  const local = path.join(dir, 'traces', job.challenge, job.trace)
  fs.mkdirSync(local, { recursive: true })
  for (const f of files) {
    const dest = path.join(local, f.name)
    const stamp = `${dest}.sha256`
    let have = null
    try { have = fs.readFileSync(stamp, 'utf8').trim() } catch {}
    if (have === f.sha256 && fs.existsSync(dest)) continue
    if (job.trace === 'public') {
      const bundled = path.join(root, 'coordinator', 'challenges', job.challenge, f.name)
      if (fs.existsSync(bundled) && sha256File(bundled) === f.sha256) { fs.copyFileSync(bundled, dest); fs.writeFileSync(stamp, f.sha256); continue }
    }
    log(`fetching ${job.trace} trace ${f.name} for ${job.challenge} (${Math.round(f.bytes / 1e6)} MB)`)
    const res = await fetch(f.url, { headers: { 'x-api-key': key }, signal })
    if (!res.ok) throw new Error(`trace download failed: ${res.status}`)
    const tmp = `${dest}.${process.pid}.tmp`
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
    if (sha256File(tmp) !== f.sha256) { fs.rmSync(tmp, { force: true }); throw new Error(`trace ${f.name} did not match its hash`) }
    fs.renameSync(tmp, dest)
    fs.writeFileSync(stamp, f.sha256)
  }
  return path.join(local, files[0].name)
}

/**
 * A node. `start()` loops until `stop()`; `runOnce()` handles one job and returns it (tests drive nodes this way).
 * opts: { url, key, handle, dir, log, transform, capabilities, hardware }. transform(result, job) lets a test hand back a wrong
 * answer. capabilities (a list of challenge ids) replaces the tool probes, so a test can stand up a node that reports only L1.
 * hardware replaces the hardware probe (a test can stand up a node that reports a GPU it does not have).
 */
export function createNode(opts = {}) {
  const log = opts.log ?? ((m) => console.error(`[dmi compute] ${m}`))
  const state = { nodeId: null, handle: null, key: null, base: null, dir: null, jobsDone: 0, accepted: 0, lastJob: null, disabled: false, capabilities: [], tools: {}, hardware: null, capabilitiesAt: 0 }
  let ac = null
  let registering = null

  // Probe the tools and refresh what the node reports. Called at start and again after CAPABILITY_REFRESH_MS.
  function detect() {
    const hardware = opts.hardware ? normalizeHardware(opts.hardware) : probeHardware()
    const d = opts.capabilities ? { capabilities: [...opts.capabilities].sort(), tools: {}, hardware } : detectCapabilities(probeTools(), hardware)
    const changed = d.capabilities.join(',') !== state.capabilities.join(',') || d.hardware !== state.hardware
    Object.assign(state, { capabilities: d.capabilities, tools: d.tools, hardware: d.hardware, capabilitiesAt: Date.now() })
    if (changed) log(`can run: ${d.capabilities.join(', ') || 'nothing'} on ${d.hardware}${Object.keys(d.tools).length ? ` (${describeTools(d.tools)})` : ''}`)
    return d
  }

  // One registration per node object, even when start() and a caller race to it.
  function register() {
    if (registering) return registering
    const d = detect()
    registering = registerNode({ url: opts.url, key: opts.key, handle: opts.handle, dir: opts.dir, capabilities: d.capabilities, hardware: d.hardware }).then((r) => {
      Object.assign(state, { nodeId: r.nodeId, handle: r.handle, key: r.key, base: r.base, dir: r.dir })
      log(`node ${r.nodeId} (${r.handle}) on ${r.base}${r.minted ? ', new key saved to ' + path.join(r.dir, 'node.json') : ''}`)
      return r
    })
    return registering
  }

  async function runOnce({ waitMs, signal } = {}) {
    await register()
    const { key, base, dir } = state
    if (Date.now() - state.capabilitiesAt >= CAPABILITY_REFRESH_MS) detect()
    const lease = await call(base, key, 'POST', '/v1/compute/jobs/lease', { capabilities: state.capabilities, hardware: state.hardware, ...(waitMs == null ? {} : { waitMs }) }, { signal })
    if (lease.status === 403) { state.disabled = true; throw new Error(lease.body?.error ?? 'node disabled') }
    if (lease.status === 429) { await sleep(5000, signal); return null }
    if (!lease.ok) throw new Error(`lease failed: ${lease.status} ${lease.body?.error ?? ''}`)
    const job = lease.body.job
    if (!job) return null
    const t0 = Date.now()
    const tracePath = await ensureTrace(job, { base, key, dir, signal, log })
    let result
    // A full local queue is not a verdict on the artifact: wait and run again rather than answer with an error.
    for (let attempt = 0; ; attempt++) {
      // A sponsored instance runs under its base challenge's harness; the coordinator names it in job.base.
      result = await runJob({ challenge: job.base ?? job.challenge, trace: job.trace, source: job.source, stepBudgetMs: job.stepBudgetMs }, { tracePath })
      if (!result.busy || attempt >= 5 || signal?.aborted) break
      await sleep(2000, signal)
    }
    if (result.busy) throw new Error(result.error)
    if (opts.transform) result = opts.transform(result, job)
    const posted = await call(base, key, 'POST', `/v1/compute/jobs/${job.id}/result`, result, { signal })
    state.jobsDone++
    if (posted.ok) state.accepted++
    state.lastJob = { id: job.id, challenge: job.challenge, step: job.step, ok: result.ok, ms: Date.now() - t0, posted: posted.status }
    log(`${job.challenge} ${job.step} ${result.ok ? 'ok ' + Math.round(result.result[job.objective]) : 'invalid: ' + result.error} in ${Date.now() - t0} ms (${posted.status})`)
    return state.lastJob
  }

  async function start() {
    ac = new AbortController()
    await register()
    while (!ac.signal.aborted) {
      try { await runOnce({ signal: ac.signal }) } catch (e) {
        if (ac.signal.aborted) break
        if (state.disabled) { log(e.message); break }
        log(`error: ${e.message}; retrying in 3 s`)
        await sleep(3000, ac.signal)
      }
    }
  }

  const stop = () => { ac?.abort(new Error('stopped')) }
  return { state, register, runOnce, start, stop }
}

/** The `dmi compute` subcommand. Runs until Ctrl-C. */
export async function runComputeCommand({ url, key, handle, dir, once } = {}) {
  const node = createNode({ url, key, handle, dir })
  process.on('SIGINT', () => { console.error('\nstopping'); node.stop() })
  process.on('SIGTERM', () => node.stop())
  if (once) { await node.register(); return node.runOnce() }
  await node.start()
  return node.state
}
