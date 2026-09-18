// `dmi work`: background work mode. A participant runs it once and the coding agent they already pay for
// (Claude Code, Cursor, Codex) works one DMI task whenever it is idle, on their own subscription.
//
// The loop mirrors scripts/run-agents.sh: register a key once (the coordinator generates the handle), write an
// MCP config that points the agent at the coordinator with that key, then every `--every` minutes start one
// headless session with a fixed prompt, take the last line it prints as the verdict, and log one line per run
// to ~/.dmi/work.log. It never reads, stores or prints the agent vendor's credentials; the agent CLI holds
// those itself. The only secret this file touches is the DMI key, saved under ~/.dmi/work.json with mode 0600.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { coordinatorUrl, isValidKey, KEY_ENV, mcpUrl } from './install.js'
import { toolMove } from '../node/moves.js'
import { openLease, closeLease } from '../node/lease-file.js'

export const WORK_DIR_ENV = 'DMI_WORK_DIR'
export const workDir = (override) => override || process.env[WORK_DIR_ENV] || path.join(os.homedir(), '.dmi')

const MCP_TOOLS = ['mcp__dmi__next_task', 'mcp__dmi__submit', 'mcp__dmi__status']
const DAY_MS = 86400e3

/** The agent CLIs work mode knows how to drive, in the order they are tried. Each is grounded by running it. */
export const AGENTS = ['claude', 'cursor-agent', 'codex']

function versionOf(bin) {
  let r
  try { r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20 }) } catch (e) { return { ok: false, detail: e.message } }
  if (r.error) return { ok: false, detail: r.error.code === 'ENOENT' ? 'not found' : r.error.message }
  const first = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').find((l) => l.trim()) ?? ''
  return { ok: r.status === 0, detail: r.status === 0 ? first.trim().slice(0, 80) : `exited ${r.status ?? r.signal}` }
}

/** Which agent CLIs are installed, each checked by running `<bin> --version`. */
export function detectAgents() {
  return AGENTS.map((name) => ({ name, ...versionOf(name) }))
}

export function pickAgent(wanted) {
  const found = detectAgents()
  if (wanted) {
    if (!AGENTS.includes(wanted)) throw new Error(`unknown agent ${wanted}; choose one of ${AGENTS.join(', ')}`)
    const a = found.find((f) => f.name === wanted)
    if (!a.ok) throw new Error(`${wanted} is not installed or does not answer --version (${a.detail})`)
    return a
  }
  const a = found.find((f) => f.ok)
  if (!a) throw new Error(`no agent CLI found. Install one of ${AGENTS.join(', ')} and make sure it is on PATH`)
  return a
}

/** The prompt an agent gets. With no challenge the coordinator picks one and the prompt covers every artifact type. */
export function buildPrompt({ challenge, agent }) {
  const tools = agent === 'claude' ? 'Bash/Read/Write/Edit' : 'your shell and file tools'
  const head = `You are a DMI network node. Use the dmi MCP tools plus ${tools} in this directory only.`
  const lead = challenge ? `call next_task with { challenge: "${challenge}" }` : 'call next_task with no arguments; the coordinator picks the challenge'
  if (challenge === 'dram-controller') {
    return `${head} Steps: 1) ${lead}. 2) Read the challenge summary, constraints, the baseline_source (a JSON policy document for a DRAM controller scored in Ramulator 2.0: row_policy, addr_mapper, write watermarks), the frontier source and strategy if present, and the corpus of past attempts. You cannot run the simulator locally; reason from DRAM behavior for LLM decode (streaming weight reads across channels plus paged KV reads with reuse). 3) Write policy.json: a JSON document within the allowed keys and value ranges only, with a top-of-file // name: <kebab-name> and // strategy: <one sentence> comment, trying an idea the corpus has not tried (row policy choice, closed-row cap tuning, address mapping such as MOP4CLXOR, watermark tuning). 4) Call submit with task_id, source (the file contents) and a run_log of your reasoning. Scoring takes up to two minutes. 5) Call status. Print one line: verdict, gain vs frontier, credits.`
  }
  if (challenge === 'rtl-cache-controller') {
    return `${head} Steps: 1) ${lead}. 2) Read the challenge summary, constraints, the baseline_source (a synthesizable Verilog module dmi_cache_policy: a replacement and prefetch policy block for a 16 KB 4-way cache, scored in Verilator by total cycles on a hidden memory access trace), the frontier source and strategy if present, and the corpus of past attempts. If verilator is on PATH you may write a tiny local testbench, otherwise reason from cache behavior (hot sets, streams, scans, pointer chases). 3) Write policy.v: the same module name and exact port list as the baseline, synthesizable only (no delays, no $ system tasks, no initial logic, no includes, no DPI), with a top-of-file // name: <kebab-name> and // strategy: <one sentence> comment, trying an idea the corpus has not tried (PLRU or RRIP replacement, next-line or stride prefetch, scan resistance, dead-block hints). 4) Call submit with task_id, source (the file contents) and a run_log of your reasoning. Scoring takes up to three minutes. 5) Call status. Print one line: verdict, gain vs frontier, credits.`
  }
  if (challenge) {
    return `${head} Steps: 1) ${lead}. 2) Write harness_source to harness.js and baseline_source to baseline.js, download public_trace_url to public-trace.json with curl. 3) Read the frontier source and strategy and the corpus of past attempts if present. Write policy.js, a CommonJS policy following the harness header contract, that tries a different idea from the frontier and from the corpus losers; start it with "// name: <kebab-name>" and "// strategy: <one sentence>". 4) Score with node harness.js policy.js and node harness.js baseline.js; iterate up to 4 times to lower the objective. 5) Call submit with task_id, source (the file contents) and a run_log of what you tried. 6) Call status. Print one line: verdict, gain vs frontier, credits.`
  }
  return `${head} Steps: 1) ${lead}. 2) Read the challenge summary, constraints, objective, the baseline_source, the frontier source and strategy if present, and the corpus of past attempts. 3) Produce one artifact that tries a different idea from the frontier and from the corpus losers, and start it with "// name: <kebab-name>" and "// strategy: <one sentence>". If the baseline is JavaScript: write harness_source to harness.js and baseline_source to baseline.js, download public_trace_url to public-trace.json with curl, write policy.js as a CommonJS policy following the harness header contract, and iterate up to 4 times with node harness.js policy.js against node harness.js baseline.js. If the baseline is a JSON policy document: write policy.json within the allowed keys and value ranges and reason about the hardware; you cannot run the simulator locally. If the baseline is Verilog: write policy.v with the same module name and exact port list, synthesizable only. 4) Call submit with task_id, source (the file contents) and a run_log of what you tried. Scoring can take up to three minutes. 5) Call status. Print one line: verdict, gain vs frontier, credits.`
}

/** How each agent is started headless. The MCP config is a file in the run directory, never an argument. */
export function launchSpec({ agent, prompt, model, runDir, key, base }) {
  const url = mcpUrl(base)
  const env = { ...process.env }
  if (agent === 'claude') {
    // Claude Code: one JSON file, loaded with --mcp-config, and only that file so the participant's other servers stay out of the run.
    const file = path.join(runDir, 'mcp.json')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { dmi: { type: 'http', url, headers: { 'x-api-key': key } } } }), { mode: 0o600 })
    // stream-json carries every assistant message, tool call and result, which spectator mode forwards as moves (docs/SPECTATE.md).
    const args = ['-p', prompt, '--mcp-config', file, '--strict-mcp-config', '--allowedTools', [...MCP_TOOLS, 'Bash', 'Read', 'Write', 'Edit'].join(','), '--output-format', 'stream-json', '--verbose']
    if (model) args.push('--model', model)
    return { bin: 'claude', args, env, files: [file], stream: 'claude' }
  }
  if (agent === 'cursor-agent') {
    // Cursor: project-scoped .cursor/mcp.json in the run directory.
    const dir = path.join(runDir, '.cursor')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'mcp.json')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { dmi: { url, headers: { 'x-api-key': key } } } }), { mode: 0o600 })
    const args = ['-p', prompt, '--force', '--output-format', 'text']
    if (model) args.push('--model', model)
    return { bin: 'cursor-agent', args, env, files: [file] }
  }
  if (agent === 'codex') {
    // Codex: config overrides on the command line name the server; the key travels in the environment (env_http_headers), never on argv.
    env[KEY_ENV] = key
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--cd', runDir,
      '-c', `mcp_servers.dmi.url="${url}"`, '-c', `mcp_servers.dmi.env_http_headers={"x-api-key"="${KEY_ENV}"}`]
    if (model) args.push('--model', model)
    args.push(prompt)
    return { bin: 'codex', args, env, files: [] }
  }
  throw new Error(`no launcher for ${agent}`)
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

async function http(base, method, route, { key, body } = {}) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: body == null ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = { error: text.slice(0, 200) } }
  return { status: res.status, ok: res.ok, body: json }
}

/** The spectator page for this key's handle. The coordinator names the site, so a local coordinator points at its own web. */
async function watchUrl({ base, key, handle }) {
  try {
    const me = handle ? null : await http(base, 'GET', '/v1/status', { key })
    const h = handle ?? me?.body?.handle
    if (!h) return null
    const root = await http(base, 'GET', '/')
    return `${root.body?.site ?? 'https://trydmi.com'}/live?handle=${encodeURIComponent(h)}`
  } catch { return null }
}

/** Opens a URL in the person's browser and forgets about it. A missing opener is not an error. */
export function openInBrowser(url) {
  const [bin, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try { const c = spawn(bin, args, { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref() } catch {}
}

/**
 * The key work mode runs under. Precedence: --key, DMI_API_KEY, the saved ~/.dmi/work.json, else register one.
 * Registration sends no handle, so the coordinator generates one. A 429 backs off and retries.
 */
export async function ensureKey({ base, key, dir, log, signal }) {
  const file = path.join(dir, 'work.json')
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  const use = key || process.env[KEY_ENV] || (saved?.coordinator === base ? saved.key : '') || ''
  if (use) {
    if (!isValidKey(use)) throw new Error('key does not look like a DMI key (expected dmi_ followed by 24+ letters or digits)')
    return { key: use, keyId: saved?.keyId ?? null, minted: false }
  }
  fs.mkdirSync(dir, { recursive: true })
  for (let attempt = 0; ; attempt++) {
    const r = await http(base, 'POST', '/v1/register', { body: { handle: '' } })
    if (r.ok && isValidKey(r.body?.key)) {
      fs.writeFileSync(file, JSON.stringify({ key: r.body.key, keyId: r.body.keyId, handle: r.body.handle ?? null, coordinator: base, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
      return { key: r.body.key, keyId: r.body.keyId, handle: r.body.handle, minted: true }
    }
    if (r.status !== 429 || attempt >= 8 || signal?.aborted) throw new Error(`register failed: ${r.status} ${r.body?.error ?? ''}`)
    const wait = Math.min(60000 * 2 ** attempt, 15 * 60000)
    log(`register rate limited (${r.body?.error ?? '429'}); retrying in ${Math.round(wait / 1000)} s`)
    await sleep(wait, signal)
  }
}

/** Runs logged today (UTC) so a restart keeps honoring --max-per-day. */
export function runsToday(logFile, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10)
  let text = ''
  try { text = fs.readFileSync(logFile, 'utf8') } catch { return 0 }
  return text.split('\n').filter((l) => l.startsWith(day) && l.includes(' run ')).length
}

const msUntilTomorrow = (now = Date.now()) => DAY_MS - (now % DAY_MS)

/**
 * Turns one Claude Code stream-json line into moves for spectator mode: assistant text, tool calls as the
 * tool's name, the file's basename and the kind of step (node/moves.js), and harness scores pulled out of
 * tool results. The command line never goes in a move. Returns [] for lines that are not moves.
 */
export function movesFromStreamLine(line) {
  let j
  try { j = JSON.parse(line) } catch { return [] }
  const out = []
  if (j.type === 'assistant') {
    for (const b of j.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'text', text: b.text.trim().slice(0, 600) })
      if (b.type === 'tool_use') out.push({ ...toolMove(b.name, b.input ?? {}), tool: String(b.name ?? '').replace(/^mcp__dmi__/, 'dmi:').slice(0, 40) })
    }
  }
  if (j.type === 'user') {
    for (const b of j.message?.content ?? []) {
      if (b.type !== 'tool_result') continue
      const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n')
      const m = /"bytesPerToken":\s*([0-9.]+)/.exec(text)
      if (m) out.push({ kind: 'score', score: Number(m[1]), unit: 'bytesPerToken' })
    }
  }
  return out
}

/**
 * The lease as the stream shows it: a next_task result carrying a task_id and a workspace opens one, a submit
 * result with a verdict closes it. Returns { open: task_id }, { close: true } or null for any other line.
 * Work mode writes this into work.json so the spectator hook, when it is installed too, keeps to the same window.
 */
export function leaseFromStreamLine(line) {
  let j
  try { j = JSON.parse(line) } catch { return null }
  if (j.type !== 'user') return null
  for (const b of j.message?.content ?? []) {
    if (b.type !== 'tool_result') continue
    const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n')
    const opened = /"task_id":\s*"([A-Za-z0-9_.:-]{1,80})"/.exec(text)
    if (opened && /"workspace"|"harness_source"|"baseline_source"|"build"/.test(text)) return { open: opened[1] }
    if (/"verdict":\s*"/.test(text) && !/"pending":\s*true/.test(text)) return { close: true }
  }
  return null
}

/** Posts moves to the coordinator under the key; never throws, never waits long. */
async function postMoves({ base, key, moves }) {
  if (!moves.length) return
  try { await http(base, 'POST', '/v1/live/moves', { key, body: { moves } }) } catch { /* spectating never blocks a run */ }
}

/** Start one headless session and collect its output. Resolves with { code, signal, output, ms }. */
function runAgent(spec, { runDir, signal, onChild, base, key, workFile = null }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(spec.bin, spec.args, { cwd: runDir, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] })
    onChild?.(child)
    let output = ''
    const keep = (d) => { output = (output + d).slice(-16384) }
    if (spec.stream === 'claude') {
      // Each stdout line is one JSON event; the final `result` event's text is what the log line reads.
      let buf = '', pending = [], flushTimer = null
      const flush = () => { const m = pending; pending = []; flushTimer = null; postMoves({ base, key, moves: m }) }
      child.stdout.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          if (!line.trim()) continue
          try { const j = JSON.parse(line); if (j.type === 'result') { output = String(j.result ?? '').slice(-16384); if (j.usage) output += `\n| tokens in ${j.usage.input_tokens} out ${j.usage.output_tokens} cache read ${j.usage.cache_read_input_tokens} | cost usd ${j.total_cost_usd} | ms ${j.duration_ms}` } } catch { /* not json */ }
          pending.push(...movesFromStreamLine(line))
          const lease = workFile ? leaseFromStreamLine(line) : null
          if (lease?.open) openLease(workFile, lease.open)
          if (lease?.close) closeLease(workFile)
          if (pending.length && !flushTimer) flushTimer = setTimeout(flush, 800)
        }
      })
      child.on('close', () => { if (flushTimer) clearTimeout(flushTimer); flush() })
    } else child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', (e) => resolve({ code: null, signal: null, output: `spawn failed: ${e.message}`, ms: Date.now() - t0 }))
    child.on('close', (code, sig) => resolve({ code, signal: sig, output, ms: Date.now() - t0 }))
    signal?.addEventListener('abort', () => { try { child.kill('SIGTERM') } catch {} setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000).unref() }, { once: true })
  })
}

/** The newest submission the coordinator recorded for this key since `since`, as one short line. */
async function verdictSince({ base, key, since }) {
  try {
    const r = await http(base, 'GET', '/v1/status', { key })
    if (!r.ok) return { line: r.status === 429 ? 'status rate limited' : `status ${r.status}`, rateLimited: r.status === 429, credits: null }
    const s = r.body
    const latest = (s.recent ?? []).find((x) => Date.parse(x.at) >= since - 5000)
    const line = latest
      ? `verdict=${latest.verdict} challenge=${latest.challenge} gain=${latest.gainVsBaselinePct ?? 'n/a'} credits=${latest.credits}`
      : 'verdict=none (no submission recorded)'
    return { line, rateLimited: false, credits: s.credits, handle: s.handle }
  } catch (e) { return { line: `status unreachable (${e.message})`, rateLimited: false, credits: null } }
}

const lastLine = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''

/**
 * The `dmi work` command. opts: { url, key, dir, agent, model, challenge, every (minutes), maxPerDay, once, dryRun, allowApiKey, log }.
 * Returns the state object when the loop ends (Ctrl-C, --once, or a fatal error).
 */
export async function runWorkCommand(opts = {}) {
  const base = coordinatorUrl(opts.url)
  const dir = workDir(opts.dir)
  const logFile = path.join(dir, 'work.log')
  const every = Math.max(1, Number(opts.every ?? 60))
  const maxPerDay = Math.max(1, Number(opts.maxPerDay ?? 12))
  const say = opts.log ?? ((m) => console.error(`[dmi work] ${m}`))
  fs.mkdirSync(dir, { recursive: true })
  const logLine = (kind, fields) => {
    const line = `${new Date().toISOString()} ${kind} ${fields}`
    fs.appendFileSync(logFile, line + '\n')
    say(`${kind} ${fields}`)
  }

  const agent = pickAgent(opts.agent)
  say(`agent: ${agent.name} (${agent.detail})`)
  if (agent.name === 'claude' && process.env.ANTHROPIC_API_KEY && !opts.allowApiKey) {
    throw new Error('ANTHROPIC_API_KEY is set in this shell, so Claude Code would bill the API instead of your subscription. Unset it, or pass --allow-api-key.')
  }

  const ac = new AbortController()
  const state = { agent: agent.name, base, dir, logFile, every, maxPerDay, runs: 0, today: runsToday(logFile), backoff: 0, lastRun: null, stopped: false }
  let child = null
  const stop = (why) => {
    if (state.stopped) return
    state.stopped = true
    say(`stopping (${why})`)
    ac.abort(new Error(why))
    if (child) { try { child.kill('SIGTERM') } catch {} }
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  const { key, minted, handle } = await ensureKey({ base, key: opts.key, dir, log: say, signal: ac.signal })
  say(minted ? `registered a new key${handle ? ' as ' + handle : ''}; saved to ${path.join(dir, 'work.json')}` : 'using the saved key')
  const watch = await watchUrl({ base, key, handle })
  if (watch) {
    say(`watch live: ${watch}`)
    if (!opts.noOpen && !opts.dryRun) openInBrowser(watch)
  }

  const prompt = buildPrompt({ challenge: opts.challenge, agent: agent.name })
  if (opts.dryRun) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-work-'))
    const spec = launchSpec({ agent: agent.name, prompt, model: opts.model, runDir, key: 'dmi_' + 'x'.repeat(24), base })
    fs.rmSync(runDir, { recursive: true, force: true })
    say(`dry run. would start: ${spec.bin} ${spec.args.map((a) => (a === prompt ? '<prompt>' : a)).join(' ')}`)
    return { ...state, dryRun: true, prompt }
  }

  while (!ac.signal.aborted) {
    if (state.today >= maxPerDay) {
      const wait = msUntilTomorrow()
      say(`${state.today} runs today, the daily limit is ${maxPerDay}; next run in ${Math.ceil(wait / 60000)} min`)
      if (opts.once) break
      await sleep(wait, ac.signal)
      state.today = 0
      continue
    }
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmi-work-'))
    const started = Date.now()
    let result
    try {
      const spec = launchSpec({ agent: agent.name, prompt, model: opts.model, runDir, key, base })
      say(`run ${state.runs + 1}: ${agent.name} in ${runDir}`)
      result = await runAgent(spec, { runDir, signal: ac.signal, onChild: (c) => { child = c }, base, key, workFile: path.join(dir, 'work.json') })
    } finally {
      child = null
      fs.rmSync(runDir, { recursive: true, force: true })
      // A session that died before its verdict leaves no open window behind it.
      closeLease(path.join(dir, 'work.json'))
    }
    state.runs++
    state.today++
    const v = await verdictSince({ base, key, since: started })
    const tail = lastLine(result.output).slice(0, 300)
    const rateLimited = v.rateLimited || /\b429\b|rate limit/i.test(result.output)
    logLine('run', `agent=${agent.name} challenge=${opts.challenge ?? 'coordinator'} ms=${result.ms} exit=${result.code ?? result.signal} ${v.line}${v.credits != null ? ` total=${v.credits}` : ''}${rateLimited ? ' rate_limited=1' : ''} | ${tail}`)
    state.lastRun = { at: new Date(started).toISOString(), ms: result.ms, exit: result.code, verdict: v.line, tail }
    if (opts.once || ac.signal.aborted) break
    // Rate limited: wait longer before the next session, doubling each time, and reset once a run goes through.
    state.backoff = rateLimited ? Math.min(state.backoff + 1, 4) : 0
    const wait = every * 60000 * 2 ** state.backoff
    say(`next run in ${Math.round(wait / 60000)} min${state.backoff ? ' (backing off after a rate limit)' : ''}`)
    await sleep(wait, ac.signal)
  }
  if (state.stopped) logLine('stopped', `agent=${agent.name} runs=${state.runs}`)
  return state
}
