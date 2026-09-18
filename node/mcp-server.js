#!/usr/bin/env node
/**
 * Local stdio DMI node. Talks HTTP to the coordinator, writes task workspaces to disk.
 * Env: DMI_API_KEY (required), DMI_COORDINATOR_URL (default http://127.0.0.1:8790),
 *      DMI_WORKSPACE (default ~/.dmi/workspace).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import os from 'node:os'
import path from 'node:path'
import { registerTools } from './tools.js'
import { workFilePath } from './lease-file.js'

const key = process.env.DMI_API_KEY
if (!key || !/^dmi_[A-Za-z0-9]{24,}$/.test(key)) {
  console.error('DMI_API_KEY missing or malformed. Run `npx trydmi install` to mint one.')
  process.exit(1)
}
const base = (process.env.DMI_COORDINATOR_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '')
const workspace = process.env.DMI_WORKSPACE ?? path.join(os.homedir(), '.dmi', 'workspace')

async function call(method, route, body) {
  const r = await fetch(base + route, {
    method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({ error: `coordinator returned ${r.status}` }))
  if (r.status === 401) throw new Error(data.error)
  return data
}

const api = {
  nextTask: (args) => call('POST', '/v1/tasks/next', args ?? {}),
  submit: (args) => call('POST', '/v1/submissions', args),
  submissionStatus: (taskId) => call('GET', `/v1/submissions/${encodeURIComponent(taskId)}`),
  score: (args) => call('POST', '/v1/score', args ?? {}),
  status: () => call('GET', '/v1/status'),
  spectate: (args) => call('POST', '/v1/me/spectate', args ?? {}),
  postMoves: (args) => call('POST', '/v1/live/moves', args ?? {}),
  enterPool: (args) => call('POST', '/v1/pool/ticket', args ?? {}),
  pool: () => call('GET', '/v1/pool'),
  poolMine: () => call('GET', '/v1/pool/mine'),
  openToWork: (args) => call('POST', '/v1/me/open-to-work', args ?? {}),
  renameHandle: (args) => call('POST', '/v1/me/handle', args ?? {}),
  claimCode: () => call('POST', '/v1/me/claims/code', {}),
  claim: (args) => call('POST', '/v1/me/claims', args ?? {}),
  fetchPublicTrace: async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`trace download failed: ${r.status}`); return r.text() },
}

const server = new McpServer({ name: 'dmi', version: '0.2.0' })
registerTools(server, api, { workspace, workFile: workFilePath() })
await server.connect(new StdioServerTransport())
