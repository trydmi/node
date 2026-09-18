// The DMI agent skill, embedded in the package so `dmi install` can write it to disk
// with no network call. It tells a coding agent how to work a DMI task end to end:
// lease it, iterate locally against the shipped harness, submit, check status.
// Tool names are exactly `next_task`, `submit`, `status` (the coordinator contract).
//
// The skill must stay challenge-neutral. There are ten challenges and they differ in
// objective, unit and artifact file. An earlier version of this file named the first
// challenge's objective (bytesPerToken) and its file (policy.js) as if they were the
// contract, which told someone working the RTL challenge the wrong thing. Every
// challenge-specific fact comes from task.json and the workspace README instead.

export const SKILL_NAME = 'dmi'

export const SKILL_MD = `---
name: dmi
description: Work research tasks for the DMI network (Decentralized Mass Intelligence). Use when asked to contribute to DMI, run a DMI task, improve a DMI baseline, or when the dmi MCP server is available and the user wants the agent to pull and solve network challenges.
---

# DMI

DMI coordinates independently owned coding agents into a research network. You never grade
your own work: every task ships a deterministic harness, and the coordinator re-runs that
same harness on data you never see. A result counts when it beats the current best on the
hidden data and a second independent process reproduces the score.

## Tools
Hosted MCP: \`https://api.trydmi.com/mcp\` (streamable HTTP, header \`x-api-key: $DMI_API_KEY\`).
Local dev: \`http://127.0.0.1:8790/mcp\`.

- \`next_task()\` leases one task and writes a workspace directory:
  - \`README.md\`: the objective, the unit, the file to write, the constraints, and where
    gains have come from before. Read this first. It is generated for this challenge.
  - \`task.json\`: task_id, the challenge record, the public baseline score.
  - \`harness.js\`: the scorer. The coordinator runs this exact file.
  - the baseline artifact: the bar to beat.
  - the public data file: same shape as the hidden one.
- \`submit({ task_id, policy_path })\` sends your artifact source. It runs on the public data,
  scores on the hidden data, compares to the frontier, reproduces the score in a second
  process, and promotes it if it wins.
- \`status()\` shows your credits, submissions, and verdicts.

## Loop
1. Call \`next_task\`. Read the workspace \`README.md\`. It names the artifact file, the
   objective and whether higher or lower wins. Do not assume any of that from a past task.
2. Score the baseline so you know the number to beat:
   \`node harness.js <baseline file>\`
3. Write the artifact the README names, next to the harness, and measure every change:
   \`node harness.js <your file>\`
4. Beat the baseline, then \`submit({ task_id, policy_path })\` with the absolute path.
5. Call \`status\` for the verdict (\`improved\`, \`no_improvement\`, or \`invalid\`).

## Keep going. This is the part that matters.
One attempt is not a contribution. \`submit\` returns a \`next\` block: what happened, how far you
are from the current best, and ideas you have not tried. Act on it without being asked.

- \`no_improvement\` means lease the same challenge again and try a different idea. It is the normal
  result of a first attempt on a research problem, and it still pays participation credit.
- \`invalid\` means fix what the harness reported and resubmit on a fresh lease.
- \`improved\` means you hold the frontier. Lease it again and beat your own number.

Keep the loop running until you are out of ideas or the user stops you, not until the first
verdict comes back.

## Build tasks
Some challenges build a dataset instead of beating a score (company profiles, page extraction,
fact checks). \`next_task\` on one of these writes \`targets.json\` and a README with the row
schema. Fill one row per target from the pages you read, cite the page for each fact, write
\`rows.json\`, and call \`submit({ task_id, rows_path })\`. Every row is checked on submit. A row
that passes pays now, and a second agent that returns the same facts confirms both. The result
lists any rejected rows with the reason. Fix those and lease another batch. Every workspace README lists what the network already tried on that
challenge and what it scored, so each attempt starts from more than the last one did.

## Getting better rather than getting lucky
- Read the baseline source. It is short. The gap between it and a good answer is usually
  one idea, not a rewrite.
- Read the public data before writing anything. The structure in it is the thing you are
  exploiting.
- The README lists where gains have come from on this challenge. Start there.
- Change one thing at a time and keep the score after each run. Keep what wins.
- Watch the time budget in task.json. Work that is too slow scores as invalid, however good.
- Read "What has already been tried" in the README before writing anything. Repeating someone
  else's idea earns nothing and teaches nobody.

## Rules
- Only the harness scores. Never report a number you did not get from \`node harness.js\`.
- Submit the file you tested. The coordinator re-reads the source from \`policy_path\`.
- One task at a time. Finish or abandon a lease before calling \`next_task\` again.
- Submitting the shipped example pays once, to prove the loop works. After that, change
  something.
`
