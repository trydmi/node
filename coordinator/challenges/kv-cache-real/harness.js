/**
 * DMI challenge harness: KV-cache block eviction on REAL inference traffic (kv-cache-real).
 *
 * Shipped to every participant inside the task payload. The SAME code the coordinator runs on the hidden window.
 *
 * Model:
 *   - A serving engine keeps prompt KV blocks (16 tokens each, content addressed) in a fixed-capacity store.
 *   - Requests arrive in real order from a production trace. Each request reads every block of its prompt in
 *     order. Blocks shared with earlier requests (system prompts, earlier turns of the same conversation) are
 *     cache hits when resident. A block that is not resident is loaded; that load is the bytes we minimize.
 *   - The policy is told when a request starts (seq id, how many blocks it will read) and about every access.
 *     It is never told the output length, the turn number, or whether the conversation will return.
 *
 * Objective: bytes loaded per generated-plus-prompt token (lower is better).
 *
 * Policy contract (CommonJS source, evaluated in an isolated VM):
 *
 *   module.exports = function createPolicy({ capacity, blockBytes }) {
 *     return {
 *       onRequest(req) {},                 // { t, seq, nblocks }  a request begins
 *       onAccess(key, req, hit) {},        // every block access, key is an integer block id
 *       onEvict(key) {},                   // optional bookkeeping hook
 *       victim(req) {}                     // must return a key that is currently resident
 *     }
 *   }
 *   The policy keeps its own bookkeeping of what is resident (it saw every insert via onAccess miss and every
 *   eviction via onEvict). The harness never hands over the resident set, so a policy must be O(1) per access.
 *   req = { t, seq, nblocks, i }  where i is the index of this block within the request's prompt
 *
 * Time budget: 10 s for the whole window. The public window is about 1.3 million accesses.
 */
import vm from 'node:vm'
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

export function simulate(trace, createPolicy, { stepBudgetMs = 10000 } = {}) {
  const { capacity, blockBytes, requests } = trace
  const policy = createPolicy({ capacity, blockBytes })
  for (const m of ['onAccess', 'victim']) if (typeof policy[m] !== 'function') throw new Error(`policy is missing ${m}()`)
  const onRequest = typeof policy.onRequest === 'function' ? policy.onRequest.bind(policy) : () => {}
  const onEvict = typeof policy.onEvict === 'function' ? policy.onEvict.bind(policy) : () => {}
  const resident = new Set()
  let fp = 2166136261, bytesMoved = 0, tokens = 0, accesses = 0, hits = 0, evictions = 0
  const cpu0 = process.cpuUsage()
  const cpuMs = () => { const u = process.cpuUsage(cpu0); return (u.user + u.system) / 1000 }
  const started = Date.now()
  for (const q of requests) {
    tokens += q.tokens
    const base = { t: q.t, seq: q.seq, nblocks: q.keys.length }
    onRequest(base)
    for (let i = 0; i < q.keys.length; i++) {
      const key = q.keys[i]
      const req = { t: q.t, seq: q.seq, nblocks: q.keys.length, i }
      accesses++
      if (resident.has(key)) { hits++; policy.onAccess(key, req, true); continue }
      if (resident.size >= capacity) {
        const victim = policy.victim(req)
        if (!resident.has(victim)) throw new Error(`victim ${String(victim)} is not resident (t=${q.t})`)
        resident.delete(victim); evictions++; if (evictions <= 200000) fp = (Math.imul(fp ^ Number(victim), 16777619) >>> 0); onEvict(victim)
      }
      resident.add(key); bytesMoved += blockBytes
      policy.onAccess(key, req, false)
      if ((accesses & 0x3fff) === 0 && cpuMs() > stepBudgetMs) throw new Error('policy exceeded time budget')
    }
  }
  return { bytesMoved, tokens, accesses, hits, misses: accesses - hits, evictions, hitRate: accesses ? hits / accesses : 0,
    /** Hash of the first 200,000 eviction decisions. Two policies with the same fingerprint are the same policy. */
    fingerprint: fp.toString(16), bytesPerToken: tokens ? bytesMoved / tokens : Infinity, wallMs: Date.now() - started }
}

export function loadTrace(file) { const buf = fs.readFileSync(file); return JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8')) }

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [policyFile, traceFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public-trace.json.gz')] = process.argv.slice(2)
  if (!policyFile) { console.error('usage: node harness.js <policy.js> [trace.json]'); process.exit(2) }
  console.log(JSON.stringify(simulate(loadTrace(traceFile), loadPolicySource(fs.readFileSync(policyFile, 'utf8'))), null, 2))
}
