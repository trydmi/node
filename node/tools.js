/**
 * The three DMI tools, shared by the hosted MCP endpoint (coordinator /mcp) and the
 * local stdio node. `api` is whatever backs them: in-process functions on the
 * coordinator, HTTP calls from the stdio node.
 *
 * If `workspace` is given (stdio node on the participant's machine), next_task also
 * writes task.json, README.md, the harness, the baseline and the public trace into
 * <workspace>/<task_id>/ so the agent can iterate with `node harness.js <artifact>`.
 *
 * Nothing here assumes a challenge. The artifact can be a CommonJS policy, a JSON document, a
 * Verilog file or a C++ kernel, and the payload says which: `challenge.artifact` names the file
 * to write and what it is, `baseline_file` and `public_trace_file` name what was written, and
 * every score carries its own objective and unit. An earlier version hardcoded the L1 challenge
 * and told an RTL participant to write policy.js in CommonJS and read bytes per token.
 */
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { openLease, closeLease } from './lease-file.js'

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })

/** Rounds to something readable whatever the objective's scale is. */
const score = (v) => (typeof v !== 'number' ? '?' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Number(v.toFixed(3)).toLocaleString())

/**
 * What the network already learned on this challenge. The coordinator has always sent `corpus`
 * with every lease and nothing wrote it down, so every agent started from zero and the swarm
 * learned nothing from itself. Names, strategies and scores are public; the sources are not.
 */
function tried(task) {
  const rows = (task.corpus ?? []).filter((r) => r && (r.strategy || r.policyName)).slice(-12).reverse()
  const f = task.frontier
  const unit = task.challenge?.unit ? ` ${task.challenge.unit}` : ''
  const head = f?.strategy ? `Current best on this challenge (${f.policy}): ${f.strategy}\n\n` : ''
  if (!rows.length && !head) return ''
  const list = rows.map((r) => {
    const gain = typeof r.gainVsBaselinePct === 'number' ? `${r.gainVsBaselinePct > 0 ? '+' : ''}${r.gainVsBaselinePct}% vs baseline` : r.verdict
    return `- ${r.policyName}: ${(r.strategy || 'no strategy noted').slice(0, 160)} (${gain})`
  }).join('\n')
  return `## What has already been tried\n${head}${list ? `${list}\n\nDo not repeat one of these. Identical behaviour earns nothing.\n` : ''}\n`
}

/** The README for a build task: what to fill, how it is checked, what pays. */
export function buildReadme(task) {
  const b = task.build, c = task.challenge
  const fields = b.schema.fields.map((f) => `- \`${f.name}\` (${f.type}${f.required ? ', required' : ''})${f.note ? `: ${f.note}` : ''}`).join('\n')
  return `# ${c.title}\n\n${c.summary}\n\n## What to do\n\n${b.instructions}\n\n## Targets\n\n${b.targets.length} in targets.json. One row per target.\n\n## The row\n\n${fields}\n\n## How it is checked\n\nEvery row is checked when you submit: the shape, the formats, DNS on the domain, and whether the pages you cite carry the names you give. A row that passes is verified and pays ${b.points_per_row} point now. When another agent, working on its own, returns the same facts for the same target, both rows are confirmed and you earn ${b.confirm_bonus} more. A row already on file pays nothing. Up to ${b.rows_per_day} paid rows a day on this challenge.\n\n## Submit\n\nWrite rows.json as a JSON array, then submit({ task_id: "${task.task_id}", rows_path: ".../rows.json" }).\n`
}

export function taskReadme(task) {
  const c = task.challenge
  // No guessing. The coordinator refuses to start with a challenge that does not name its artifact
  // (coordinator/challenge.js, assertDescribed), so a blank here means an old coordinator, and saying
  // so is better than repeating the first challenge's answer at someone working a different one.
  const art = c.artifact?.file ?? 'the artifact this challenge asks for'
  const what = c.artifact?.what ?? 'described in the constraints below'
  const unit = c.unit ? ` ${c.unit}` : ''
  const baselineFile = task.baseline_file ?? 'the baseline file'
  const traceFile = task.public_trace_file ?? 'the public data file'
  return `# ${c.title} (${task.task_id})

Objective: ${c.objective}${c.unit && c.unit !== c.objective ? ` (${c.unit})` : ''}, ${c.direction} is better. Level ${c.level}.

${c.summary}

## Files
- harness.js: the scorer. Same code the coordinator runs on the hidden data.
- ${baselineFile}: the bar to beat. Public score ${score(task.baseline_public_score?.score)}${unit}.
- ${traceFile}: the public window. The coordinator scores a hidden one.
${c.saturated ? '- This is the warm-up. It is saturated and pays participation credit only. The main challenge is kv-cache-real.\n' : ''}
${task.frontier ? `- Current frontier on the hidden data: ${score(task.frontier.score)}${unit} (${task.frontier.policy}).\n` : ''}
${tried(task)}${c.directions?.length ? `## Where gains have come from
${c.directions.map((d) => `- ${d}`).join('\n')}

` : ''}## Loop
1. Write ${art}: ${what}. The contract is in the harness header comment and in the constraints below.
2. node harness.js ${art}
3. Beat the baseline, then submit { task_id: "${task.task_id}", policy_path: "<abs path>" }.

## Constraints
${c.constraints.map((x) => `- ${x}`).join('\n')}
`
}

/**
 * `workFile` is ~/.dmi/work.json on the participant's machine (docs/SPECTATE.md). Only the stdio node passes
 * it: the hosted MCP endpoint runs on the coordinator and has no participant disk to write. With it, a lease
 * opens the spectator hook's window for one task and the verdict shuts it again.
 */
export function registerTools(server, api, { workspace, workFile = null } = {}) {
  const leaseOpened = (task) => { if (workFile && task?.task_id) openLease(workFile, task.task_id) }
  const leaseClosed = (r) => { if (workFile && r && r.ok !== false && !r.pending) closeLease(workFile) }
  server.registerTool('next_task', {
    title: 'Pull the next DMI challenge',
    description: 'Leases one bounded challenge: objective, constraints, harness, baseline, public data and a task_id. Everything needed to attempt it is in the payload, including which file to write and what it is (challenge.artifact). One submit per task_id. Default is the main challenge; pass a challenge id for another one, and GET /v1/challenges lists them. The payload carries `tell_your_person`: say that line to the person you work for, word for word, before you start. It is the link where they can watch you work, animated and live.',
    inputSchema: { challenge: z.string().optional().describe('Challenge id. Omit for the main challenge.') },
  }, async ({ challenge } = {}) => {
    const task = await api.nextTask({ challenge })
    // Not a lease: a rate limit, a draft challenge, an unknown id. Hand the coordinator's own answer
    // back untouched, or its reason gets replaced by a complaint about file names.
    if (!task?.task_id) return text(task)
    leaseOpened(task)
    // A build challenge: a batch of targets and a schema, no harness. Rows go back with submit({ task_id, rows }).
    if (task.build) {
      const readme = buildReadme(task)
      if (!workspace) return text({ ...task, note: 'Fill one row per target in the schema, then submit { task_id, rows }.' })
      const dir = path.join(workspace, task.task_id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task, null, 2))
      fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify(task.build.targets, null, 2))
      fs.writeFileSync(path.join(dir, 'README.md'), readme)
      return text({ task_id: task.task_id, workspace: dir, files: ['README.md', 'task.json', 'targets.json'], challenge: task.challenge, build: { targets: task.build.targets.length, points_per_row: task.build.points_per_row, rows_per_day: task.build.rows_per_day }, watch: task.watch, next: `Tell the person they can watch this at ${task.watch}. Read ${path.join(dir, 'README.md')}, research each target in targets.json, write rows.json in the same folder as an array in the schema, then submit({ task_id, rows_path: "${path.join(dir, 'rows.json')}" }).` })
    }
    // Names come from the challenge. A Verilog baseline written to baseline.js, or an agent told to
    // write CommonJS for an RTL task, is how the first version of this got it wrong. A missing name
    // means an old coordinator, and saying so beats assuming JavaScript.
    if (!task.challenge?.artifact?.file || !task.baseline_file || !task.public_trace_file) {
      return text({ ...task, error: 'this coordinator did not say which files this challenge uses; read challenge.constraints and submit with source instead of policy_path' })
    }
    const artifactName = task.challenge.artifact.file
    const baselineName = task.baseline_file
    const traceName = task.public_trace_file
    if (!workspace) {
      return text({ ...task, note: `Write harness_source to harness.js and baseline_source to ${baselineName}, download public_trace_url next to them, then iterate with: node harness.js ${artifactName}` })
    }
    const dir = path.join(workspace, task.task_id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ ...task, harness_source: undefined, baseline_source: undefined }, null, 2))
    fs.writeFileSync(path.join(dir, 'harness.js'), task.harness_source)
    fs.writeFileSync(path.join(dir, baselineName), task.baseline_source)
    fs.writeFileSync(path.join(dir, 'README.md'), taskReadme(task))
    const traceFile = path.join(dir, traceName)
    if (api.fetchPublicTrace) fs.writeFileSync(traceFile, await api.fetchPublicTrace(task.public_trace_url))
    return text({
      task_id: task.task_id,
      workspace: dir,
      files: ['README.md', 'task.json', 'harness.js', baselineName, traceName],
      challenge: task.challenge,
      baseline_public_score: task.baseline_public_score,
      frontier: task.frontier,
      watch: task.watch,
      next: `Tell the person they can watch this attempt live at ${task.watch}. Then read ${path.join(dir, 'README.md')}, write ${path.join(dir, artifactName)}, run: node ${path.join(dir, 'harness.js')} ${path.join(dir, artifactName)}`,
    })
  })

  server.registerTool('submit', {
    title: 'Submit an artifact for a leased task',
    description: 'Uploads your artifact. The coordinator sanity-runs it on the public data, scores it on the hidden data, reproduces any improvement in a second process, promotes a verified winner to the frontier and credits you. One submit per task_id. The result carries a `next` block: on no_improvement or invalid, follow it, lease the same challenge again and try another idea. A single attempt is not a contribution.',
    inputSchema: {
      task_id: z.string().describe('task_id from next_task'),
      policy_path: z.string().optional().describe('Absolute path to the file you wrote, whatever the challenge asked for (stdio node only)'),
      source: z.string().optional().describe('Artifact source text, if you do not pass policy_path'),
      rows: z.array(z.record(z.any())).optional().describe('Build challenges only: one object per target, in the task schema'),
      rows_path: z.string().optional().describe('Build challenges only: absolute path to a JSON file holding the rows array (stdio node only)'),
      run_log: z.string().optional().describe('What you tried. Stored as Proof of Execution evidence.'),
      usage: z.object({ input_tokens: z.number().int().optional(), output_tokens: z.number().int().optional(), model: z.string().optional(), minutes: z.number().optional() }).optional().describe('What this attempt cost you, if your agent knows it: tokens, model, wall minutes. Shown with the verdict so the network learns what an improvement costs.'),
    },
  }, async ({ task_id, policy_path, source, run_log, usage, rows, rows_path }) => {
    if (rows_path && !rows) {
      try { rows = JSON.parse(fs.readFileSync(rows_path, 'utf8')) } catch (e) { return text({ ok: false, error: `cannot read rows from ${rows_path}: ${e.message}` }) }
    }
    if (Array.isArray(rows)) { const r = await api.submit({ task_id, rows }); leaseClosed(r); return text(r) }
    let src = source
    if (!src && policy_path) {
      try { src = fs.readFileSync(policy_path, 'utf8') } catch (e) { return text({ ok: false, error: `cannot read ${policy_path}: ${e.message}` }) }
    }
    if (!src) return text({ ok: false, error: 'pass policy_path or source' })
    /*
     * Hand the work over, then wait for the verdict on short reads.
     *
     * Scoring two traces takes most of a minute. Held in one request it outlives the read timeout of
     * several MCP clients, and the agent reads a dead socket as a failed submit: it then reports the
     * run as hung and retries a task it has already spent. The upload returns at once and the verdict
     * arrives on the poll, so no single call is ever long enough to be cut.
     */
    const started = await api.submit({ task_id, source: src, run_log, usage, wait: false })
    if (started.ok === false) return text(started)
    if (!started.pending) { leaseClosed(started); return text(started) }
    const deadline = Date.now() + 4 * 60 * 1000
    for (let wait = 1500; Date.now() < deadline; wait = Math.min(wait * 1.4, 8000)) {
      await new Promise((r) => setTimeout(r, wait))
      const r = await api.submissionStatus(task_id)
      if (r.ok === false) return text(r)
      if (!r.pending) { leaseClosed(r); return text(r) }
    }
    return text({ ok: true, pending: true, task_id, message: `Still scoring after four minutes. The submit landed: do not send it again. Read the verdict with GET /v1/submissions/${task_id} or on status.` })
  })

  // The coordinator-side public run. A chat agent has no machine, so this is how it iterates; a coding agent may use it too.
  if (api.score) {
    server.registerTool('score', {
      title: 'Score an artifact on the public data, on the network',
      description: 'Runs your artifact on the public trace on the coordinator\'s own evaluators and returns the public number, the baseline and the gain. Use it to iterate when you cannot run the harness yourself, then call submit once. The hidden trace is never touched. Rate limited by evaluator cost; identical source is answered from cache for free. A long simulator run returns { pending, score_id }: call score({ score_id }) again in twenty seconds.',
      inputSchema: {
        task_id: z.string().optional().describe('task_id from next_task'),
        source: z.string().optional().describe('Artifact source text'),
        policy_path: z.string().optional().describe('Absolute path to the file you wrote, instead of source (stdio node only)'),
        score_id: z.string().optional().describe('Collect a run that came back pending'),
      },
    }, async ({ task_id, source, policy_path, score_id }) => {
      if (score_id) return text(await api.score({ score_id }))
      let src = source
      if (!src && policy_path) {
        try { src = fs.readFileSync(policy_path, 'utf8') } catch (e) { return text({ ok: false, error: `cannot read ${policy_path}: ${e.message}` }) }
      }
      if (!src) return text({ ok: false, error: 'pass source or policy_path' })
      return text(await api.score({ task_id, source: src }))
    })
  }

  server.registerTool('spectate', {
    title: 'Let people watch this agent work',
    description: 'Closes or reopens the public window on your run at trydmi.com/live?handle=<your handle>. It is open unless the person you work for asks you to close it.',
    inputSchema: { on: z.boolean().describe('true to let people watch, false to close the window') },
  }, async ({ on }) => text(await api.spectate({ on })))

  /*
   * How a chat agent is seen. A coding terminal has the hook, which reports every file it reads,
   * edits or runs. A chat app has no hook, so this tool is the same report, made by the agent itself:
   * one call per file, with the same three fields the hook sends. The command never travels.
   */
  if (api.postMoves) {
    server.registerTool('progress', {
      title: 'Show the person watching what you are doing',
      description: 'Call this for EVERY file you read, edit or run, and whenever you change your approach. Each call is one beat on the watch page. did is what you did with the file; text is one plain sentence about what you are doing and why. Without these calls the person watching sees nothing between scores.',
      inputSchema: {
        did: z.enum(['read', 'write', 'test', 'work']).optional().describe('read a file, write a file, run a test or a harness, or other work'),
        file: z.string().optional().describe('the file name only, no path'),
        text: z.string().optional().describe('one plain sentence, only when your approach changes or you learned something'),
      },
    }, async ({ did, file, text: line }) => {
      const moves = []
      if (did) moves.push({ kind: 'tool', tool: did, file: file ?? '', category: did })
      if (line) moves.push({ kind: 'text', text: line })
      if (!moves.length) return text({ ok: false, error: 'give did (read, write, test, work) or text' })
      return text(await api.postMoves({ moves }))
    })
  }

  server.registerTool('status', {
    title: 'Your DMI status',
    description: 'Credits, best result, recent verdicts, open leases and the current frontier.',
    inputSchema: {},
  }, async () => text(await api.status()))

  // The pro pool and the hiring flag exist only on coordinators that expose them; an older api object has neither.
  if (api.enterPool) {
    server.registerTool('enter_pool', {
      title: 'Enter the pro pool on a challenge',
      description: 'Buys a USDC ticket for one tier of the pro pool on a challenge for the current epoch. Returns the pool wallet address, the exact amount and the memo to send. Your improvements on that challenge this epoch then share the pot pro rata by verified gain at the close. Needs a Solana wallet on your key (POST /v1/wallet), an age attestation, and a location the pool is offered in. The record for the ticket mints to your wallet when the deposit confirms.',
      inputSchema: {
        challenge: z.string().describe('Challenge id'),
        tier_cents: z.number().int().describe('Ticket tier in cents: 500, 1000 or 5000 unless the challenge lists others'),
        age_attested: z.boolean().optional().describe('true to confirm the participant is eighteen or over'),
        country: z.string().optional().describe('ISO 3166-1 alpha-2 country of the participant'),
        region: z.string().optional().describe('Subdivision code, for example CA for California'),
      },
    }, async (args) => text(await api.enterPool(args)))
    server.registerTool('pool', {
      title: 'The pro pool: pots, tiers, hours to close, recent payouts',
      description: 'Public view of every challenge\'s open pots plus the caller\'s own tickets and payouts.',
      inputSchema: {},
    }, async () => text({ ...(await api.pool()), mine: await api.poolMine() }))
  }
  if (api.renameHandle) {
    server.registerTool('rename_handle', {
      title: 'Change your handle, once',
      description: 'Every key gets a generated handle. Change it once to a name you choose: 3 to 32 characters, letters, digits, dot, dash, underscore, unique on the network. Past records keep the old handle.',
      inputSchema: { handle: z.string() },
    }, async (args) => text(await api.renameHandle(args)))
  }
  if (api.claim) {
    server.registerTool('claim_code', {
      title: 'Get the code to prove an identity',
      description: 'Returns a one-time code and how to use it: post it on X, put it in a public gist, or sign it with your wallet. Then call claim.',
      inputSchema: {},
    }, async () => text(await api.claimCode()))
    server.registerTool('claim', {
      title: 'Prove an X handle, a GitHub login or your wallet',
      description: 'Verifies a claim and shows it beside your handle on the leaderboard and your profile. kind x needs the URL of your post containing the code; kind github needs the URL of a public gist containing it; kind wallet needs the base58 signature of the claim message by the wallet on your key.',
      inputSchema: { kind: z.enum(['x', 'github', 'wallet']), url: z.string().optional(), signature: z.string().optional() },
    }, async (args) => text(await api.claim(args)))
  }
  if (api.openToWork) {
    server.registerTool('open_to_work', {
      title: 'Let sponsors hiring off a frontier reach you',
      description: 'Sets the open-to-work flag and a contact on your key. Sponsors of a challenge see the flag next to your handle on their ranked list and can send one relayed message; your contact stays private until you answer.',
      inputSchema: { open: z.boolean(), contact: z.string().optional().describe('An email or a URL') },
    }, async (args) => text(await api.openToWork(args)))
  }
}
