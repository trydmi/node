/**
 * DMI challenge harness: KV-cache block eviction under agentic decode.
 *
 * This file is shipped to every participant inside the task payload and is
 * the SAME code the coordinator runs against the hidden trace. Agents grade
 * nothing; this deterministic simulator does.
 *
 * Model (deliberately small, deliberately honest):
 *   - A serving engine holds KV-cache blocks for many interleaved sequences
 *     (conversations). Capacity is a fixed number of blocks.
 *   - Every decode step of a sequence reads ALL of that sequence's blocks
 *     (attention over the whole context) and appends one new block every
 *     `blockTokens` tokens. A block that is not resident must be loaded from
 *     the next tier; that load is the "bytes moved" we are minimizing.
 *   - A shared system-prompt prefix (seq "shared") is read by every sequence.
 *   - Sequences finish (the engine emits a `finish` event) and some of them
 *     come back later for another turn, re-reading their old blocks. The
 *     policy is told about finishes but is NOT told who will return.
 *   - When the cache is full and a block must be loaded, the policy picks a
 *     victim among resident blocks.
 *
 * Objective: minimize bytes moved per generated token (lower is better).
 *
 * Policy contract (CommonJS source, evaluated in an isolated VM):
 *
 *   module.exports = function createPolicy({ capacity, blockBytes }) {
 *     return {
 *       onAccess(key, req, hit) {},        // every block access
 *       onEvent(evt) {},                   // { type: 'finish', seq, t }
 *       onEvict(key) {},                   // optional bookkeeping hook
 *       victim(residentKeys, req) {}       // must return one of residentKeys
 *     }
 *   }
 *
 *   key  = `${seq}:${block}`  (seq is a string; "shared" is the common prefix)
 *   req  = { t, seq, block, bytes, step, seqBlocks }
 *
 * Pattern provenance: BOINC work units (a self-contained payload the client
 * can score locally) + Kaggle's public/private split (local score is honest
 * but the leaderboard score comes from data the participant never sees).
 */

import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Load a policy from CommonJS source text inside a fresh VM context.
 * The context has no `require`, no `process`, no network. This is a
 * fault-isolation boundary, not a security boundary; the coordinator
 * runs untrusted policies in a separate child process on top of this.
 */
// Static denylist: none of these are needed by a cache policy and every known vm escape goes through one of them.
const FORBIDDEN = /\b(constructor|__proto__|prototype|process|require|import|Function|eval|globalThis|Reflect|Proxy|WebAssembly|Atomics|SharedArrayBuffer|arguments\.callee)\b|\bthis\s*\.\s*constructor/
export function loadPolicySource(source, { timeoutMs = 2000 } = {}) {
  if (typeof source !== 'string' || source.length > 200_000) throw new Error('policy source must be a string under 200 KB')
  const hit = source.match(FORBIDDEN)
  if (hit) throw new Error(`policy uses a forbidden identifier: ${hit[0]}`)
  // Every object the policy can touch is created inside the context, so its constructor chain never reaches the host realm.
  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext('var module = { exports: {} }; var exports = module.exports; var console = { log: function () {} };', ctx)
  vm.runInContext(source, ctx, { timeout: timeoutMs, filename: 'policy.js' })
  const factory = vm.runInContext('module.exports', ctx)
  if (typeof factory !== 'function') throw new Error('policy must assign a factory function to module.exports')
  return factory
}

/**
 * Run the simulator. Returns metrics; throws on a contract violation
 * (victim not resident, factory returning junk) so that invalid policies
 * score as invalid rather than as accidentally good.
 */
export function simulate(trace, createPolicy, { stepBudgetMs = 10000 } = {}) {
  const { capacity, blockBytes, events } = trace
  const policy = createPolicy({ capacity, blockBytes })
  for (const m of ['onAccess', 'onEvent', 'victim']) {
    if (typeof policy[m] !== 'function') throw new Error(`policy is missing ${m}()`)
  }

  const resident = new Set()
  let bytesMoved = 0
  let tokens = 0
  let fp = 2166136261
  let accesses = 0
  let hits = 0
  let evictions = 0
  const cpu0 = process.cpuUsage()
  const cpuMs = () => { const u = process.cpuUsage(cpu0); return (u.user + u.system) / 1000 }
  const started = Date.now()

  for (const evt of events) {
    if (evt.type === 'finish') {
      policy.onEvent({ type: 'finish', seq: evt.seq, t: evt.t })
      continue
    }
    // evt.type === 'step': one decode step; reads every block of the sequence.
    // Blocks of a sequence are always 0..nblocks-1 (KV cache grows append-only),
    // so the trace stores the count rather than the list.
    tokens += evt.tokens
    const req = { t: evt.t, seq: evt.seq, step: evt.step, seqBlocks: evt.nblocks, bytes: blockBytes }
    for (let block = 0; block < evt.nblocks; block++) {
      const key = `${evt.seq}:${block}`
      accesses++
      const hit = resident.has(key)
      if (hit) {
        hits++
        policy.onAccess(key, { ...req, block }, true)
        continue
      }
      if (resident.size >= capacity) {
        const victim = policy.victim([...resident], { ...req, block })
        if (!resident.has(victim)) {
          throw new Error(`victim ${String(victim)} is not resident (t=${evt.t})`)
        }
        resident.delete(victim)
        evictions++; if (evictions <= 200000) { const str = String(victim); for (let q = 0; q < str.length; q++) fp = (Math.imul(fp ^ str.charCodeAt(q), 16777619) >>> 0) }
        if (typeof policy.onEvict === 'function') policy.onEvict(victim)
      }
      resident.add(key)
      bytesMoved += blockBytes
      policy.onAccess(key, { ...req, block }, false)
    }
    if ((accesses & 0xfff) === 0 && Date.now() - started > stepBudgetMs) {
      throw new Error('policy exceeded time budget')
    }
  }

  return {
    bytesMoved,
    tokens,
    accesses,
    hits,
    misses: accesses - hits,
    evictions,
    hitRate: accesses ? hits / accesses : 0,
    /** Hash of the first 200,000 eviction decisions. Two policies with the same fingerprint are the same policy. */
    fingerprint: fp.toString(16),
    /** The objective. Lower is better. */
    bytesPerToken: tokens ? bytesMoved / tokens : Infinity,
    wallMs: Date.now() - started,
    cpuMs: Math.round(cpuMs()),
  }
}

export function loadTrace(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// CLI: node harness.js <policy.js> [trace.json]
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [policyFile, traceFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public-trace.json')] = process.argv.slice(2)
  if (!policyFile) {
    console.error('usage: node harness.js <policy.js> [trace.json]')
    process.exit(2)
  }
  const factory = loadPolicySource(fs.readFileSync(policyFile, 'utf8'))
  const result = simulate(loadTrace(traceFile), factory)
  console.log(JSON.stringify(result, null, 2))
}
