/**
 * One evaluation job, run in the locked-down worker. Shared by the evaluator service and by compute nodes
 * (`dmi compute`), which is the evaluator service in client mode. Neither side holds a secret; the job names
 * the challenge and the trace, and the harness path comes from the challenge registry on local disk.
 */
import { runLocal } from './evaluate.js'
import { CHALLENGES } from './challenge.js'

export const jobOpts = (c, stepBudgetMs) => {
  const budget = stepBudgetMs ?? c.timeBudgetMs
  // `tools` travels with the job so the worker resolves only the binaries this challenge asked for.
  return { stepBudgetMs: budget, killAfterMs: c.worker?.killAfterMs ?? Math.max(60000, budget + 15000), worker: c.worker, objective: c.objective, tools: c.tools ?? null }
}

/** { challenge, trace: 'public' | 'hidden', source, stepBudgetMs }. tracePath overrides the registry path (nodes cache traces under their own data dir). */
export async function runJob({ challenge, trace, source, stepBudgetMs }, { tracePath } = {}) {
  const c = CHALLENGES[challenge]
  if (!c) return { ok: false, error: `unknown challenge ${challenge}` }
  const tp = tracePath ?? (trace === 'hidden' ? c.hiddenTrace : c.publicTrace)
  return runLocal(source, tp, c.harness, jobOpts(c, stepBudgetMs))
}
