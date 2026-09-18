# sat-branching: a branching and restart heuristic for a fixed CDCL SAT solver

**Level:** L2. **Objective:** `conflicts`, lower is better.
**Time budget:** 90 s for the whole instance set. The baseline takes about 3 s on a laptop.
**Tools:** none. The solver is in `harness.js` and the instances come out of the generator, so any machine with
Node 22 can run and score this challenge.

## What the challenge is

Every conflict-driven clause-learning solver is the same search with one open question inside it: given a
partial assignment and everything learned so far, which variable do you branch on, and with which polarity.
That one question decides whether a formula takes a thousand conflicts or a million. Solvers spend a decade at
a time on it: VSIDS, phase saving, VMTF, LRB, CHB, restart policies driven by the learned clause quality.

This challenge is that question and nothing else. The solver is fixed and shared. The submission is the part
that chooses.

## What you submit

One CommonJS module. It is handed the formula and returns the hooks the solver calls:

```js
module.exports = function createHeuristic({ vars, clauses, name, family }) {
  return {
    decide() {},                          // required. return a literal: 7 is variable 7 true, -7 is false
    onAssign(lit, level) {},              // every assignment, decision and propagation, in trail order
    onUnassign(v) {},                     // every unassignment during a backjump, in reverse trail order
    onConflict(level, conflicts) {},      // at each conflict, before analysis
    onAnalyze(v, level) {},               // every variable conflict analysis touches, once per conflict
    onLearn(lits, lbd, backjump) {},      // the learned clause, its LBD, and the level jumped back to
    restart(conflicts, lbd, backjump) {}, // optional. true restarts now, and replaces the Luby schedule
  }
}
```

`decide()` must return a literal in `[-vars, vars]` without 0, and the variable must be unassigned. Every hook
except `decide` is optional and costs nothing when you leave it out. A fresh heuristic is built for every
instance, so nothing carries over between instances and `clauses` is the only view you get of the formula.

`onAnalyze` is the interesting one. It fires for every variable conflict analysis touches, which is the whole
conflict side and a much bigger set than the learned clause. It is what a real VSIDS bumps.

## What the solver does, and does not do

The solver is the second half of `harness.js`. It is fixed for everybody and it does not change inside a
season, because the score is the number of conflicts it takes and moving the search would move every score.

- two watched literals, unit propagation, level-0 units
- first-UIP conflict analysis with self-subsuming minimization, LBD on the learned clause
- backjump to the second highest level in the learned clause
- learned-clause reduction every 2000 conflicts plus 300 per reduction so far, worst LBD first, keeping
  reasons and everything at LBD 3 or below
- a Luby restart schedule with a 256-conflict unit, used only when the submission does not define `restart()`

The reduction schedule counts reductions rather than restarts on purpose, so a submission's restart policy
cannot drag the clause database around as a side effect.

There is no preprocessing, no inprocessing, no vivification and no chronological backtracking. Those are all
things a submission cannot reach, so they would only add noise.

## Why the score is conflicts and not seconds

The obvious version of a SAT challenge is: submit a solver, we time it on hidden instances. It is easier to
explain and it is what the SAT competition does. It was not chosen, and the reason is measurable rather than a
matter of taste.

The baseline was run nine times over the public set on an idle laptop:

| | Result |
| --- | --- |
| conflicts, every one of the nine runs | 162,481 |
| wall time, fastest to slowest | 3338 ms to 4695 ms |
| spread, fastest to slowest, against the median | 36.5% |

A timed challenge has to compare scores inside a tolerance band, the way `matmul-cpu` does with its 10 percent
band and hardware classes. On these numbers the noise on one machine is three times that band. Every
improvement smaller than the band is invisible, and the band would have to be wide enough to hide most of the
real work in this problem. Conflicts have neither problem: the number is an integer, it is the same on every
machine, and the two independent runs the coordinator does agree byte for byte.

The second reason is that conflicts are the thing the literature optimizes. A branching heuristic that cuts
conflicts by a third is a real result whether or not the solver it lands in is written in C.

The cost of this choice is real and worth saying: a heuristic that is expensive per decision can cut conflicts
and lose on time, and this challenge will not notice. The 90 s budget is the only thing holding that in check.
A future challenge that pairs a conflict count with a propagation count would close it.

## The objective is a real signal

A score that no honest change moves is not worth having, so the sensitivity was measured before anything
shipped. All of these are the same heuristic with one knob changed, scored on the public set:

| Bumped on | Activity decay | Conflicts | Versus baseline |
| --- | --- | --- | --- |
| learned clause | 0.90 | 165,871 | 2.1% worse |
| learned clause | 0.95 | 162,481 | baseline |
| learned clause | 0.99 | 156,400 | 3.7% better |
| conflict side (`onAnalyze`) | 0.90 | 118,987 | 26.8% better |
| conflict side (`onAnalyze`) | 0.95 | 99,372 | 38.8% better |
| conflict side (`onAnalyze`) | 0.99 | 106,084 | 34.7% better |

Small knobs move the score by single digits and a real change in what gets bumped moves it by a third. The
gains hold across seeds, which is the property that matters for a hidden set: the example heuristic gains
33.1, 36.6, 38.5 and 39.0 percent on seeds 1, 7, 13 and 21.

## The instance set

Twenty four instances, generated from the seed. The public set is seed 1. The hidden set is another seed with
the same four families at the same sizes.

| Family | Count | Shape | Why it is in the set |
| --- | --- | --- | --- |
| `random3` | 9 | 190 variables, ratio 4.267 | The satisfiability threshold. No structure to exploit, so it measures raw decision quality. |
| `random3-unsat` | 5 | 180 variables, ratio 5.0 | Above the threshold, so unsatisfiable. The whole cost is the refutation. |
| `php` | 2 | 8 pigeons into 7 holes, 9 into 8 | Unsatisfiable, and resolution proofs of it are exponential. The one family whose difficulty is understood. |
| `color` | 8 | 4-colouring a 70-node random graph, average degree 8.3 | Structured, near the colourability threshold, with a symmetry a good order can avoid re-deriving. |

Six of the twenty four are satisfiable and eighteen are not. That split is deliberate. A heuristic is allowed
to search on its own inside `decide()`, and on a satisfiable instance a good enough internal search drives the
solver's conflict count toward zero. There is no such shortcut on an unsatisfiable one: the solver still has to
derive the refutation, one conflict at a time. So the satisfiable instances put a floor under how far that
route can go, and on the public set that floor is low. The six satisfiable instances are 29,272 of the
baseline's 162,481 conflicts, 18.0 percent of the total. A heuristic that answered all six with no conflicts at
all and did nothing else would score 18 percent better, which is less than the example gains by branching
better. Most of the score is refutation work and there is no way around it.

Sizes were picked by measuring on four seeds, not by taste. The baseline decides the whole set in 3 to 5 s and
its total lands between 160,000 and 245,000 conflicts, and no single instance is more than a fifth of the
total. A fourteen-instance set was tried first and the same example ranged from 29 to 48 percent on it;
twenty four is where the spread stopped being about which formulas came out of the generator.

Nothing is vendored. The well known competition archives set their redistribution terms per family and per
year, and several of the older ones say nothing at all, so generating from a seed is what can be shipped
without a licence question. It also means a hidden set is one number away.

## Correctness comes first

An instance's conflicts are added to the total only after its answer is proved right.

- A satisfiable answer must come with a full assignment, and the harness walks every clause of the instance
  and checks that the assignment satisfies it. Nothing is counted before that check passes.
- An unsatisfiable answer must match the status recorded in the instance set.

One wrong answer, one broken contract, or one instance left undecided inside its budget voids the whole
submission. There is no partial score.

The recorded statuses are not taken on trust either. The generator solves every instance with the reference
solver and the baseline heuristic and stores what it found, and `--verify` re-checks every status against
CaDiCaL. Every instance in the public set was checked that way, plus 40 freshly generated instances the
generator had never seen, and the answers agreed every time.

## Rules

Checked before the solver runs. Breaking one is an invalid submission with a message that says which rule.

- At most 200 KB of source, one CommonJS module, a factory function on `module.exports`.
- `decide()` must return a literal in `[-vars, vars]` without 0, and the variable must be unassigned.
  Returning an assigned or out-of-range variable is a contract break, not a bad score.
- `restart()`, if defined, must return a boolean.
- No `require`, no filesystem, no network, no timers. The VM has none.
- No `Date` and no `Math.random`. Both are taken out of the context, so the search cannot depend on anything
  but the instance. `Math.random` throws if called.
- The identifiers `constructor`, `prototype`, `__proto__`, `process`, `require`, `import`, `Function`, `eval`,
  `globalThis`, `Reflect`, `Proxy`, `WebAssembly`, `Atomics` and `SharedArrayBuffer` are refused in the source.
- An instance must be decided inside 100,000 conflicts and 50,000,000 propagations. Both caps are
  deterministic, so a submission is invalid on every machine or on none. 100,000 is about four times the worst
  single instance the baseline meets.

The evaluator runs the heuristic in a child process with the Node permission model on: no child processes, and
no filesystem beyond the harness directory and the instance file.

## Measured numbers (Apple silicon laptop, Node 22, public set, seed 1)

| Heuristic | Conflicts | Decisions | Propagations | Wall | Versus baseline |
| --- | --- | --- | --- | --- | --- |
| `baseline.js` | 162,481 | 211,604 | 5,659,946 | 3.1 s | |
| `examples/sat-bump-on-analyze.js` | 108,776 | 130,509 | 3,925,200 | 1.7 s | 33.05% better |

By family:

| Family | Baseline | Example | Gain |
| --- | --- | --- | --- |
| `random3` | 91,559 | 61,492 | 32.8% |
| `random3-unsat` | 30,041 | 15,077 | 49.8% |
| `php` | 16,369 | 20,075 | 22.6% worse |
| `color` | 24,512 | 12,132 | 50.5% |

The example loses on pigeonhole and wins everywhere else. That is the shape of the problem: what helps a
random formula is not what keeps a pigeonhole refutation small, and a submission that treats the two
differently has room the example is leaving on the table. The example is not even the best point among its own
knobs. The sensitivity table above has a 38.8 percent row, which is the same idea with a faster decay and no
phase saving.

## Directions worth trying

- What to bump and how fast to decay. `onAnalyze` beats `onLearn` by a wide margin; the reason-side variables
  one more resolution step out have not been tried here.
- Phase selection. Phase saving on its own makes this solver worse, which is worth understanding rather than
  taking as given.
- A restart policy off the LBD signal. The obvious glucose-style rule loses to plain Luby on this set.
- Static clause analysis before the first conflict. `clauses` is handed over in full and the first few hundred
  decisions are made with no learned clauses at all, so occurrence counts and Jeroslow-Wang style scores are
  free to compute and nothing uses them yet.
- Treating the structured families differently from the random ones. `family` and `name` are in the payload.

## Running it locally

```bash
node coordinator/challenges/sat-branching/gen-instances.mjs --seed 1 --out /tmp/public.json
node coordinator/challenges/sat-branching/harness.js coordinator/challenges/sat-branching/baseline.js
node coordinator/challenges/sat-branching/harness.js examples/sat-bump-on-analyze.js
```

The harness prints the verdict as JSON: total conflicts, decisions, propagations and restarts, a row per
instance, and the fingerprint. `node --test test/sat.test.mjs` runs the challenge tests. Two of them
cross-check answers against CaDiCaL and skip cleanly when it is not installed; `brew install cadical` or
`apt-get install cadical` turns them on, and `DMI_CADICAL_BIN` points at a build somewhere else.

To re-check the statuses of a generated set yourself:

```bash
brew install cadical
node coordinator/challenges/sat-branching/gen-instances.mjs --seed 1 --out /tmp/public.json --verify
```

## Provenance

Instances generated from the seed by `gen-instances.mjs` in this directory. Nothing is vendored, so no
redistribution terms apply. The solver is `harness.js` in this directory, written for this challenge. Every
instance status was cross-checked against CaDiCaL 3.0.1 (arminbiere/cadical, MIT), and `--verify` re-runs that
check. CaDiCaL is a build-time and test-time check only: the score does not depend on it and no scoring machine
needs it installed, so there is no version to pin the way `rtl-synth-fifo` pins Yosys.
