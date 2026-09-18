#!/usr/bin/env node
// The `dmi` command. A thin client over the DMI coordinator: no database, no local
// state, just your API key (DMI_API_KEY) and HTTP. Port of the StackResolve CLI
// (packages/sdk-ts/src/cli.ts) trimmed to the DMI commands.
import {
  coordinatorUrl,
  createKey,
  detectTargets,
  fetchStatus,
  formatReport,
  httpServerEntry,
  isValidKey,
  KEY_ENV,
  runInstall,
  runUninstall,
  SERVER_NAME,
  URL_ENV,
} from './install.js'
import { existsSync } from 'node:fs'
import { readWorkFile, workFilePath } from '../node/lease-file.js'

const BIN = 'dmi'
const HELP = `${BIN} - turn your coding agent into a DMI research node.

usage: ${BIN} <command> [args] [--json]

setup
  install                 wire DMI into every coding agent on this machine
                          (MCP server + skill), minting a key if you have none
    --handle <name>       handle to register the minted key under (default: a generated name)
    --key <dmi_...>       use this key instead of minting one
    --url <URL>           coordinator base URL (default ${URL_ENV} or https://api.trydmi.com)
    --claude --cursor     limit to specific agents (also --codex --windsurf --vscode)
    --project             also write ./.mcp.json + ./.claude/skills for this repo
                          you ask. Never outside a lease.
    --dry-run             show what would change, write nothing
    --print               print the MCP server block instead of installing
  uninstall               remove the dmi server entry and skill from every agent
    --dry-run             show what would change, write nothing

compute
  compute                 run a compute node: score and reproduce submissions for the network, earn credit per job
    --key <dmi_...>       attach the node to an existing account (default: reuse the saved node key, else mint one)
    --handle <name>       handle for a minted key
    --dir <path>          node directory for the key and cached traces (default DMI_NODE_DIR or ~/.dmi/node)
    --once                take one job, then exit

work
  work                    background work mode: your own agent works one DMI task whenever it is idle, on your subscription
    --agent <name>        claude, cursor-agent or codex (default: the first one installed)
    --every <minutes>     minutes between sessions (default 60)
    --max-per-day <n>     most sessions in one UTC day (default 12)
    --challenge <id>      always work this challenge (default: the coordinator picks)
    --model <name>        model to pass to the agent CLI
    --key <dmi_...>       work under an existing key (default: the saved key in ~/.dmi/work.json, else register one)
    --dir <path>          work directory for the key and log (default DMI_WORK_DIR or ~/.dmi)
    --once                run one session, then exit
    --no-open             do not open the watch page in the browser at launch
    --dry-run             show the command that would run, start nothing
    --allow-api-key       let Claude Code run with ANTHROPIC_API_KEY set (bills the API, not the subscription)

account
  status                  your credits, submissions, and verdicts
  keys create             mint an API key (shown once, no login needed)
    --handle <name>       handle to register under (default: a generated name)

flags
  --json                  print raw JSON
  -h, --help              show this help

env
  ${KEY_ENV}             your key (get one: ${BIN} keys create)
  ${URL_ENV}     coordinator base (default https://api.trydmi.com; local dev http://127.0.0.1:8790)

examples
  npx trydmi install
  ${BIN} keys create --handle chris
  ${BIN} status
  ${BIN} compute
  ${BIN} work --every 30`

function defaultHandle() {
  // Never derive a public handle from the machine's username; the coordinator generates one when this is empty.
  return ''
}

async function main() {
  const raw = process.argv.slice(2)
  if (raw.includes('-h') || raw.includes('--help') || !raw.length) { console.log(HELP); process.exit(raw.length ? 0 : 1) }
  const forceJson = raw.includes('--json')
  const argv = raw.filter((a) => a !== '--json')
  const [cmd, ...args] = argv
  const json = (o) => console.log(JSON.stringify(o, null, 2))

  const flag = (name) => raw.includes(`--${name}`)
  const value = (name) => {
    const i = raw.indexOf(`--${name}`)
    if (i >= 0 && raw[i + 1] && !raw[i + 1].startsWith('--')) return raw[i + 1]
    const inline = raw.find((a) => a.startsWith(`--${name}=`))
    return inline ? inline.slice(name.length + 3) : undefined
  }
  const base = coordinatorUrl(value('url'))
  const explicit = ['claude', 'cursor', 'codex', 'windsurf', 'vscode'].filter((t) => flag(t))

  switch (cmd) {
    // One line from a fresh machine to a working node: mint a key if needed, register
    // the hosted MCP server everywhere, write the skill, verify the key.
    case 'install':
    case 'init': {
      const dryRun = flag('dry-run')
      // Key precedence: --key, then the environment, then the key already on this machine, then
      // mint a fresh one. Minting needs no login, so `npx trydmi install` works on a machine that
      // has never seen us. The third step is there because a run on 2026-09-17 (Grok, handle
      // RatherStubbornNewt) took a task on the machine's key and then re-ran the installer, which
      // minted a second key; every score it posted went out under the new key, which had no open
      // task, and bounced. One machine, one key.
      let apiKey = value('key') || process.env[KEY_ENV] || ''
      let reused = false
      if (!apiKey) {
        const file = workFilePath()
        const prior = existsSync(file) ? readWorkFile(file) : {}
        if (isValidKey(prior.key)) { apiKey = prior.key; reused = true }
      }
      if (apiKey && !isValidKey(apiKey)) throw new Error(`key does not look like a DMI key (expected dmi_ followed by 24+ letters or digits)`)
      let minted = false
      if (!apiKey && !flag('print')) {
        if (dryRun) {
          // A dry run writes nothing, so it should not mint a key either.
          apiKey = 'dmi_' + 'x'.repeat(24)
        } else {
          const created = await createKey(value('handle') || defaultHandle(), base)
          apiKey = created.key
          minted = true
        }
      }

      if (flag('print')) {
        json({ mcpServers: { [SERVER_NAME]: httpServerEntry(apiKey || '${' + KEY_ENV + '}', base) } })
        break
      }

      const report = await runInstall({ apiKey, targets: explicit, project: flag('project'), spectate: flag('spectate'), dryRun, url: base })
      if (forceJson) { json({ ...report, minted, reused, detected: detectTargets() }); break }
      if (reused) console.log(`\nUsing the key already on this machine (${workFilePath()}). Pass --key to use another.`)
      if (minted) console.log(`\nMinted a new API key (save it, it is shown once):\n  ${apiKey}`)
      if (dryRun && !value('key') && !process.env[KEY_ENV]) console.log('\nNo key found. A real install would mint one at ' + base + '/v1/register.')
      console.log(formatReport(report, apiKey, dryRun))
      if (!report.verified && !dryRun) process.exitCode = 1
      break
    }
    case 'uninstall': {
      const report = runUninstall({ targets: explicit, project: flag('project'), dryRun: flag('dry-run') })
      if (forceJson) { json(report); break }
      console.log(formatReport(report, '', flag('dry-run')).replace('DMI installed', 'DMI uninstalled').replace('DMI install (dry run', 'DMI uninstall (dry run'))
      break
    }
    case 'keys': {
      if (args[0] !== 'create') { console.log(`usage: ${BIN} keys create [--handle <name>]`); break }
      const r = await createKey(value('handle') || defaultHandle(), base)
      if (forceJson) { json(r); break }
      console.log(`\nAPI key (save it now, shown once):\n  ${r.key}\n`)
      console.log(`Use it: export ${KEY_ENV}=${r.key}\n  keyId: ${r.keyId}`)
      break
    }
    case 'status': {
      const apiKey = value('key') || process.env[KEY_ENV] || ''
      if (!apiKey) throw new Error(`no key. Set ${KEY_ENV} or pass --key dmi_...`)
      const r = await fetchStatus(apiKey, base)
      if (!r.ok) throw new Error(r.detail)
      json(r.body)
      break
    }
    // The node loads the challenge registry and the worker, so it is imported only when asked for.
    case 'compute': {
      // The node's registry must hold every challenge the coordinator can offer. The tool probes in compute.js
      // decide which of them this machine reports; an env flag left unset here would hide a challenge the machine can run.
      process.env.DMI_ENABLE_DRAM ??= '1'
      process.env.DMI_ENABLE_RTL ??= '1'
      process.env.DMI_ENABLE_SYNTH ??= '1'
      process.env.DMI_ENABLE_SAT ??= '1'
      process.env.DMI_ENABLE_CONTEST ??= '1'
      const { runComputeCommand } = await import('./compute.js')
      const out = await runComputeCommand({ url: base, key: value('key'), handle: value('handle'), dir: value('dir'), once: flag('once') })
      if (forceJson) json(out)
      break
    }
    // Background work mode. Loaded only when asked for, like compute.
    case 'work': {
      const { runWorkCommand } = await import('./work.js')
      const out = await runWorkCommand({
        url: base, key: value('key'), dir: value('dir'), agent: value('agent'), model: value('model'), challenge: value('challenge'),
        every: value('every'), maxPerDay: value('max-per-day'), once: flag('once'), dryRun: flag('dry-run'), allowApiKey: flag('allow-api-key'), noOpen: flag('no-open'),
      })
      if (forceJson) json(out)
      break
    }
    default:
      console.error(`unknown command: ${cmd}\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
