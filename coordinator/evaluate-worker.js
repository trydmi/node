/**
 * Child process that scores one policy against one trace.
 * Reads { source, tracePath, stepBudgetMs } as JSON on stdin, prints the result as JSON.
 * Runs in its own process so a runaway or crashing policy cannot take the coordinator down.
 */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', async () => {
  try {
    const { source, tracePath, harnessPath, stepBudgetMs = 10000 } = JSON.parse(input)
    const { loadPolicySource, simulate, loadTrace } = await import(pathToFileURL(harnessPath).href)
    const factory = loadPolicySource(source)
    const result = simulate(loadTrace(tracePath), factory, { stepBudgetMs })
    process.stdout.write(JSON.stringify({ ok: true, result }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
    process.exitCode = 1
  }
})
