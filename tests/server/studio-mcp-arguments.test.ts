import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
// @ts-expect-error plain .mjs helper without types
import { validateToolArguments } from '../../bin/browser/arguments.mjs'

const BIN = resolve(__dirname, '../../bin/ekko-studio-mcp.mjs')

/** The stdio MCP server, run for real against a fake Studio API that records every request. */
async function startMcp(toolset: string) {
  const hits: string[] = []
  const api: Server = createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}${body ? ` ${body}` : ''}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>(r => api.listen(0, '127.0.0.1', r))
  const home = await mkdtemp(join(tmpdir(), 'studio-mcp-'))
  const port = (api.address() as { port: number }).port
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BIN, toolset], {
    env: { ...process.env, HERMES_WEB_UI_URL: `http://127.0.0.1:${port}`, HERMES_WEB_UI_TOKEN: 't', HERMES_WEB_UI_HOME: home },
  })
  const waiting = new Map<number, (m: any) => void>()
  createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line)
    waiting.get(m.id)?.(m)
  })
  let id = 0
  const rpc = (method: string, params?: unknown) => new Promise<any>(r => {
    const n = ++id
    waiting.set(n, r)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`)
  })
  const call = async (name: string, args: unknown) => {
    hits.length = 0
    const { result } = await rpc('tools/call', { name, arguments: args })
    return { error: result.isError ? String(result.content[0].text) : '', hits: [...hits] }
  }
  const stop = async () => { child.kill(); api.close(); await rm(home, { recursive: true, force: true }) }
  return { rpc, call, stop }
}

describe('Studio MCP: arguments are checked before Studio is called', () => {
  let mcp: Awaited<ReturnType<typeof startMcp>>
  beforeAll(async () => { mcp = await startMcp('use') })
  afterAll(async () => { await mcp.stop() })

  it('a delete without its id is refused (it used to call DELETE .../sessions/undefined)', async () => {
    for (const [tool, key] of [['ekko_studio_use_session_delete', 'session_id'], ['ekko_studio_use_workflow_delete', 'workflow_id'], ['ekko_studio_use_provider_delete', 'pool_key']]) {
      const out = await mcp.call(tool, {})
      expect(out.error).toContain(`arguments.${key} is required`)
      expect(out.hits).toEqual([])
    }
    const blank = await mcp.call('ekko_studio_use_session_delete', { session_id: '  ' })
    expect(blank.error).toContain('session_id is empty')
    expect(blank.hits).toEqual([])
  })

  it('the meta-tool call path is checked the same way', async () => {
    const out = await mcp.call('ekko_studio_use_toolset', { action: 'call', tool: 'ekko_studio_use_session_delete', arguments: {} })
    expect(out.error).toContain('session_id is required')
    expect(out.hits).toEqual([])
  })

  it('a toolset call with bad arguments gets the tool\'s schema in the error', async () => {
    const out = await mcp.call('ekko_studio_use_toolset', { action: 'call', tool: 'ekko_studio_use_orb_board', arguments: {} })
    expect(out.error).toContain('arguments.action is required')
    expect(out.error).toContain('action=call, tool=ekko_studio_use_orb_board')
    expect(out.error).toContain('"enum":["find","read","activity","create"')
    expect(out.hits).toEqual([])
  })

  it('enum typos, wrong types and unknown keys are refused', async () => {
    expect((await mcp.call('ekko_studio_use_orb_read', { kind: 'taks' })).error).toMatch(/kind must be one of: tasks, lists/)
    expect((await mcp.call('ekko_studio_use_sessions_list', { limit: 'five' })).error).toContain('limit must be number')
    expect((await mcp.call('ekko_studio_use_sessions_list', { bogus: 1 })).error).toContain('bogus is not supported')
  })

  it('good calls still reach Studio, including the Orb filters and lists', async () => {
    expect((await mcp.call('ekko_studio_use_session_delete', { session_id: 's1' })).hits).toEqual(['DELETE /api/studio/sessions/s1'])
    expect((await mcp.call('ekko_studio_use_orb_read', { kind: 'tasks', due_on_or_before: '2026-11-13', limit: 10 })).hits)
      .toEqual(['POST /api/studio/orb/tools/orb_list_tasks {"due_on_or_before":"2026-11-13","limit":10}'])
    expect((await mcp.call('ekko_studio_use_orb_read', { kind: 'lists' })).hits).toEqual(['POST /api/studio/orb/tools/orb_list_lists {}'])
  })

  it('board actions reach the matching Orb board tool, and nothing else', async () => {
    const out = await mcp.call('ekko_studio_use_orb_board', { action: 'mark', arguments: { board: 'Garage', marks: [{ card: 'Pegboard', state: 'doing' }], agent: 'Hermes' } })
    expect(out.hits).toEqual(['POST /api/studio/orb/tools/orb_board_mark {"board":"Garage","marks":[{"card":"Pegboard","state":"doing"}],"agent":"Hermes"}'])
    expect((await mcp.call('ekko_studio_use_orb_board', { action: 'remove', arguments: { board: 'Garage' } })).hits)
      .toEqual(['POST /api/studio/orb/tools/orb_board_remove {"board":"Garage"}'])
    const bad = await mcp.call('ekko_studio_use_orb_board', { action: 'wipe' })
    expect(bad.error).toMatch(/action must be one of: find, read/)
    expect(bad.hits).toEqual([])
  })

  it('project actions go to Studio\'s project tool route with the calling chat, and nothing else', async () => {
    const out = await mcp.call('ekko_studio_use_project', { action: 'start_thread', arguments: { brief: 'Fix the flaky login test', agent: 'codex' } })
    expect(out.error).toBe('')
    expect(out.hits).toEqual(['POST /api/studio/projects/tool/start_thread {"brief":"Fix the flaky login test","agent":"codex","sessionId":""}'])
    const task = await mcp.call('ekko_studio_use_project', { action: 'add_task', arguments: { title: 'Review PR 12', pr: 'https://github.com/o/r/pull/12' } })
    expect(task.hits).toEqual(['POST /api/studio/projects/tool/add_task {"title":"Review PR 12","pr":"https://github.com/o/r/pull/12","sessionId":""}'])
    const bad = await mcp.call('ekko_studio_use_project', { action: 'delete_everything' })
    expect(bad.error).toMatch(/action must be one of: list, start_thread/)
    expect(bad.hits).toEqual([])
  })

  it('phone actions go to Studio\'s Android agent route with the chat and agent, and nothing else', async () => {
    const out = await mcp.call('ekko_studio_use_phone', { action: 'tap', arguments: { id: 'e3' }, agent: 'hermes' })
    expect(out.error).toBe('')
    expect(out.hits).toEqual(['POST /api/studio/android/agent {"action":"tap","arguments":{"id":"e3"},"sessionId":"","agent":"hermes"}'])
    // Hermes names its chat with the turn's context id; Studio resolves it.
    const withContext = await mcp.call('ekko_studio_use_phone', { action: 'screen', agent: 'hermes', context_id: ' ctx-1 ' })
    expect(withContext.hits).toEqual(['POST /api/studio/android/agent {"action":"screen","arguments":{},"sessionId":"","contextId":"ctx-1","agent":"hermes"}'])
    const bad = await mcp.call('ekko_studio_use_phone', { action: 'factory_reset' })
    expect(bad.error).toMatch(/action must be one of: devices, screen/)
    expect(bad.hits).toEqual([])
  })

  it('deletes are marked destructive in the catalog and in describe', async () => {
    const { result } = await mcp.rpc('tools/call', { name: 'ekko_studio_use_toolset', arguments: { action: 'list', query: 'delete' } })
    const ops = JSON.parse(result.content[0].text).operations
    expect(ops.find((o: any) => o.name === 'ekko_studio_use_session_delete').destructive).toBe(true)
    const described = await mcp.rpc('tools/call', { name: 'ekko_studio_use_toolset', arguments: { action: 'describe', tool: 'ekko_studio_use_workflow_delete' } })
    expect(JSON.parse(described.result.content[0].text).annotations).toEqual({ readOnlyHint: false, destructiveHint: true })
  })

  it('negotiates the protocol version instead of echoing anything', async () => {
    expect((await mcp.rpc('initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion).toBe('2025-06-18')
    expect((await mcp.rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-11-25')
  })
})

describe('validateToolArguments', () => {
  const tool = { inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: {
    id: { type: 'string' }, revision: { type: 'integer', minimum: 0 }, note: { type: ['string', 'null'] },
  } } }
  it('handles integers and union types', () => {
    expect(validateToolArguments(tool, { id: 'a', revision: 2, note: null })).toBeUndefined()
    expect(validateToolArguments(tool, { id: 'a', revision: 1.5 })).toContain('whole number')
    expect(validateToolArguments(tool, { id: 'a', note: 3 })).toContain('must be string or null')
  })
})
