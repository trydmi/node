#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook for DMI spectator mode (docs/SPECTATE.md). Installed by
 * `dmi install --claude --spectate`. Reads the hook event on stdin, turns it into one move (the tool's name,
 * the basename of the file it touched, and whether it was a read, a write, a test or other work) and posts it
 * to the coordinator under the participant's key. A harness run also posts its score, as a number. Fails
 * silent and fast: a hook must never slow the agent or break a session.
 *
 * The command line is never sent. It is read once, locally, to tell a harness run from other shell work,
 * and then it is gone. See node/moves.js for why.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toolMove, scoreMove, armedKey } from './moves.js'
import { workFilePath, readWorkFile, openLease, closeLease } from './lease-file.js'

const base = (process.env.DMI_COORDINATOR_URL ?? 'https://api.trydmi.com').replace(/\/$/, '')

/**
 * What one hook event becomes on the wire. Exported so a test can prove there is no command in it.
 *
 * A call to the network's own tools is not a move: the coordinator writes the lease and the verdict itself.
 * Those calls do something else here. When the lease came through the hosted MCP endpoint, nothing on this
 * machine but this hook ever sees the task_id, so the hook is the one that opens and closes the lease in
 * work.json.
 */
export function movesFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return { moves: [], lease: null }
  const tool = String(ev.tool_name ?? '')
  const inp = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {}
  const out = typeof ev.tool_response === 'string' ? ev.tool_response : JSON.stringify(ev.tool_response ?? '')
  // An MCP result is { content: [{ text: '<json>' }] }, so once stringified its inner quotes are escaped.
  if (/^mcp__dmi__next_task$/.test(tool)) {
    const m = /\\?"task_id\\?":\s*\\?"([A-Za-z0-9_.:-]{1,80})\\?"/.exec(out)
    return { moves: [], lease: m ? { open: m[1] } : null }
  }
  /*
   * A lease taken any other way still arms the hook.
   *
   * The live verification run leased over plain HTTP and its page stayed blank: only the MCP tool
   * name was recognised, so a curl to /v1/tasks/next, or the CLI, or a wrapper, left work.json with
   * no task_id and the hook silent for the whole run. A task id has one shape, <challenge>-<12 hex>,
   * and it only ever appears in a response when a lease was just granted, so any tool's output that
   * carries one opens the lease. A verdict in any output closes it the same way.
   */
  const leased = /\\?"task_id\\?":\s*\\?"([a-z0-9-]+-[a-f0-9]{12})\\?"/.exec(out)
  const judged = /\\?"verdict\\?":\s*\\?"(improved|no_improvement|invalid)\\?"/.test(out) && !/\\?"pending\\?":\s*true/.test(out)
  if (leased && /\\?"challenge\\?"/.test(out) && !/^mcp__dmi__/.test(tool)) return { moves: [], lease: { open: leased[1] } }
  if (judged && !/^mcp__dmi__/.test(tool)) return { moves: [], lease: { close: true } }
  if (/^mcp__dmi__submit$/.test(tool)) {
    // Still scoring: the lease is open until the verdict lands on a later call.
    return { moves: [], lease: /\\?"pending\\?":\s*true/.test(out) ? null : { close: true } }
  }
  const moves = [toolMove(tool, inp)]
  const s = scoreMove(tool, inp, out)
  if (s) moves.push(s)
  return { moves, lease: null }
}

async function main() {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const d of process.stdin) input += d
  let ev
  try { ev = JSON.parse(input) } catch { return }
  const file = workFilePath()
  const { moves, lease } = movesFromEvent(ev)
  const w = readWorkFile(file)
  /*
   * Nothing leaves this machine unless the participant asked for it, in writing, in their own file.
   *
   * This hook used to need a key and nothing else. It is installed into ~/.claude/settings.json, and
   * that file is global, so a key sitting in work.json meant every command in EVERY agent session on
   * the machine was posted to an endpoint that needs no key to read. Whether or not a challenge was
   * being worked. Nobody chose that, because watching was on by default.
   *
   * Now it wants `spectate: true` and an open `task_id` in work.json. No lease, no post. Refusing this
   * here rather than at the coordinator matters, because a request that is sent and then rejected has
   * still travelled, and has still been written down by everything it passed through on the way.
   */
  if (lease?.open) { if (w.spectate !== false) openLease(file, lease.open); return }
  if (lease?.close) { closeLease(file); return }
  const key = armedKey(w)
  if (!key || !moves.length) return
  try {
    await fetch(`${base}/v1/live/moves`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ moves }), signal: AbortSignal.timeout(1500) })
  } catch { /* never block the agent */ }
}

// Run only as a script. Importing this file for its transform must not touch stdin or the network.
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => {})
}
