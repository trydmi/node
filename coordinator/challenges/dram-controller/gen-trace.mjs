#!/usr/bin/env node
/**
 * DRAM access trace for the dram-controller challenge: LLM decode on a memory-bound accelerator.
 *
 * One decode step reads every weight once (long sequential streams) and reads the whole KV cache of every
 * active sequence (paged, scattered, re-read every step), then writes the new token's K and V. Several
 * attention engines run at once, so the memory system sees the weight stream and several KV page streams
 * interleaved in short bursts. The pattern repeats for a few steps, each step one token longer.
 *
 * Output is Ramulator 2.0's LoadStoreTrace format: one request per line, "LD <addr>" or "ST <addr>",
 * addresses in hex with a 0x prefix. One line is one 64-byte DDR4 transaction (Ramulator's DDR4 model:
 * prefetch 8 x 64-bit channel). Deterministic from the seed: same seed, same bytes.
 *
 *   node gen-trace.mjs --seed 1 --out public-trace.trace
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PARAMS = {
  lineBytes: 64,
  layers: 8,
  weightBytesPerLayer: 3 * 1024 * 1024, // 24 MB of weights in total
  attnShare: 0.4,                        // share of each layer's weights read in the attention phase
  batch: 8,                              // active sequences
  kvBytesPerTokenPerLayer: 256,          // K 128 B + V 128 B
  pageTokens: 16,                        // paged KV cache, 16 tokens per page
  ctxMin: 256,
  ctxMax: 2048,
  kvPoolBytes: 512 * 1024 * 1024,        // K pool and V pool are each this big; pages are scattered inside
  engines: 4,                            // attention engines reading KV pages concurrently
  mlpStreams: 2,                         // concurrent weight streams in the MLP phase
  burstMin: 2,                           // lines per turn when streams are interleaved
  burstMax: 8,
  steps: 4,                              // decode steps in the trace
  addrBits: 36,                          // 64 GB: DDR4_8Gb_x8, 4 channels, 2 ranks
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
 * Streams the trace to `emit(isWrite, addr)`. Returns counts. Layout for a seed:
 *   weights: one contiguous region at a 64 MB aligned offset in the first 16 GB
 *   K pool, V pool: kvPoolBytes each, at 64 MB aligned offsets in the upper half of the address space
 * The hidden seed changes offsets, context lengths, page placement and burst sizes; the model shape is fixed.
 */
export function generateTrace(seed, emit, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params }
  const r = rng(seed)
  const L = p.lineBytes
  const align = 64 * 1024 * 1024
  const weightBase = randInt(r, 0, (16 * 1024 * 1024 * 1024) / align - 1) * align
  const upper = 2 ** (p.addrBits - 1)
  const poolSlots = Math.floor((upper - 2 * p.kvPoolBytes) / align)
  const kBase = upper + randInt(r, 0, poolSlots - 1) * align
  let vBase = upper + randInt(r, 0, poolSlots - 1) * align
  while (Math.abs(vBase - kBase) < p.kvPoolBytes) vBase = upper + randInt(r, 0, poolSlots - 1) * align
  const pagesInPool = Math.floor(p.kvPoolBytes / (p.pageTokens * (p.kvBytesPerTokenPerLayer / 2)))
  const pageBytes = p.pageTokens * (p.kvBytesPerTokenPerLayer / 2)
  const pageLines = pageBytes / L
  const tokenLines = p.kvBytesPerTokenPerLayer / 2 / L

  // Sequences: context length and per-layer page tables (K and V), one entry per page.
  const seqs = []
  for (let s = 0; s < p.batch; s++) {
    const ctx = randInt(r, p.ctxMin, p.ctxMax)
    const pages = Math.ceil(ctx / p.pageTokens)
    const kPages = [], vPages = []
    for (let l = 0; l < p.layers; l++) {
      kPages.push(Array.from({ length: pages }, () => randInt(r, 0, pagesInPool - 1)))
      vPages.push(Array.from({ length: pages }, () => randInt(r, 0, pagesInPool - 1)))
    }
    seqs.push({ ctx, kPages, vPages })
  }

  let reads = 0, writes = 0
  const ld = (a) => { reads++; emit(false, a) }
  const st = (a) => { writes++; emit(true, a) }

  /** Interleave several line generators in bursts until all are done. A generator yields addresses. */
  const interleave = (gens) => {
    const live = gens.map((g) => ({ g, next: g.next() })).filter((x) => !x.next.done)
    while (live.length) {
      for (let i = 0; i < live.length; i++) {
        const burst = randInt(r, p.burstMin, p.burstMax)
        const x = live[i]
        for (let b = 0; b < burst && !x.next.done; b++) { ld(x.next.value); x.next = x.g.next() }
      }
      for (let i = live.length - 1; i >= 0; i--) if (live[i].next.done) live.splice(i, 1)
    }
  }
  function* stream(base, bytes) { const n = Math.floor(bytes / L); for (let i = 0; i < n; i++) yield base + i * L }
  function* kvPages(seq, layer) {
    const used = Math.ceil(seq.ctx / p.pageTokens)
    for (let pg = 0; pg < used; pg++) {
      const tokens = Math.min(p.pageTokens, seq.ctx - pg * p.pageTokens)
      const kb = kBase + seq.kPages[layer][pg] * pageBytes, vb = vBase + seq.vPages[layer][pg] * pageBytes
      for (let i = 0; i < tokens * tokenLines; i++) yield kb + i * L
      for (let i = 0; i < tokens * tokenLines; i++) yield vb + i * L
    }
  }
  function* chain(list) { for (const g of list) yield* g }

  const attnBytes = Math.floor(p.weightBytesPerLayer * p.attnShare / L) * L
  const mlpBytes = p.weightBytesPerLayer - attnBytes
  for (let step = 0; step < p.steps; step++) {
    for (let l = 0; l < p.layers; l++) {
      const layerBase = weightBase + l * p.weightBytesPerLayer
      // Attention: the qkv/out projection weights stream while the engines walk KV pages, one sequence each at a time.
      const engines = Array.from({ length: p.engines }, (_, e) => chain(seqs.filter((_, s) => s % p.engines === e).map((seq) => kvPages(seq, l))))
      interleave([stream(layerBase, attnBytes), ...engines])
      // The new token's K and V land at the end of each sequence's last page.
      for (const seq of seqs) {
        const pg = Math.floor(seq.ctx / p.pageTokens), off = (seq.ctx % p.pageTokens) * tokenLines * L
        if (pg >= seq.kPages[l].length) { seq.kPages[l].push(randInt(r, 0, pagesInPool - 1)); seq.vPages[l].push(randInt(r, 0, pagesInPool - 1)) }
        for (let i = 0; i < tokenLines; i++) st(kBase + seq.kPages[l][pg] * pageBytes + off + i * L)
        for (let i = 0; i < tokenLines; i++) st(vBase + seq.vPages[l][pg] * pageBytes + off + i * L)
      }
      // MLP: up and down projections stream side by side.
      const part = Math.floor(mlpBytes / p.mlpStreams / L) * L
      interleave(Array.from({ length: p.mlpStreams }, (_, i) => stream(layerBase + attnBytes + i * part, part)))
    }
    for (const seq of seqs) seq.ctx++
  }
  return { seed, params: p, lines: reads + writes, reads, writes, weightBase, kBase, vBase }
}

/** Writes the trace file and a sidecar .meta.json (seed, params, counts) next to it. Returns the meta. */
export function writeTrace(file, seed, params = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  let buf = []
  const flush = () => { if (buf.length) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = [] } }
  const meta = generateTrace(seed, (isWrite, addr) => { buf.push((isWrite ? 'ST 0x' : 'LD 0x') + addr.toString(16)); if (buf.length >= 65536) flush() }, params)
  flush(); fs.closeSync(fd)
  fs.renameSync(tmp, file)
  fs.writeFileSync(metaPath(file), JSON.stringify(meta, null, 2))
  return meta
}
export const metaPath = (file) => file.replace(/\.trace$/, '') + '.meta.json'
export function readMeta(file) { try { return JSON.parse(fs.readFileSync(metaPath(file), 'utf8')) } catch { return null } }

/** Generates the public trace (seed 1) and the hidden trace (DMI_HIDDEN_SEED, default 13) when missing or when the hidden seed changed. */
export function ensureDramTraces({ publicPath, hiddenPath, publicSeed = 1, hiddenSeed = Number(process.env.DMI_HIDDEN_SEED ?? 13) }) {
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
  console.log(JSON.stringify({ out, seed, lines: meta.lines, reads: meta.reads, writes: meta.writes, ms: Date.now() - t0 }))
}
