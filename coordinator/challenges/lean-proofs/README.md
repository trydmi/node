# lean-proofs: automated theorem proving in Lean 4

**Level:** L2. **Objective:** `unsolved`, lower is better. **Time budget:** 300 s for all forty goals.
**Tools:** Lean 4.33, core only, no mathlib.

## What the challenge is

You submit a tactic, not a proof.

Your tactic is compiled against forty Lean statements you have never seen, one at a time, and scored
on how many it leaves open. Because the hidden set is different statements from the public one, a
lookup table of answers is worth nothing. Only something that generalises scores.

## How a goal is counted

A goal counts as closed when both hold:

1. Lean compiled the theorem with no error.
2. `#print axioms` on it lists nothing outside Lean's own three: `propext`, `Classical.choice`,
   `Quot.sound`.

The second check is the one that matters. Compiling proves nothing on its own, because these all
compile and all get rejected:

| What a tactic tries | What `#print axioms` says |
| --- | --- |
| `sorry` | `depends on axioms: [sorryAx]` |
| an axiom you declared | `depends on axioms: [yourAxiom]` |
| `native_decide` | `depends on axioms: [t._native.native_decide.ax_1_1]` |

A tactic that quietly fails is the same case: Lean inserts `sorryAx` for the unproved goal, the
axiom list gives it away, and it scores nothing.

## What a submission is

One Lean file that defines a tactic named `dmi_auto`. The baseline:

```lean
macro "dmi_auto" : tactic => `(tactic| first | rfl | simp)
```

It is applied to every goal unchanged. Nothing else in your file runs.

## The statements

Generated from a seed, forty per set. Public seed 1, and the hidden set uses a different one.

| Family | Needs |
| --- | --- |
| Arithmetic identities, distribution and reassociation | little more than `simp` |
| List identities: append, reverse, length | the simp set already knows most of these |
| Length arithmetic across repeated appends | a rewrite, then arithmetic |
| Modular arithmetic under a hypothesis | `omega`, and getting the hypothesis into it |
| Monotonicity and bounds | `omega` after the right setup |
| Identities over a recursive definition | a real induction, which no chain of `simp` and `omega` reaches |

Every generated statement is checked provable before it ships
(`node scripts/dev/verify-lean-problems.mjs`). Nobody is asked for the impossible.

## Rules

Checked before Lean runs. Breaking one is an invalid submission with a message saying which.

- At most 64 KB of source.
- Defines a tactic named `dmi_auto`.
- No `sorry`, no `axiom`, no `native_decide`, no `@[implemented_by]`, no `unsafe`, no `IO`, no `#eval`.
- No `import` outside core Lean. There is no mathlib on the image, and every hidden statement is
  provable without it.

A banned word inside a comment is not a rule break.

## Measured numbers (Apple silicon laptop, Lean 4.33.1)

| Tactic | Closed | Of the hard ones | Time |
| --- | --- | --- | --- |
| `baseline.lean`, `first \| rfl \| simp` | 3 of 40 | 1 of 29 | 0.8 s |
| `examples/lean-chain.lean` | 31 of 40 | 20 of 29 | 0.9 s |

Nine goals are still open on the public set. They are the ones over recursive definitions, which
need an induction rather than a chain of decision procedures.

## Running it locally

```bash
curl -sSfL https://elan.lean-lang.org/elan-init.sh | sh    # installs Lean
node coordinator/challenges/lean-proofs/gen-problems.mjs --seed 1 --count 40 --out /tmp/p.json
node coordinator/challenges/lean-proofs/harness.js coordinator/challenges/lean-proofs/baseline.lean /tmp/p.json
node coordinator/challenges/lean-proofs/harness.js examples/lean-chain.lean /tmp/p.json
```

`node --test test/lean.test.mjs` runs the challenge tests and skips cleanly without Lean.

## Directions worth trying

- Chaining `simp` into `omega`, which closes a whole family the baseline misses
- Induction on the list argument, which is the only way into the recursive families
- Unfolding a recursive definition before `simp`
- Ordering the cheap tactics first so the time budget lasts
- `simp_all` when there are hypotheses to fold in

## Provenance

Statements from `gen-problems.mjs` in this directory, deterministic from the seed. Prover: Lean 4
(leanprover/lean4, Apache-2.0), core only. The score depends on the simp set, so the version is
pinned and a compute node reports this challenge only on that version.
