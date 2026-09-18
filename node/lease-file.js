/**
 * The open lease in ~/.dmi/work.json (docs/SPECTATE.md). next_task writes `task_id`, the verdict clears
 * it, and the spectator hook posts only while one is there. Three writers share this file: the stdio node,
 * work mode, and the hook itself when the lease came through the hosted MCP endpoint. Every write keeps
 * the rest of the file (the key, the coordinator, `spectate`) and the file's 0600 mode.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const workFilePath = (dir) => path.join(dir || process.env.DMI_WORK_DIR || path.join(os.homedir(), '.dmi'), 'work.json')

export function readWorkFile(file) {
  try {
    const w = JSON.parse(fs.readFileSync(file, 'utf8'))
    return w && typeof w === 'object' && !Array.isArray(w) ? w : {}
  } catch { return {} }
}

function writeWorkFile(file, w) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(w, null, 2) + '\n', { mode: 0o600 })
}

/** Merges fields into the file. Never throws: a lease file that cannot be written must not fail a lease. */
export function updateWorkFile(file, fields) {
  try { writeWorkFile(file, { ...readWorkFile(file), ...fields }); return true } catch { return false }
}

/** A lease opened: the hook may speak about this task from now on. */
export function openLease(file, task_id) {
  if (!task_id) return false
  return updateWorkFile(file, { task_id: String(task_id), leased_at: new Date().toISOString() })
}

/** The verdict is in, or the lease was given up: the hook goes quiet. Missing fields are dropped, not nulled. */
export function closeLease(file) {
  try {
    const w = readWorkFile(file)
    if (!('task_id' in w) && !('leased_at' in w)) return true
    delete w.task_id; delete w.leased_at
    writeWorkFile(file, w)
    return true
  } catch { return false }
}
