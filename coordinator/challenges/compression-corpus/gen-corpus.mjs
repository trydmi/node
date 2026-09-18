#!/usr/bin/env node
/**
 * Corpus for the compression-corpus challenge: a set of documents, deterministic from one seed.
 *
 * The corpus is generated, not vendored. A generated corpus is reproducible from a number, it carries no
 * license, and the hidden corpus is the same generator on another seed. Everything a seed decides is
 * re-rolled: the vocabulary, the phrase table, the service and route names, the column names, the
 * identifiers, the record layout constants and the order of the documents. So a compressor that hardcodes
 * words from the public corpus gains nothing on the hidden one, and a compressor that models structure
 * gains on both. That is the split we want to reward.
 *
 * Five kinds of document, four of each, about 100 KB apiece:
 *
 *   prose    English-shaped sentences from a Zipf vocabulary, with a phrase table that repeats
 *   jsonl    one log record per line, fixed key order, monotonic timestamps, bounded value sets
 *   csv      a numeric table: an id that counts, columns that random-walk, small categorical columns
 *   code     source-shaped text: indentation, a small identifier set reused, brackets that nest
 *   records  raw binary: fixed 24-byte records, little-endian counters, deltas and padding
 *
 *   node gen-corpus.mjs --seed 1 --out public-corpus.json.gz
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PARAMS = {
  perKind: 4,                  // documents of each kind
  bytesPerDocument: 100_000,   // target size of each document, give or take one record
  kinds: ['prose', 'jsonl', 'csv', 'code', 'records'],
  vocabWords: 3000,            // size of the generated vocabulary
  phrases: 300,                // repeated multi-word phrases in the prose
  recordBytes: 24,             // fixed record size in the binary documents
}

/** mulberry32: small, fast, deterministic. The same generator the other challenges use. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
const pick = (r, xs) => xs[Math.floor(r() * xs.length)]

const ONSETS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'z',
  'br', 'cl', 'dr', 'fl', 'gr', 'pl', 'pr', 'sh', 'sl', 'sp', 'st', 'th', 'tr', 'ch', 'wh', 'sc', 'sk', 'sn', 'sw']
const NUCLEI = ['a', 'e', 'i', 'o', 'u', 'ai', 'ea', 'ee', 'ie', 'oa', 'oo', 'ou', 'ay', 'ey', 'oi', 'au']
const CODAS = ['', '', 'n', 't', 'r', 's', 'l', 'm', 'd', 'k', 'g', 'p', 'ng', 'nt', 'st', 'rk', 'll', 'ss', 'ck', 'nd', 'rs', 'ft', 'sh', 'th']

/** A vocabulary of pseudo-words, unique, ordered most frequent first. */
function buildVocab(r, n) {
  const seen = new Set()
  const words = []
  while (words.length < n) {
    const syl = words.length < 40 ? 1 : randInt(r, 1, 3)
    let w = ''
    for (let i = 0; i < syl; i++) w += pick(r, ONSETS) + pick(r, NUCLEI) + pick(r, CODAS)
    if (w.length < 2 || seen.has(w)) continue
    seen.add(w)
    words.push(w)
  }
  return words
}
/** Zipf-shaped draw: the front of the vocabulary carries most of the mass. */
const zipf = (r, vocab) => vocab[Math.min(vocab.length - 1, Math.floor(vocab.length * Math.pow(r(), 2.6)))]

/** Everything the seed decides, built once and shared by every document in the corpus. */
function buildWorld(seed, p) {
  const r = rng(seed ^ 0x5f3a1c)
  const vocab = buildVocab(r, p.vocabWords)
  const phrases = []
  for (let i = 0; i < p.phrases; i++) {
    const n = randInt(r, 3, 5)
    const parts = []
    for (let j = 0; j < n; j++) parts.push(zipf(r, vocab))
    phrases.push(parts.join(' '))
  }
  const services = []
  for (let i = 0; i < 12; i++) services.push(`${zipf(r, vocab)}-${pick(r, ['api', 'worker', 'edge', 'store', 'gate'])}`)
  const routes = []
  for (let i = 0; i < 24; i++) routes.push(`/v1/${zipf(r, vocab)}/${zipf(r, vocab)}`)
  const levels = ['debug', 'info', 'warn', 'error']
  const columns = []
  for (let i = 0; i < 8; i++) columns.push(zipf(r, vocab))
  const enums = []
  for (let i = 0; i < 6; i++) enums.push(zipf(r, vocab).slice(0, 8).toUpperCase())
  return { vocab, phrases, services, routes, levels, columns, enums, epoch: 1735689600 + randInt(r, 0, 30_000_000) }
}

// ---------- document writers. Each appends ASCII (or raw bytes) until it reaches `target`. ----------

function prose(r, world, target) {
  const out = []
  let n = 0
  while (n < target) {
    const sentences = randInt(r, 3, 9)
    const para = []
    for (let s = 0; s < sentences; s++) {
      const words = []
      const len = randInt(r, 6, 18)
      while (words.length < len) {
        if (r() < 0.12) words.push(pick(r, world.phrases))
        else words.push(zipf(r, world.vocab))
      }
      let sentence = words.join(' ')
      sentence = sentence[0].toUpperCase() + sentence.slice(1)
      if (r() < 0.08) sentence = sentence.replace(' ', ', ')
      para.push(sentence + pick(r, ['.', '.', '.', '.', '?', '!']))
    }
    const text = para.join(' ') + '\n\n'
    out.push(text)
    n += text.length
  }
  return out.join('')
}

function jsonl(r, world, target) {
  const out = []
  let n = 0
  let ms = world.epoch * 1000
  let req = randInt(r, 0, 0xffff)
  while (n < target) {
    ms += randInt(r, 0, 900)
    const iso = new Date(ms).toISOString()
    req = (req + randInt(r, 1, 7)) >>> 0
    const lvl = r() < 0.86 ? 'info' : pick(r, world.levels)
    const code = r() < 0.9 ? 200 : pick(r, [201, 204, 301, 400, 401, 404, 409, 429, 500, 503])
    const dur = (r() * (code >= 500 ? 4000 : 120)).toFixed(2)
    const msg = [zipf(r, world.vocab), zipf(r, world.vocab), zipf(r, world.vocab)].join(' ')
    const line = `{"ts":"${iso}","lvl":"${lvl}","svc":"${pick(r, world.services)}","req":"${req.toString(16).padStart(8, '0')}",` +
      `"route":"${pick(r, world.routes)}","code":${code},"ms":${dur},"bytes":${randInt(r, 120, 60000)},"msg":"${msg}"}\n`
    out.push(line)
    n += line.length
  }
  return out.join('')
}

function csv(r, world, target) {
  const cols = world.columns
  const head = `id,ts,${cols[0]},${cols[1]},${cols[2]},${cols[3]},${cols[4]},${cols[5]}\n`
  const out = [head]
  let n = head.length
  let id = randInt(r, 1000, 9000)
  let ts = world.epoch
  let a = r() * 100, b = r() * 5, c = r() * 20000
  let cat = randInt(r, 0, world.enums.length - 1)
  while (n < target) {
    id += 1
    ts += randInt(r, 1, 4)
    a += (r() - 0.5) * 0.8
    b += (r() - 0.5) * 0.02
    c += Math.round((r() - 0.5) * 40)
    if (r() < 0.03) cat = randInt(r, 0, world.enums.length - 1)
    const line = `${id},${ts},${a.toFixed(3)},${b.toFixed(4)},${c},${world.enums[cat]},${randInt(r, 0, 9)},${zipf(r, world.vocab)}\n`
    out.push(line)
    n += line.length
  }
  return out.join('')
}

function code(r, world, target) {
  const ids = []
  for (let i = 0; i < 40; i++) ids.push(`${zipf(r, world.vocab)}_${zipf(r, world.vocab)}`)
  const types = ['int', 'long', 'double', 'char *', 'size_t', 'uint32_t']
  const out = []
  let n = 0
  while (n < target) {
    const fn = pick(r, ids)
    const args = []
    for (let i = 0; i < randInt(r, 1, 4); i++) args.push(`${pick(r, types)} ${pick(r, ids)}`)
    const body = []
    body.push(`/* ${zipf(r, world.vocab)} ${zipf(r, world.vocab)} ${zipf(r, world.vocab)} */`)
    body.push(`static ${pick(r, types)} ${fn}(${args.join(', ')})`)
    body.push('{')
    const lines = randInt(r, 4, 20)
    let depth = 1
    for (let i = 0; i < lines; i++) {
      const pad = '    '.repeat(depth)
      const k = r()
      if (k < 0.18 && depth < 3) { body.push(`${pad}if (${pick(r, ids)} > ${randInt(r, 0, 4096)}) {`); depth++ }
      else if (k < 0.26 && depth > 1) { depth--; body.push(`${'    '.repeat(depth)}}`) }
      else if (k < 0.4) body.push(`${pad}${pick(r, ids)} = ${pick(r, ids)} + ${randInt(r, 0, 255)};`)
      else if (k < 0.55 && depth < 3) { body.push(`${pad}for (${pick(r, ids)} = 0; ${pick(r, ids)} < ${randInt(r, 1, 64)}; ${pick(r, ids)}++) {`); depth++ }
      else if (k < 0.7) body.push(`${pad}${pick(r, ids)}(${pick(r, ids)}, ${randInt(r, 0, 32)});`)
      else if (k < 0.82) body.push(`${pad}/* ${zipf(r, world.vocab)} ${zipf(r, world.vocab)} */`)
      else body.push(`${pad}return ${pick(r, ids)};`)
    }
    while (depth > 1) { depth--; body.push(`${'    '.repeat(depth)}}`) }
    body.push('}', '')
    const text = body.join('\n') + '\n'
    out.push(text)
    n += text.length
  }
  return out.join('')
}

/** Fixed 24-byte records, little endian: a counter, a random walk, a timestamp, an enum, a checksum, padding. */
function records(r, world, target, recordBytes) {
  const count = Math.max(1, Math.floor(target / recordBytes))
  const buf = new Uint8Array(count * recordBytes)
  const dv = new DataView(buf.buffer)
  let id = randInt(r, 0, 1 << 20)
  let walk = randInt(r, 0, 1 << 24)
  let ts = world.epoch
  let kind = randInt(r, 0, world.enums.length - 1)
  for (let i = 0; i < count; i++) {
    const o = i * recordBytes
    id += r() < 0.97 ? 1 : randInt(r, 2, 9)
    walk = (walk + Math.round((r() - 0.5) * 512)) >>> 0
    ts += r() < 0.8 ? 0 : randInt(r, 1, 3)
    if (r() < 0.02) kind = randInt(r, 0, world.enums.length - 1)
    dv.setUint32(o + 0, id >>> 0, true)
    dv.setUint32(o + 4, walk, true)
    dv.setUint32(o + 8, ts >>> 0, true)
    dv.setUint32(o + 12, 0, true)
    dv.setUint16(o + 16, kind, true)
    dv.setUint16(o + 18, randInt(r, 0, 1023), true)
    let sum = 0
    for (let b = 0; b < 20; b++) sum = (sum + buf[o + b] * (b + 1)) & 0xffff
    dv.setUint16(o + 20, sum, true)
    dv.setUint16(o + 22, 0, true)
  }
  return buf
}

const ascii = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f; return b }

/**
 * The whole corpus for one seed: { seed, params, documents: [{ name, kind, bytes }], totalBytes, sha256 }.
 * `bytes` is a Uint8Array here and base64 in the file.
 */
export function generateCorpus(seed, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params }
  const world = buildWorld(seed, p)
  const writers = { prose, jsonl, csv, code }
  // Document order is shuffled from the seed, so a compressor cannot count on kind by position.
  const plan = []
  for (const kind of p.kinds) for (let i = 0; i < p.perKind; i++) plan.push(kind)
  const shuffle = rng(seed ^ 0x2b7e15)
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(shuffle() * (i + 1)); const t = plan[i]; plan[i] = plan[j]; plan[j] = t }

  const documents = []
  let totalBytes = 0
  for (let i = 0; i < plan.length; i++) {
    const kind = plan[i]
    const r = rng((seed * 7919 + i * 104729) >>> 0)
    const bytes = kind === 'records' ? records(r, world, p.bytesPerDocument, p.recordBytes) : ascii(writers[kind](r, world, p.bytesPerDocument))
    documents.push({ name: `${String(i).padStart(2, '0')}-${kind}`, kind, bytes })
    totalBytes += bytes.length
  }
  const h = crypto.createHash('sha256')
  for (const d of documents) h.update(d.bytes)
  return { seed, params: p, documents, totalBytes, sha256: h.digest('hex') }
}

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length).toString('base64')

/** Writes the corpus as JSON (gzipped when the name ends in .gz) and a sidecar .meta.json. Returns the meta. */
export function writeCorpus(file, seed, params = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const c = generateCorpus(seed, params)
  const doc = { seed: c.seed, params: c.params, totalBytes: c.totalBytes, sha256: c.sha256, documents: c.documents.map((d) => ({ name: d.name, kind: d.kind, bytes: b64(d.bytes) })) }
  const json = Buffer.from(JSON.stringify(doc), 'utf8')
  const body = file.endsWith('.gz') ? zlib.gzipSync(json, { level: 9 }) : json
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
  const meta = { seed: c.seed, params: c.params, documents: c.documents.length, totalBytes: c.totalBytes, sha256: c.sha256, fileBytes: body.length }
  fs.writeFileSync(metaPath(file), JSON.stringify(meta, null, 2))
  return meta
}
export const metaPath = (file) => file.replace(/\.json(\.gz)?$/, '') + '.meta.json'
export function readMeta(file) { try { return JSON.parse(fs.readFileSync(metaPath(file), 'utf8')) } catch { return null } }

/** Generates the public corpus (seed 1) and the hidden corpus (DMI_HIDDEN_SEED, default 13) when missing or when the seed changed. */
export function ensureCompressionCorpora({ publicPath, hiddenPath, publicSeed = 1, hiddenSeed = Number(process.env.DMI_HIDDEN_SEED ?? 13) }) {
  if (!fs.existsSync(publicPath) || readMeta(publicPath)?.seed !== publicSeed) writeCorpus(publicPath, publicSeed)
  if (!fs.existsSync(hiddenPath) || readMeta(hiddenPath)?.seed !== hiddenSeed) writeCorpus(hiddenPath, hiddenSeed)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
  const seed = Number(opt('--seed', 1))
  const out = opt('--out', path.join(path.dirname(fileURLToPath(import.meta.url)), 'public-corpus.json.gz'))
  const t0 = Date.now()
  const meta = writeCorpus(out, seed)
  console.log(JSON.stringify({ out, ...meta, params: undefined, ms: Date.now() - t0 }))
}
