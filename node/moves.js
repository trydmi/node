/**
 * What a tool call becomes before it leaves the participant's machine (docs/SPECTATE.md). Shared by the
 * Claude Code hook (node/spectate-hook.js), work mode (cli/work.js) and the coordinator, which applies the
 * same rules again on the way in so a stale client cannot widen them.
 *
 * A move is three fields: the tool's name, the basename of the file it touched, and one of four words for
 * what kind of step it was. Nothing else. Until 2026-09-16 the move carried the command line itself, run
 * through a denylist scrubber, and the scrubber missed `curl -u user:pass`, short passwords, ssh targets,
 * emails, addresses, hostnames and `.env` paths. A denylist cannot win against a shell. Three fields with
 * nothing in them to leak can.
 */
import path from 'node:path'

export const CATEGORIES = new Set(['read', 'write', 'test', 'work'])
export const FILE_MAX = 80

/** Even a basename can say too much. These names are replaced with the words "a file". */
export const SENSITIVE_FILE = /^\.env|credential|id_rsa|id_ed25519|id_ecdsa|id_dsa|\.netrc|kubeconfig|\.pem$|\.p12$|\.pfx$|\.pgpass|\.npmrc|\.pypirc|secret|token|password|passwd/i

/** A tool that runs the local harness or a simulator. Only ever matched locally; the command is not sent. */
const TEST_RUN = /harness\.js|node\s+--test|verilator|ramulator|yosys|\bnpm\s+test\b/

/**
 * The basename of a path, or null. Never a directory, never a slash, never longer than 80 characters, and
 * never the name of a secrets file.
 */
export function safeFile(v) {
  if (v == null) return null
  const raw = String(v).trim()
  if (!raw) return null
  // path.basename understands the local separator only; a backslash path from a Windows client is split here.
  const name = path.basename(raw.replace(/\\/g, '/')).slice(0, FILE_MAX)
  if (!name || name === '.' || name === '..') return null
  return SENSITIVE_FILE.test(name) ? 'a file' : name
}

/**
 * A shell command that only looks at a file. A terminal agent reads the record holder's design with
 * cat or sed far more often than with the Read tool: in five mined runs, four moves out of 165 were
 * Read and the rest of the reading arrived as "work". Matched locally; the command never leaves.
 */
const SHELL_READ = /^\s*(cat|head|tail|less|more|wc|sed\s+-n|grep|rg|ag|find|ls|tree|diff|stat|file|jq|hexdump|xxd|nl)\b/
/** A shell command that writes a file: a heredoc or redirect into it, a copy, a move, tee. */
const SHELL_WRITE = /(cat\s*>|>\s*[\w./-]|<<\s*['"]?EOF|<<\s*['"]?\w+['"]?\s*>|\btee\b|^\s*(cp|mv|touch|mkdir|install)\b)/

/** read, write, test or work, from the tool's name and, for a shell, what the command does. */
export function categoryFor(tool, input = {}) {
  const t = String(tool ?? '').toLowerCase()
  if (t === 'bash') {
    const cmd = String(input?.command ?? '')
    if (TEST_RUN.test(cmd)) return 'test'
    if (SHELL_WRITE.test(cmd)) return 'write'
    if (SHELL_READ.test(cmd)) return 'read'
    return 'work'
  }
  if (/write|edit/.test(t)) return 'write'
  if (t === 'read' || t === 'grep' || t === 'glob') return 'read'
  return 'work'
}

/**
 * The file a shell command is about, as a basename, or null. The first token that looks like a path
 * with an extension, or the redirect target. Read locally, reduced to a basename, then the command is
 * dropped. A command with no such token gives no file.
 */
export function shellFile(cmd) {
  const c = String(cmd ?? '')
  const redirect = c.match(/>\s*([\w./-]+\.\w{1,8})/)
  if (redirect) return safeFile(redirect[1])
  const tok = c.match(/(?:^|\s)(\/?(?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]{1,8})(?=\s|$|['")|])/i)
  return tok ? safeFile(tok[1]) : null
}

/** One tool call as a move. The command is read for its category and its file's basename, then dropped. */
export function toolMove(tool, input = {}) {
  const t = String(tool ?? '').toLowerCase()
  const category = categoryFor(tool, input)
  const file = t === 'bash'
    ? (category === 'read' || category === 'write' ? shellFile(input?.command) : null)
    : safeFile(input?.file_path ?? input?.notebook_path ?? null)
  return { kind: 'tool', tool: String(tool ?? '').slice(0, 40), file, category }
}

/**
 * A harness run prints its score as JSON. When the tool was a test run, the number comes out as a score
 * move so the arena can draw the skirmish. Only the number and its unit travel.
 */
export function scoreMove(tool, input, output) {
  if (categoryFor(tool, input) !== 'test') return null
  // Claude Code hands a shell result over as { stdout, stderr, ... }. The score is in stdout; a stringified
  // object would have its quotes escaped and the number would never be found.
  const out = typeof output === 'string' ? output : typeof output?.stdout === 'string' ? output.stdout : JSON.stringify(output ?? '')
  const m = /\\?"bytesPerToken\\?":\s*([0-9.]+)/.exec(out) ?? /\\?"(cycles|ppa|conflicts|medianMs)\\?":\s*([0-9.]+)/.exec(out)
  if (!m) return null
  return { kind: 'score', score: Number(m[2] ?? m[1]), unit: m[2] ? m[1] : 'bytesPerToken' }
}

/** A lease older than this is not a lease. Leases do not expire on their own, so the file must not either. */
export const LEASE_WINDOW_MS = 6 * 3600e3

/**
 * Whether ~/.dmi/work.json arms the hook: `spectate: true`, written by `dmi install --spectate`, and an open
 * `task_id` written by next_task and cleared by the verdict. Returns the key to post under, or null.
 */
export function armedKey(w, now = Date.now()) {
  if (!w || typeof w !== 'object') return null
  if (w.spectate === false || !w.task_id) return null
  if (w.leased_at && !(now - Date.parse(w.leased_at) < LEASE_WINDOW_MS)) return null
  const key = String(w.key ?? '')
  return /^dmi_[A-Za-z0-9]{24,}$/.test(key) ? key : null
}
