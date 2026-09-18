/**
 * DMI challenge harness: a branching and restart heuristic inside one fixed CDCL solver (sat-branching, L2).
 *
 * Shipped to every participant inside the task payload. The SAME code the coordinator runs on the hidden set.
 *
 * Model:
 *   - The solver is the second half of this file. It is fixed: two watched literals, unit propagation,
 *     first-UIP learning with minimization, LBD, backjumping, a learned-clause reduction on a fixed schedule,
 *     and a Luby restart schedule that the submission may replace.
 *   - The submission decides one thing per decision: which literal to branch on. It may also decide when to
 *     restart. Everything else about the search is the same for everybody.
 *   - The instance set is generated from a seed. The public set is seed 1. The hidden set is another seed with
 *     the same families and the same sizes.
 *
 * Objective: conflicts, the total over every instance in the set. Lower is better. It is an integer, it does not
 * depend on the machine, and two runs of the same source give the same number. That is why the score is
 * conflicts and not seconds: a heuristic that is one percent better shows up, and a busy laptop does not.
 *
 * Correctness comes first, always. An instance counts only when the answer is right:
 *   - a satisfiable answer must come with an assignment, and the harness checks that assignment against every
 *     clause of the instance before the conflicts are added to the total
 *   - an unsatisfiable answer must match the status recorded in the instance set, which was produced by the
 *     reference solver and validated against CaDiCaL (see README.md)
 *   One wrong answer, one broken contract, or one instance left undecided inside its budget, and the whole
 *   submission is invalid. There is no partial score.
 *
 * Heuristic contract (CommonJS source, evaluated in an isolated VM):
 *
 *   module.exports = function createHeuristic({ vars, clauses, name, family }) {
 *     return {
 *       decide() {},                     // required. return a literal: 7 is variable 7 true, -7 is false.
 *                                        // the variable must be unassigned, or the submission is invalid.
 *       onAssign(lit, level) {},         // every assignment, decision and propagation, in trail order
 *       onUnassign(v) {},                // every unassignment during a backjump, in reverse trail order
 *       onConflict(level, conflicts) {}, // at each conflict, before analysis
 *       onAnalyze(v, level) {},          // every variable conflict analysis touches, once per conflict.
 *                                        // this is the whole conflict side, not just the learned clause.
 *       onLearn(lits, lbd, backjump) {}, // the learned clause, its LBD and the level jumped back to
 *       restart(conflicts, lbd, backjump) {}, // optional. return true to restart now. defining it replaces
 *                                            // the solver's Luby schedule with yours.
 *     }
 *   }
 *
 *   A fresh heuristic is built for every instance, so nothing carries over between instances.
 *   `clauses` is the instance, as an array of arrays of signed literals. `vars` is the variable count.
 *   The only inputs are these. The context has no require, no filesystem, no network, no timers, no Date and
 *   no Math.random, so the search is a function of the instance and nothing else.
 *
 * Time budget: 90 s for the whole set. The baseline takes about 3 s of CPU on a laptop.
 */
import vm from 'node:vm'
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------------------------------------------
// The fixed CDCL solver. Everything from here to the end of solve() is the same for every participant and does not
// change inside a season, because the score is the number of conflicts it takes and any change to the search would
// move every score at once. It lives in this file so a participant can run the scorer with nothing else on disk.
//
// Determinism: no time, no randomness, no hash iteration order. The same heuristic on the same instance gives the
// same conflict count on every machine. That is the whole reason the objective is conflicts and not seconds.
//
// Literals are signed integers: 3 is variable 3 true, -3 is variable 3 false. Variables are 1..vars.
// ---------------------------------------------------------------------------------------------------------------

/** Literal to a dense non-negative index: v>0 -> 2v, v<0 -> 2v+1. */
const idx = (lit) => (lit > 0 ? lit << 1 : ((-lit) << 1) | 1)

/** Luby sequence, 1-indexed: 1 1 2 1 1 2 4 1 1 2 1 1 2 4 8 ... The same recurrence MiniSat uses. */
export function luby(i) {
  let x = i - 1
  let size = 1, seq = 0
  while (size < x + 1) { seq++; size = 2 * size + 1 }
  while (size - 1 !== x) { size = (size - 1) >> 1; seq--; x %= size }
  return 1 << seq
}

export const DEFAULTS = {
  /** Conflicts between learned-clause reductions. */
  reduceInterval: 2000,
  /** Growth added to the interval after each reduction. */
  reduceGrowth: 300,
  /** Conflicts in the first Luby run when the submission does not define restart(). */
  lubyUnit: 256,
  /** Learned clauses at or below this LBD survive every reduction. */
  keepLbd: 3,
}

export class SolverError extends Error {}

/**
 * Solves one instance with one heuristic.
 *
 * @param inst      { vars, clauses } where clauses is an array of arrays of signed literals
 * @param heuristic { decide, onAssign?, onUnassign?, onConflict?, onAnalyze?, onLearn?, restart? }
 * @param limits    { maxConflicts, maxPropagations, deadlineAt? (Date.now() ms), tuning? }
 * @returns { status: 'SAT'|'UNSAT', model?: Int8Array, conflicts, decisions, propagations, restarts, learned, maxLevel, decisionHash }
 *
 * Throws SolverError when a limit is reached or the heuristic breaks its contract. The caller turns that into an
 * invalid submission; it never turns into a score.
 */
export function solve(inst, heuristic, limits = {}) {
  const nv = inst.vars
  const cfg = { ...DEFAULTS, ...(limits.tuning ?? {}) }
  const maxConflicts = limits.maxConflicts ?? Infinity
  const maxPropagations = limits.maxPropagations ?? Infinity
  const deadlineAt = limits.deadlineAt ?? Infinity

  if (typeof heuristic?.decide !== 'function') throw new SolverError('heuristic is missing decide()')
  const hasAssign = typeof heuristic.onAssign === 'function'
  const hasUnassign = typeof heuristic.onUnassign === 'function'
  const hasConflict = typeof heuristic.onConflict === 'function'
  const hasAnalyze = typeof heuristic.onAnalyze === 'function'
  const hasLearn = typeof heuristic.onLearn === 'function'
  const hasRestart = typeof heuristic.restart === 'function'

  // Clause store. clauses[i] is an Int32Array of literals; clauses[i][0] and [1] are the watched pair.
  const clauses = []
  const lbd = []              // learned clause LBD, 0 for an original clause
  const learnedAt = []        // conflict number the clause was learned at, -1 for an original clause
  const watches = new Array((nv + 1) * 2)
  for (let i = 0; i < watches.length; i++) watches[i] = []

  const assign = new Int8Array(nv + 1)      // 0 unassigned, 1 true, -1 false
  const level = new Int32Array(nv + 1)
  const reason = new Int32Array(nv + 1).fill(-1)
  const trail = new Int32Array(nv + 1)
  let trailSize = 0, qhead = 0
  const trailLim = []
  const seen = new Uint8Array(nv + 1)

  let conflicts = 0, decisions = 0, propagations = 0, restarts = 0, maxLevel = 0
  let dh = 2166136261                       // fingerprint of the decision sequence
  const decisionLevel = () => trailLim.length

  const value = (lit) => (lit > 0 ? assign[lit] : -assign[-lit])

  function attach(ci) {
    const c = clauses[ci]
    watches[idx(c[0])].push(ci)
    watches[idx(c[1])].push(ci)
  }

  function enqueue(lit, from) {
    const v = lit > 0 ? lit : -lit
    assign[v] = lit > 0 ? 1 : -1
    level[v] = decisionLevel()
    reason[v] = from
    trail[trailSize++] = lit
    if (hasAssign) heuristic.onAssign(lit, level[v])
  }

  /** Unit propagation. Returns the conflicting clause index, or -1. */
  function propagate() {
    let confl = -1
    while (qhead < trailSize) {
      const p = trail[qhead++]
      propagations++
      // Clauses that watch -p: -p is false now.
      const ws = watches[idx(-p)]
      let keep = 0
      for (let k = 0; k < ws.length; k++) {
        const ci = ws[k]
        const c = clauses[ci]
        // Put the false literal in slot 1.
        if (c[0] === -p) { c[0] = c[1]; c[1] = -p }
        const first = c[0]
        if (value(first) === 1) { ws[keep++] = ci; continue }
        let found = -1
        for (let j = 2; j < c.length; j++) if (value(c[j]) !== -1) { found = j; break }
        if (found >= 0) {
          c[1] = c[found]; c[found] = -p
          watches[idx(c[1])].push(ci)
          continue                                   // dropped from this list
        }
        ws[keep++] = ci
        if (value(first) === -1) {                   // conflict: every literal is false
          confl = ci
          qhead = trailSize
          for (let j = k + 1; j < ws.length; j++) ws[keep++] = ws[j]
          ws.length = keep
          return confl
        }
        enqueue(first, ci)
      }
      ws.length = keep
      if (propagations > maxPropagations) throw new SolverError(`propagation budget of ${maxPropagations} exhausted`)
    }
    return confl
  }

  function backtrack(to) {
    if (decisionLevel() <= to) return
    const from = trailLim[to]
    for (let i = trailSize - 1; i >= from; i--) {
      const v = trail[i] > 0 ? trail[i] : -trail[i]
      assign[v] = 0
      reason[v] = -1
      level[v] = 0
      if (hasUnassign) heuristic.onUnassign(v)
    }
    trailSize = from
    qhead = from
    trailLim.length = to
  }

  /** First-UIP analysis. Returns { lits, lbd, backjump }. lits[0] is the UIP literal. */
  function analyze(confl) {
    const cur = decisionLevel()
    const out = [0]
    const cleared = []
    let pathC = 0, p = 0, i = trailSize - 1
    let c = clauses[confl]
    for (;;) {
      for (let j = p === 0 ? 0 : 1; j < c.length; j++) {
        const q = c[j]
        const v = q > 0 ? q : -q
        if (seen[v] || level[v] === 0) continue
        seen[v] = 1; cleared.push(v)
        if (hasAnalyze) heuristic.onAnalyze(v, level[v])
        if (level[v] >= cur) pathC++
        else out.push(q)
      }
      while (i >= 0) { const t = trail[i]; if (seen[t > 0 ? t : -t]) break; i-- }
      if (i < 0) throw new SolverError('conflict analysis walked off the trail')
      p = trail[i--]
      const pv = p > 0 ? p : -p
      seen[pv] = 0
      pathC--
      if (pathC <= 0) break
      const r = reason[pv]
      if (r < 0) throw new SolverError('conflict analysis reached a decision with a path still open')
      c = clauses[r]
    }
    out[0] = -p

    // Minimization: drop a literal whose reason clause is entirely made of literals already in `out`.
    if (out.length > 1) {
      let keep = 1
      for (let k = 1; k < out.length; k++) {
        const v = out[k] > 0 ? out[k] : -out[k]
        const r = reason[v]
        let redundant = r >= 0
        if (redundant) {
          const rc = clauses[r]
          for (let j = 1; j < rc.length; j++) {
            const u = rc[j] > 0 ? rc[j] : -rc[j]
            if (!seen[u] && level[u] !== 0) { redundant = false; break }
          }
        }
        if (!redundant) out[keep++] = out[k]
      }
      out.length = keep
    }

    // LBD, then move the highest-level literal into slot 1 so the watch pair is right after the backjump.
    let backjump = 0, at = 1
    const levels = new Set()
    for (let k = 1; k < out.length; k++) {
      const v = out[k] > 0 ? out[k] : -out[k]
      levels.add(level[v])
      if (level[v] > backjump) { backjump = level[v]; at = k }
    }
    if (out.length > 1) { const t = out[1]; out[1] = out[at]; out[at] = t }
    for (const v of cleared) seen[v] = 0
    return { lits: out, lbd: levels.size + 1, backjump }
  }

  /** Drops half of the removable learned clauses, worst LBD first. Deterministic: ties break on age. */
  function reduceDB() {
    const locked = new Uint8Array(clauses.length)
    for (let v = 1; v <= nv; v++) if (assign[v] !== 0 && reason[v] >= 0) locked[reason[v]] = 1
    const cand = []
    for (let ci = 0; ci < clauses.length; ci++) {
      if (learnedAt[ci] < 0 || locked[ci] || clauses[ci].length <= 2 || lbd[ci] <= cfg.keepLbd) continue
      cand.push(ci)
    }
    cand.sort((a, b) => (lbd[b] - lbd[a]) || (learnedAt[a] - learnedAt[b]))
    const drop = new Uint8Array(clauses.length)
    for (let k = 0; k < cand.length >> 1; k++) drop[cand[k]] = 1
    if (!(cand.length >> 1)) return
    const remap = new Int32Array(clauses.length).fill(-1)
    const kept = [], keptLbd = [], keptAt = []
    for (let ci = 0; ci < clauses.length; ci++) {
      if (drop[ci]) continue
      remap[ci] = kept.length
      kept.push(clauses[ci]); keptLbd.push(lbd[ci]); keptAt.push(learnedAt[ci])
    }
    clauses.length = 0; lbd.length = 0; learnedAt.length = 0
    for (let k = 0; k < kept.length; k++) { clauses.push(kept[k]); lbd.push(keptLbd[k]); learnedAt.push(keptAt[k]) }
    for (let v = 1; v <= nv; v++) if (reason[v] >= 0) reason[v] = remap[reason[v]]
    for (let i = 0; i < watches.length; i++) watches[i].length = 0
    for (let ci = 0; ci < clauses.length; ci++) attach(ci)
  }

  // Load the instance. A tautological clause is dropped, a duplicate literal collapsed, an empty clause ends it.
  for (const raw of inst.clauses) {
    const lits = []
    let taut = false
    for (const l of raw) {
      if (lits.includes(l)) continue
      if (lits.includes(-l)) { taut = true; break }
      lits.push(l)
    }
    if (taut) continue
    if (lits.length === 0) return done('UNSAT')
    if (lits.length === 1) {
      const v = lits[0] > 0 ? lits[0] : -lits[0]
      if (assign[v] === 0) enqueue(lits[0], -1)
      else if (value(lits[0]) === -1) return done('UNSAT')
      continue
    }
    clauses.push(Int32Array.from(lits)); lbd.push(0); learnedAt.push(-1)
    attach(clauses.length - 1)
  }

  function done(status) {
    const out = { status, conflicts, decisions, propagations, restarts, learned: 0, maxLevel, decisionHash: (dh >>> 0).toString(16) }
    if (status === 'SAT') { out.model = Int8Array.from(assign) }
    return out
  }

  if (propagate() !== -1) return done('UNSAT')

  let nextReduce = cfg.reduceInterval, reductions = 0
  let lubyRun = 1, lubyLimit = cfg.lubyUnit * luby(1), sinceRestart = 0
  let learnedTotal = 0

  for (;;) {
    const confl = propagate()
    if (confl !== -1) {
      conflicts++
      sinceRestart++
      if (decisionLevel() === 0) { const r = done('UNSAT'); r.learned = learnedTotal; return r }
      if (hasConflict) heuristic.onConflict(decisionLevel(), conflicts)
      const a = analyze(confl)
      backtrack(a.backjump)
      if (a.lits.length === 1) {
        if (value(a.lits[0]) === -1) { const r = done('UNSAT'); r.learned = learnedTotal; return r }
        if (value(a.lits[0]) === 0) enqueue(a.lits[0], -1)
      } else {
        clauses.push(Int32Array.from(a.lits)); lbd.push(a.lbd); learnedAt.push(conflicts)
        attach(clauses.length - 1)
        enqueue(a.lits[0], clauses.length - 1)
      }
      learnedTotal++
      if (hasLearn) heuristic.onLearn(Array.from(a.lits), a.lbd, a.backjump)

      let wantRestart
      if (hasRestart) {
        wantRestart = heuristic.restart(conflicts, a.lbd, a.backjump)
        if (typeof wantRestart !== 'boolean') throw new SolverError(`restart() must return a boolean, got ${typeof wantRestart}`)
      } else {
        wantRestart = sinceRestart >= lubyLimit
      }
      if (wantRestart) {
        if (decisionLevel() > 0) { backtrack(0); restarts++ }
        sinceRestart = 0
        lubyLimit = cfg.lubyUnit * luby(++lubyRun)
      }
      // The reduction schedule counts reductions, not restarts, so a submission's restart policy cannot move it.
      if (conflicts >= nextReduce) { reduceDB(); nextReduce = conflicts + cfg.reduceInterval + cfg.reduceGrowth * ++reductions }
      if (conflicts > maxConflicts) throw new SolverError(`conflict budget of ${maxConflicts} exhausted`)
      if (Date.now() > deadlineAt) throw new SolverError('time budget exhausted')
      continue
    }

    // No conflict: every clause is satisfied or the heuristic picks the next branch.
    if (trailSize === nv) { const r = done('SAT'); r.learned = learnedTotal; return r }
    const lit = heuristic.decide()
    if (!Number.isInteger(lit) || lit === 0 || lit > nv || lit < -nv) throw new SolverError(`decide() must return a literal in [-${nv}, ${nv}] without 0, got ${String(lit)}`)
    const v = lit > 0 ? lit : -lit
    if (assign[v] !== 0) throw new SolverError(`decide() returned literal ${lit}, but variable ${v} is already assigned`)
    decisions++
    dh = (Math.imul(dh ^ (lit + nv), 16777619) >>> 0)
    trailLim.push(trailSize)
    if (trailLim.length > maxLevel) maxLevel = trailLim.length
    enqueue(lit, -1)
  }
}

/** True when `model` (an Int8Array indexed by variable, 1 or -1) satisfies every clause of `inst`. */
export function modelSatisfies(inst, model) {
  if (!model || model.length < inst.vars + 1) return false
  for (let v = 1; v <= inst.vars; v++) if (model[v] !== 1 && model[v] !== -1) return false
  for (const c of inst.clauses) {
    let sat = false
    for (const l of c) { if (l > 0 ? model[l] === 1 : model[-l] === -1) { sat = true; break } }
    if (!sat) return false
  }
  return true
}


/**
 * Per-instance work caps. A heuristic that blows through one of these leaves the instance undecided, which is
 * invalid, not a bad score. Both are deterministic, so a submission is invalid on every machine or on none.
 * 100,000 conflicts is about four times the worst single instance the baseline meets (25,735 on the public set),
 * so a heuristic has to be far worse than the baseline on one formula before it hits the cap.
 */
export const MAX_CONFLICTS_PER_INSTANCE = 100_000
export const MAX_PROPAGATIONS_PER_INSTANCE = 50_000_000

/** The parts of the search the submission does not control. Published so a participant can reason about the solver. */
export const SOLVER = { ...DEFAULTS, learning: 'first-UIP with self-subsuming minimization', watches: 2, restartDefault: 'Luby' }

// Static denylist, the same one kv-cache-real uses: none of these are needed by a branching heuristic and every
// known vm escape goes through one of them. node:vm is a fault boundary, not a security boundary, so the real
// boundary is the child process the evaluator runs this in, with no child processes and no filesystem of its own.
const FORBIDDEN = /\b(constructor|__proto__|prototype|process|require|import|Function|eval|globalThis|Reflect|Proxy|WebAssembly|Atomics|SharedArrayBuffer|arguments\.callee)\b|\bthis\s*\.\s*constructor/

export function loadPolicySource(source, { timeoutMs = 2000 } = {}) {
  if (typeof source !== 'string' || source.length > 200_000) throw new Error('heuristic source must be a string under 200 KB')
  const hit = source.match(FORBIDDEN)
  if (hit) throw new Error(`heuristic uses a forbidden identifier: ${hit[0]}`)
  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext('var module = { exports: {} }; var exports = module.exports; var console = { log: function () {} };', ctx)
  // The score is a conflict count, so the search has to be a function of the instance and nothing else. A vm
  // context comes with Date and Math.random; both are taken away here. Without them a heuristic cannot make a
  // decision that two runs would disagree on, and the reproduction step is not left to catch it after the fact.
  vm.runInContext('delete this.Date; Math.random = function () { throw new Error("Math.random is not available: the search must be deterministic") };', ctx)
  vm.runInContext(source, ctx, { timeout: timeoutMs, filename: 'heuristic.js' })
  const factory = vm.runInContext('module.exports', ctx)
  if (typeof factory !== 'function') throw new Error('heuristic must assign a factory function to module.exports')
  return factory
}

/**
 * Scores one heuristic against one instance set.
 *
 * @param set     what loadTrace() returns
 * @param factory what loadPolicySource() returns
 * @returns { conflicts, decisions, propagations, restarts, instances: [...], fingerprint, ... }
 */
export function simulate(set, factory, { stepBudgetMs = 90000 } = {}) {
  if (typeof factory !== 'function') throw new Error('heuristic must be a factory function')
  const started = Date.now()
  const cpu0 = process.cpuUsage()
  const deadlineAt = started + stepBudgetMs
  let conflicts = 0, decisions = 0, propagations = 0, restarts = 0, learned = 0
  let fp = 2166136261
  const rows = []

  for (const inst of set.instances) {
    const heuristic = factory({ vars: inst.vars, clauses: inst.clauses, name: inst.name, family: inst.family })
    if (!heuristic || typeof heuristic.decide !== 'function') throw new Error(`${inst.name}: the factory must return an object with decide()`)
    let r
    try {
      r = solve(inst, heuristic, { maxConflicts: MAX_CONFLICTS_PER_INSTANCE, maxPropagations: MAX_PROPAGATIONS_PER_INSTANCE, deadlineAt })
    } catch (e) {
      if (e instanceof SolverError) throw new Error(`${inst.name}: ${e.message}`)
      throw new Error(`${inst.name}: heuristic threw ${String(e?.message ?? e)}`)
    }

    // Correctness gate. Nothing is added to the total until the answer is proved right.
    if (r.status === 'SAT') {
      if (!modelSatisfies(inst, r.model)) throw new Error(`${inst.name}: the assignment does not satisfy the clauses`)
      if (inst.status === 'UNSAT') throw new Error(`${inst.name}: recorded unsatisfiable, but a checked assignment was found; the instance set is wrong`)
    } else if (inst.status === 'SAT') {
      throw new Error(`${inst.name}: answered unsatisfiable on a satisfiable instance`)
    }
    if (inst.status && inst.status !== r.status) throw new Error(`${inst.name}: answered ${r.status}, recorded ${inst.status}`)

    conflicts += r.conflicts; decisions += r.decisions; propagations += r.propagations
    restarts += r.restarts; learned += r.learned
    fp = Math.imul(fp ^ r.conflicts, 16777619) >>> 0
    for (let i = 0; i < r.decisionHash.length; i++) fp = Math.imul(fp ^ r.decisionHash.charCodeAt(i), 16777619) >>> 0
    rows.push({ name: inst.name, family: inst.family, vars: inst.vars, clauses: inst.clauses.length, status: r.status, conflicts: r.conflicts, decisions: r.decisions, propagations: r.propagations, restarts: r.restarts, maxLevel: r.maxLevel })
    if (Date.now() > deadlineAt) throw new Error(`heuristic exceeded the time budget of ${stepBudgetMs} ms`)
  }

  const cpu = process.cpuUsage(cpu0)
  return {
    conflicts, decisions, propagations, restarts, learned,
    instances: rows,
    sat: rows.filter((r) => r.status === 'SAT').length,
    unsat: rows.filter((r) => r.status === 'UNSAT').length,
    /** Hash of every instance's conflict count and decision sequence. Two heuristics with the same fingerprint search the same way. */
    fingerprint: fp.toString(16),
    wallMs: Date.now() - started,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
  }
}

/** An instance set is a JSON file, optionally gzipped. */
export function loadTrace(file) {
  const buf = fs.readFileSync(file)
  const set = JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8'))
  if (!Array.isArray(set?.instances) || !set.instances.length) throw new Error(`${file} holds no instances`)
  for (const inst of set.instances) {
    if (!Number.isInteger(inst.vars) || inst.vars < 1 || !Array.isArray(inst.clauses)) throw new Error(`instance ${inst.name} is malformed`)
    if (inst.status !== 'SAT' && inst.status !== 'UNSAT') throw new Error(`instance ${inst.name} has no recorded status`)
  }
  return set
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const [file, setFile = path.join(here, 'public-instances.json')] = process.argv.slice(2)
  if (!file) { console.error('usage: node harness.js <heuristic.js> [instances.json]'); process.exit(2) }
  console.log(JSON.stringify(simulate(loadTrace(setFile), loadPolicySource(fs.readFileSync(file, 'utf8'))), null, 2))
}
