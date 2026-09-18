/**
 * DMI challenge harness: lossless compression of a hidden corpus (compression-corpus).
 *
 * Shipped to every participant inside the task payload. The SAME code the coordinator runs on the hidden corpus.
 *
 * Model:
 *   - The corpus is a list of documents: prose, JSON lines, CSV tables, source text and raw binary records.
 *   - The submission is a codec. The harness builds one compressor instance and hands it every document in
 *     order, so a codec may carry a model from one document to the next. It then builds a SECOND, independent
 *     instance in a fresh context and hands that one the compressed outputs in the same order. The two
 *     instances share nothing: no globals, no closures, no disk, no clock. Everything the decompressor knows
 *     has to be in the bytes the compressor returned, or in the submitted source itself.
 *   - Round trip first. If any document does not come back byte for byte, the submission is invalid and no
 *     size is scored. A smaller wrong answer scores nothing.
 *
 * Objective: compressedBytes (lower is better) = the compressed payload over the whole corpus, plus the
 *   byte length of the submitted source. The source counts because the source is part of the encoding: a
 *   table baked into the artifact is bytes the decoder needs, exactly like bytes in the payload. Comments
 *   and whitespace count too, because any rule that skipped them could be used to smuggle a table.
 *
 * Codec contract (CommonJS source, evaluated in an isolated VM):
 *
 *   module.exports = function createCodec() {
 *     return {
 *       compress(input) { ... return out },     // input is a Uint8Array, return a Uint8Array
 *       decompress(input) { ... return out },   // input is what compress returned, return the original bytes
 *     }
 *   }
 *
 *   Both take a Uint8Array and must return a Uint8Array. Nothing else is available: no require, no I/O, no
 *   timers, no Math.random, no Date.now. The VM has none of them, and the last two are removed so a codec
 *   cannot be accidentally non-deterministic. Two runs of the same source must produce the same bytes; the
 *   coordinator reruns every improvement in a second process and compares the fingerprint.
 *
 * Time budget: 30 s of CPU for the whole corpus, compression and decompression together.
 */
import vm from 'node:vm'
import fs from 'node:fs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The artifact cannot be larger than this. It is also counted toward the score, so the cap is a ceiling, not a target. */
export const MAX_SOURCE_BYTES = 64 * 1024
/** A compressor that inflates is legal and scores badly. This cap only stops a runaway allocation. */
export const MAX_OUTPUT_FACTOR = 4

// Static denylist: none of these are needed by a codec and every known vm escape goes through one of them.
const FORBIDDEN = /\b(constructor|__proto__|prototype|process|require|import|Function|eval|globalThis|Reflect|Proxy|WebAssembly|Atomics|SharedArrayBuffer|arguments\.callee)\b|\bthis\s*\.\s*constructor/

/**
 * A context with the source evaluated in it, per codec instance. `Math.random` and `Date.now` are replaced
 * with throwers: a codec that reaches for either is non-deterministic, and the failure should say so at the
 * call rather than three runs later as an unreproducible score.
 */
const PRELUDE = `
var module = { exports: {} }; var exports = module.exports; var console = { log: function () {} };
Math.random = function () { throw new Error('Math.random is not available: a codec must be deterministic') };
Date.now = function () { throw new Error('Date.now is not available: a codec must be deterministic') };
`

/**
 * Checks the rules, then returns a handle that can build fresh, isolated codec instances from the same source.
 * `create()` evaluates the source in a NEW context every time, which is what keeps the compressor and the
 * decompressor from sharing state.
 */
export function loadPolicySource(source, { timeoutMs = 5000 } = {}) {
  if (typeof source !== 'string') throw new Error('codec source must be a string')
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  if (sourceBytes > MAX_SOURCE_BYTES) throw new Error(`codec source must be under 64 KB (this one is ${sourceBytes} bytes)`)
  if (sourceBytes < 10) throw new Error('codec source is empty')
  const hit = source.match(FORBIDDEN)
  if (hit) throw new Error(`codec uses a forbidden identifier: ${hit[0]}`)
  const create = () => {
    // Every object the codec can touch is created inside the context, so its constructor chain never reaches the host realm.
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
    vm.runInContext(PRELUDE, ctx)
    vm.runInContext(source, ctx, { timeout: timeoutMs, filename: 'codec.js' })
    const factory = vm.runInContext('module.exports', ctx)
    if (typeof factory !== 'function') throw new Error('codec must assign a factory function to module.exports')
    const inst = factory()
    if (!inst || typeof inst !== 'object') throw new Error('the codec factory must return an object')
    for (const m of ['compress', 'decompress']) if (typeof inst[m] !== 'function') throw new Error(`codec is missing ${m}()`)
    return inst
  }
  return { source, sourceBytes, sha256: crypto.createHash('sha256').update(source).digest('hex'), create }
}

/**
 * A byte view of any realm, copied into a host Uint8Array. Copying is what strips identity and extra
 * properties, so nothing but the bytes themselves can reach the second instance. `maxBytes` is checked
 * before the copy, not after, so an absurd return value is refused rather than allocated.
 */
function copyBytes(v, what, maxBytes) {
  if (v == null) throw new Error(`${what} returned nothing; it must return a Uint8Array`)
  if (!ArrayBuffer.isView(v) || v.BYTES_PER_ELEMENT !== 1) throw new Error(`${what} must return a Uint8Array (got ${typeof v})`)
  if (v.length > maxBytes) throw new Error(`${what} returned ${v.length} bytes, over the cap of ${maxBytes}`)
  const out = new Uint8Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]
  return out
}
const firstDiff = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return a.length === b.length ? -1 : n }

/**
 * Compresses every document with one instance, decompresses every output with a second, independent instance,
 * and scores the total. Throws on a broken round trip, a wrong return type, or a run past the budget.
 */
export function simulate(corpus, codec, { stepBudgetMs = 30000 } = {}) {
  const docs = corpus.documents
  if (!Array.isArray(docs) || !docs.length) throw new Error('corpus has no documents')
  const cpu0 = process.cpuUsage()
  const cpuMs = () => { const u = process.cpuUsage(cpu0); return (u.user + u.system) / 1000 }
  const started = Date.now()
  const budget = (phase) => { if (cpuMs() > stepBudgetMs) throw new Error(`codec exceeded time budget during ${phase} (${stepBudgetMs} ms of CPU for the whole corpus)`) }

  // Phase 1: compress. The codec gets a private copy of every document, so a codec that writes into its input
  // cannot corrupt what the round trip is checked against.
  const compressor = codec.create()
  const packed = []
  let payloadBytes = 0, originalBytes = 0
  const c0 = cpuMs()
  for (const d of docs) {
    const input = new Uint8Array(d.bytes.length)
    input.set(d.bytes)
    const out = copyBytes(compressor.compress(input), `compress() on document ${d.name}`, d.bytes.length * MAX_OUTPUT_FACTOR + 1024)
    packed.push(out)
    payloadBytes += out.length
    originalBytes += d.bytes.length
    budget('compression')
  }
  const compressMs = Math.round(cpuMs() - c0)

  // Phase 2: decompress with a fresh instance in a fresh context. It shares nothing with the compressor.
  const decompressor = codec.create()
  const d0 = cpuMs()
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]
    const back = copyBytes(decompressor.decompress(packed[i]), `decompress() on document ${d.name}`, d.bytes.length * MAX_OUTPUT_FACTOR + 1024)
    const at = firstDiff(back, d.bytes)
    if (at >= 0) {
      throw new Error(`round trip failed on document ${d.name} (${d.kind}): got ${back.length} bytes, expected ${d.bytes.length}, first difference at byte ${at}`)
    }
    budget('decompression')
  }
  const decompressMs = Math.round(cpuMs() - d0)

  // Fingerprint over every compressed byte: two codecs with the same fingerprint produced the same encoding.
  let fp = 2166136261
  for (const out of packed) {
    fp = (Math.imul(fp ^ out.length, 16777619) >>> 0)
    for (let i = 0; i < out.length; i++) fp = (Math.imul(fp ^ out[i], 16777619) >>> 0)
  }
  const byKind = {}
  for (let i = 0; i < docs.length; i++) {
    const k = docs[i].kind ?? 'unknown'
    byKind[k] ??= { documents: 0, originalBytes: 0, payloadBytes: 0 }
    byKind[k].documents++
    byKind[k].originalBytes += docs[i].bytes.length
    byKind[k].payloadBytes += packed[i].length
  }
  const sourceBytes = codec.sourceBytes ?? 0
  return {
    valid: true,
    documents: docs.length,
    originalBytes,
    payloadBytes,
    sourceBytes,
    /** The objective: payload over the whole corpus plus the bytes of the artifact that decodes it. */
    compressedBytes: payloadBytes + sourceBytes,
    ratio: +(originalBytes / (payloadBytes + sourceBytes)).toFixed(4),
    bitsPerByte: +(((payloadBytes + sourceBytes) * 8) / originalBytes).toFixed(4),
    byKind,
    perDocument: docs.map((d, i) => ({ name: d.name, kind: d.kind, bytes: d.bytes.length, compressed: packed[i].length })),
    corpusSha256: corpus.sha256 ?? null,
    sourceSha256: codec.sha256 ?? null,
    fingerprint: fp.toString(16),
    compressMs,
    decompressMs,
    wallMs: Date.now() - started,
  }
}

/** Reads a corpus file: JSON, or gzipped JSON when the name ends in .gz. Documents come back as Uint8Arrays. */
export function loadTrace(file) {
  const raw = fs.readFileSync(file)
  const buf = file.endsWith('.gz') || (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw) : raw
  const doc = JSON.parse(buf.toString('utf8'))
  const documents = doc.documents.map((d) => {
    const b = Buffer.from(d.bytes, 'base64')
    return { name: d.name, kind: d.kind, bytes: new Uint8Array(b.buffer, b.byteOffset, b.length) }
  })
  return { ...doc, documents, path: file }
}

const here = path.dirname(fileURLToPath(import.meta.url))
/** The public corpus, whichever form is on disk: the node writes it decompressed, the repository keeps it gzipped. */
export function defaultCorpusPath() {
  for (const f of ['public-corpus.json', 'public-corpus.json.gz']) { const p = path.join(here, f); if (fs.existsSync(p)) return p }
  return path.join(here, 'public-corpus.json.gz')
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [codecFile, corpusFile = defaultCorpusPath()] = process.argv.slice(2)
  if (!codecFile) { console.error('usage: node harness.js <codec.js> [corpus.json]'); process.exit(2) }
  console.log(JSON.stringify(simulate(loadTrace(corpusFile), loadPolicySource(fs.readFileSync(codecFile, 'utf8'))), null, 2))
}
