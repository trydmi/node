/**
 * Deterministic workload generator for the KV-cache eviction challenge.
 *
 * Same generator, different seed = the public/hidden split. The public trace
 * (seed 1) is committed so participants can score locally. The hidden trace is
 * generated at coordinator start from DMI_HIDDEN_SEED and never leaves the
 * coordinator.
 *
 * Workload shape (agentic, batch-1 style decode):
 *   - A shared system-prompt prefix of `sharedBlocks` blocks read by everyone.
 *   - `numSeqs` conversations arrive over time. Each has its own prompt prefix,
 *     then decodes `steps` tokens, appending a block every `blockTokens` tokens.
 *   - Only `concurrency` conversations are active at once; others queue.
 *   - When a conversation finishes a turn the engine emits `finish`. A fraction
 *     `returnRate` of them come back after a gap for another turn and re-read
 *     all of their earlier blocks (multi-turn prefix reuse).
 *
 * Usage: node gen-trace.js [seed] [outFile]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PARAMS = {
  capacity: 300, // blocks (tuned 2026-09-07: LRU hit ~93-97%, dead-first beats it 3-8%, scores in <1 s)
  blockBytes: 2 * 1024 * 1024, // 2 MiB per block (16 tokens of KV at fp16 for a ~7B model, roughly)
  blockTokens: 16,
  sharedBlocks: 12,
  numSeqs: 140,
  concurrency: 8,
  promptBlocksMin: 6,
  promptBlocksMax: 30,
  stepsMin: 40,
  stepsMax: 200,
  returnRate: 0.4,
  returnGapMin: 30,
  returnGapMax: 300,
  maxTurns: 3,
}

/** mulberry32: small, fast, deterministic PRNG. */
export function rng(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateTrace(seed, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params }
  const rand = rng(seed)
  const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))

  const shared = Array.from({ length: p.sharedBlocks }, (_, i) => i)
  const events = []
  let t = 0

  // Each pending turn: { seq, promptBlocks, stepsLeft, blocks, readyAt, turn }
  const queue = []
  for (let s = 0; s < p.numSeqs; s++) {
    const promptBlocks = randInt(p.promptBlocksMin, p.promptBlocksMax)
    queue.push({
      seq: `s${s}`,
      readyAt: Math.floor((s * 60) / p.concurrency) + randInt(0, 20),
      stepsLeft: randInt(p.stepsMin, p.stepsMax),
      blocks: Array.from({ length: promptBlocks }, (_, i) => i),
      tokensSinceBlock: 0,
      turn: 1,
      step: 0,
    })
  }
  const active = []

  while (queue.length || active.length) {
    // Admit ready sequences up to concurrency, earliest-ready first.
    queue.sort((a, b) => a.readyAt - b.readyAt)
    while (active.length < p.concurrency && queue.length && queue[0].readyAt <= t) {
      active.push(queue.shift())
    }
    if (!active.length) {
      t = queue[0].readyAt
      continue
    }
    // Round-robin one decode step per active sequence.
    for (let i = 0; i < active.length; i++) {
      const a = active[i]
      t++
      // Every step reads the shared prefix + all of this sequence's blocks.
      events.push({ type: 'step', t, seq: 'shared', step: a.step, tokens: 0, nblocks: shared.length })
      events.push({ type: 'step', t, seq: a.seq, step: a.step, tokens: 1, nblocks: a.blocks.length })
      a.step++
      a.stepsLeft--
      a.tokensSinceBlock++
      if (a.tokensSinceBlock >= p.blockTokens) {
        a.blocks.push(a.blocks.length)
        a.tokensSinceBlock = 0
      }
      if (a.stepsLeft <= 0) {
        events.push({ type: 'finish', t, seq: a.seq })
        active.splice(i, 1)
        i--
        if (a.turn < p.maxTurns && rand() < p.returnRate) {
          queue.push({
            ...a,
            readyAt: t + randInt(p.returnGapMin, p.returnGapMax),
            stepsLeft: randInt(p.stepsMin, p.stepsMax),
            turn: a.turn + 1,
          })
        }
      }
    }
  }

  return {
    challenge: 'kv-cache-eviction',
    seed,
    capacity: p.capacity,
    blockBytes: p.blockBytes,
    blockTokens: p.blockTokens,
    params: p,
    events,
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const seed = Number(process.argv[2] ?? 1)
  const out = process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'public-trace.json')
  const trace = generateTrace(seed)
  fs.writeFileSync(out, JSON.stringify(trace))
  console.log(`wrote ${out}: ${trace.events.length} events, seed ${seed}`)
}
