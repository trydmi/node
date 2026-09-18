#!/usr/bin/env node
/**
 * Stimulus for the rtl-synth-fifo challenge: a seeded push and pop sequence with backpressure.
 *
 * One line per clock: "<push><pop> <hex>", where push and pop are 0 or 1 and hex is the 32-bit word on din.
 * The testbench (tb.cpp) drives the line onto the module, and the golden model decides what the module must
 * answer. Phases with different push and pop probabilities make the FIFO fill, drain, sit at the edges and
 * take pushes and pops in the same cycle. Deterministic from the seed: same seed, same bytes.
 *
 *   node gen-trace.mjs --seed 1 --out public-trace.trace
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PARAMS = {
  cycles: 100_000,           // clocks in the trace, after reset
  phaseMinCycles: 40,
  phaseMaxCycles: 400,
  // push probability, pop probability per phase kind
  phases: {
    fill: [0.9, 0.1],        // runs the FIFO up to full and holds it there
    drain: [0.1, 0.9],       // runs it down to empty and holds it there
    balanced: [0.5, 0.5],    // random traffic around the middle
    stream: [1.0, 1.0],      // push and pop every cycle
    trickle: [0.3, 0.3],     // sparse traffic
    hammer: [1.0, 0.0],      // push every cycle until full, then keep pushing into a full FIFO
    bleed: [0.0, 1.0],       // pop every cycle, then keep popping an empty FIFO
  },
  specialShare: 0.05,        // share of words that are 0, all ones, or a single set bit
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

/** Streams the stimulus to `emit(push, pop, word)`. Returns counts. */
export function generateTrace(seed, emit, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params, phases: { ...DEFAULT_PARAMS.phases, ...(params.phases ?? {}) } }
  const r = rng(seed)
  const kinds = Object.keys(p.phases)
  const counts = Object.fromEntries(kinds.map((k) => [k, 0]))
  let n = 0, pushes = 0, pops = 0
  const word = () => {
    if (r() < p.specialShare) { const k = randInt(r, 0, 2); return k === 0 ? 0 : k === 1 ? 0xffffffff : (1 << randInt(r, 0, 31)) >>> 0 }
    return (Math.floor(r() * 4294967296)) >>> 0
  }
  while (n < p.cycles) {
    const kind = kinds[randInt(r, 0, kinds.length - 1)]
    counts[kind]++
    const [pp, qp] = p.phases[kind]
    const len = randInt(r, p.phaseMinCycles, p.phaseMaxCycles)
    for (let i = 0; i < len && n < p.cycles; i++) {
      const push = r() < pp ? 1 : 0, pop = r() < qp ? 1 : 0
      pushes += push; pops += pop
      emit(push, pop, word())
      n++
    }
  }
  return { seed, params: p, lines: n, pushes, pops, phases: counts }
}

/** Writes the trace file and a sidecar .meta.json next to it. Returns the meta. */
export function writeTrace(file, seed, params = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  let buf = []
  const flush = () => { if (buf.length) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = [] } }
  const meta = generateTrace(seed, (push, pop, w) => { buf.push(`${push}${pop} ${w.toString(16).padStart(8, '0')}`); if (buf.length >= 65536) flush() }, params)
  flush(); fs.closeSync(fd)
  fs.renameSync(tmp, file)
  fs.writeFileSync(metaPath(file), JSON.stringify(meta, null, 2))
  return meta
}
export const metaPath = (file) => file.replace(/\.trace$/, '') + '.meta.json'
export function readMeta(file) { try { return JSON.parse(fs.readFileSync(metaPath(file), 'utf8')) } catch { return null } }

/** Generates the public trace (seed 1) and the hidden trace (DMI_HIDDEN_SEED, default 13) when missing or when the hidden seed changed. */
export function ensureSynthTraces({ publicPath, hiddenPath, publicSeed = 1, hiddenSeed = Number(process.env.DMI_HIDDEN_SEED ?? 13) }) {
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
  console.log(JSON.stringify({ out, seed, lines: meta.lines, pushes: meta.pushes, pops: meta.pops, phases: meta.phases, ms: Date.now() - t0 }))
}
