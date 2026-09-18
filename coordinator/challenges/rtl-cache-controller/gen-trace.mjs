#!/usr/bin/env node
/**
 * Memory access trace for the rtl-cache-controller challenge.
 *
 * A small in-order core runs a loop that looks like the inner loop of an inference kernel: a hot working set
 * that almost fits in the cache, long sequential weight streams that pollute it, cyclic scans of a buffer
 * larger than the cache, and pointer chases over a fixed random order. Each phase has a different best policy,
 * and the phases interleave. That is where plain LRU loses.
 *
 * Output is one access per line: "R <hex>" or "W <hex>", byte addresses without a 0x prefix, 32-bit.
 * Deterministic from the seed: same seed, same bytes.
 *
 *   node gen-trace.mjs --seed 1 --out public-trace.trace
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PARAMS = {
  lineBytes: 64,
  accesses: 1_000_000,       // lines in the trace
  addrBits: 32,
  hotLines: 176,             // hot working set, 11 KB: fits in a 16 KB cache with room for a stream
  hotWriteShare: 0.15,       // share of hot accesses that are stores
  streamMinLines: 256,       // sequential weight stream, read once, word by word
  streamMaxLines: 2048,
  wordBytes: 8,              // a stream touches every word of every line
  scanMinLines: 384,         // cyclic scan of a buffer that does not fit (24 KB to 48 KB)
  scanMaxLines: 768,
  scanPasses: 3,
  chaseLines: 512,           // pointer chase: a fixed random order over 32 KB, repeated
  chasePasses: 2,
  mixHotShare: 0.6,          // in a mixed phase, share of accesses that go to the hot set
  regionAlign: 1024 * 1024,
}

/** mulberry32: small, fast, deterministic. */
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

/**
 * Streams the trace to `emit(isWrite, addr)`. Returns counts and the layout.
 * Layout for a seed: every region sits at a 1 MB aligned base in the low 3 GB. The hidden seed changes the
 * bases, stream lengths, scan sizes, chase order and phase order; the model shape is fixed.
 */
export function generateTrace(seed, emit, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params }
  const r = rng(seed)
  const L = p.lineBytes
  const slots = Math.floor((3 * 1024 * 1024 * 1024) / p.regionAlign)
  const base = () => randInt(r, 0, slots - 1) * p.regionAlign
  const hotBase = base()
  const chaseBase = base()
  const scanBase = base()
  // Pointer chase order: a fixed random permutation of the chase region, the same on every pass.
  const chaseOrder = Array.from({ length: p.chaseLines }, (_, i) => i)
  for (let i = chaseOrder.length - 1; i > 0; i--) { const j = randInt(r, 0, i); [chaseOrder[i], chaseOrder[j]] = [chaseOrder[j], chaseOrder[i]] }

  let reads = 0, writes = 0, n = 0
  const ld = (a) => { reads++; n++; emit(false, a >>> 0) }
  const st = (a) => { writes++; n++; emit(true, a >>> 0) }
  const budget = () => n < p.accesses

  /** Hot set: skewed toward a few lines (r squared), a random word in the line, some stores. */
  const hot = () => {
    const line = Math.floor(r() * r() * p.hotLines)
    const a = hotBase + line * L + randInt(r, 0, L / p.wordBytes - 1) * p.wordBytes
    if (r() < p.hotWriteShare) st(a); else ld(a)
  }
  /** A generator over one sequential stream: every word of every line, in order. */
  function* stream() {
    const lines = randInt(r, p.streamMinLines, p.streamMaxLines)
    const b = base()
    for (let i = 0; i < lines; i++) for (let w = 0; w < L / p.wordBytes; w++) yield b + i * L + w * p.wordBytes
  }
  /** Cyclic scan: one access per line, in address order, several passes over a buffer bigger than the cache. */
  function* scan() {
    const lines = randInt(r, p.scanMinLines, p.scanMaxLines)
    for (let pass = 0; pass < p.scanPasses; pass++) for (let i = 0; i < lines; i++) yield scanBase + i * L + randInt(r, 0, L / p.wordBytes - 1) * p.wordBytes
  }
  /** Pointer chase: the fixed random order, several passes. */
  function* chase() {
    for (let pass = 0; pass < p.chasePasses; pass++) for (const i of chaseOrder) yield chaseBase + i * L
  }

  const phases = ['hot', 'stream', 'mix', 'scan', 'chase', 'mix', 'stream', 'hot']
  let counts = { hot: 0, stream: 0, mix: 0, scan: 0, chase: 0 }
  while (budget()) {
    const phase = phases[randInt(r, 0, phases.length - 1)]
    counts[phase]++
    if (phase === 'hot') { const k = randInt(r, 2000, 8000); for (let i = 0; i < k && budget(); i++) hot() }
    else if (phase === 'stream') { for (const a of stream()) { if (!budget()) break; ld(a) } }
    else if (phase === 'scan') { for (const a of scan()) { if (!budget()) break; ld(a) } }
    else if (phase === 'chase') { for (const a of chase()) { if (!budget()) break; ld(a) } }
    else {
      // Mixed: the hot loop keeps running while a stream is read through it.
      const g = stream()
      let next = g.next()
      while (!next.done && budget()) {
        if (r() < p.mixHotShare) hot(); else { ld(next.value); next = g.next() }
      }
    }
  }
  return { seed, params: p, lines: reads + writes, reads, writes, hotBase, chaseBase, scanBase, phases: counts }
}

/** Writes the trace file and a sidecar .meta.json (seed, params, counts) next to it. Returns the meta. */
export function writeTrace(file, seed, params = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  let buf = []
  const flush = () => { if (buf.length) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = [] } }
  const meta = generateTrace(seed, (isWrite, addr) => { buf.push((isWrite ? 'W ' : 'R ') + addr.toString(16)); if (buf.length >= 65536) flush() }, params)
  flush(); fs.closeSync(fd)
  fs.renameSync(tmp, file)
  fs.writeFileSync(metaPath(file), JSON.stringify(meta, null, 2))
  return meta
}
export const metaPath = (file) => file.replace(/\.trace$/, '') + '.meta.json'
export function readMeta(file) { try { return JSON.parse(fs.readFileSync(metaPath(file), 'utf8')) } catch { return null } }

/** Generates the public trace (seed 1) and the hidden trace (DMI_HIDDEN_SEED, default 13) when missing or when the hidden seed changed. */
export function ensureRtlTraces({ publicPath, hiddenPath, publicSeed = 1, hiddenSeed = Number(process.env.DMI_HIDDEN_SEED ?? 13) }) {
  if (!fs.existsSync(publicPath) || readMeta(publicPath)?.seed !== publicSeed) writeTrace(publicPath, publicSeed)
  if (!fs.existsSync(hiddenPath) || readMeta(hiddenPath)?.seed !== hiddenSeed) writeTrace(hiddenPath, hiddenSeed)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
  const seed = Number(opt('--seed', 1))
  const out = opt('--out', path.join(path.dirname(fileURLToPath(import.meta.url)), 'public-trace.trace'))
  const t0 = Date.now()
  const meta = writeTrace(out, seed)
  console.log(JSON.stringify({ out, seed, lines: meta.lines, reads: meta.reads, writes: meta.writes, phases: meta.phases, ms: Date.now() - t0 }))
}
