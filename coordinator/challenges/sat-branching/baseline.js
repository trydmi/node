/**
 * Baseline heuristic for the sat-branching challenge: plain VSIDS, negative phase, no restart policy.
 *
 * Every variable has an activity. A conflict bumps the activities of the variables in the learned clause and
 * then makes the next bump slightly larger, which is the usual way to decay the old scores without touching
 * every variable. The branch is the unassigned variable with the highest activity, always taken false, which
 * is what MiniSat did before phase saving.
 *
 * It defines no restart(), so the solver runs its own Luby schedule.
 *
 * Score on the public instance set is in README.md. Beat it.
 */
module.exports = function createHeuristic({ vars }) {
  const activity = new Float64Array(vars + 1)
  const assigned = new Uint8Array(vars + 1)
  let inc = 1
  const decay = 0.95
  const RESCALE = 1e100

  return {
    onAssign(lit) {
      assigned[lit > 0 ? lit : -lit] = 1
    },
    onUnassign(v) {
      assigned[v] = 0
    },
    onLearn(lits) {
      for (let i = 0; i < lits.length; i++) {
        const v = lits[i] > 0 ? lits[i] : -lits[i]
        activity[v] += inc
      }
      inc /= decay
      if (inc > RESCALE) {
        for (let v = 1; v <= vars; v++) activity[v] /= RESCALE
        inc /= RESCALE
      }
    },
    decide() {
      let best = 0, bestA = -1
      for (let v = 1; v <= vars; v++) {
        if (assigned[v]) continue
        if (activity[v] > bestA) { bestA = activity[v]; best = v }
      }
      return -best
    },
  }
}
