import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HerdrBridge, herdrChatId, type HerdrBridgeDeps, type HerdrSessionRef, type HerdrLinkInfo } from '../../packages/server/src/modules/coding-agents/services/herdr/bridge'
import { DEFAULT_HERDR_SETTINGS } from '../../packages/server/src/modules/coding-agents/services/herdr/runtime'
import type { TranscriptMessage } from '../../packages/server/src/modules/coding-agents/services/herdr/transcript'

/** Minimal herdr socket server: answers requests from `state` and pushes events. */
class FakeHerdr {
  server: Server
  subscribers = new Set<{ socket: Socket; id: string }>()
  requests: Array<{ method: string; params: any }> = []
  panes: any[] = []
  workspaces: any[] = [{ workspace_id: 'w1', label: 'demo', agent_status: 'idle' }]
  promptError: { code: string; message: string } | null = null

  constructor(readonly path: string) {
    this.server = createServer(socket => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          this.handle(socket, JSON.parse(line))
          index = buffer.indexOf('\n')
        }
      })
      socket.on('error', () => {})
    })
  }

  listen() { return new Promise<void>(resolve => this.server.listen(this.path, resolve)) }
  close() {
    for (const sub of this.subscribers) sub.socket.destroy()
    return new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private handle(socket: Socket, request: { id: string; method: string; params: any }) {
    this.requests.push({ method: request.method, params: request.params })
    const reply = (result: unknown) => socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
    switch (request.method) {
      case 'ping': return reply({ type: 'pong' })
      case 'events.subscribe': {
        const missing = (request.params.subscriptions || []).find((s: any) => s.pane_id && !this.panes.some(p => p.pane_id === s.pane_id))
        if (missing) {
          socket.write(`${JSON.stringify({ id: request.id, error: { code: 'pane_not_found', message: 'no pane' } })}\n`)
          socket.end()
          return
        }
        this.subscribers.add({ socket, id: request.id })
        socket.on('close', () => { for (const s of this.subscribers) if (s.socket === socket) this.subscribers.delete(s) })
        return reply({ type: 'subscription_started' })
      }
      case 'session.snapshot':
        return reply({ type: 'session_snapshot', snapshot: { version: '0.9.5', workspaces: this.workspaces, panes: this.panes, focused_pane_id: this.panes[0]?.pane_id ?? null } })
      case 'agent.prompt':
        if (this.promptError) return socket.write(`${JSON.stringify({ id: request.id, error: this.promptError })}\n`)
        return reply({ type: 'agent_prompt' })
      case 'workspace.create':
        this.workspaces.push({ workspace_id: 'w9', label: request.params.label })
        return reply({ type: 'workspace_created', workspace: { workspace_id: 'w9' }, tab: { tab_id: 'w9:t1' }, root_pane: { pane_id: 'w9:p1' } })
      case 'layout.apply':
        this.panes.push({ pane_id: 'w9:p2', workspace_id: 'w9', agent_status: 'unknown', cwd: request.params.root.cwd })
        return reply({ type: 'layout_apply', layout: { focused_pane_id: 'w9:p2', root: { type: 'pane', pane_id: 'w9:p2' } } })
      case 'pane.focus':
        return reply({ type: 'pane_info', pane: { pane_id: request.params.pane_id } })
      default:
        return socket.write(`${JSON.stringify({ id: request.id, error: { code: 'unknown_method', message: request.method } })}\n`)
    }
  }

  emit(event: string, data: Record<string, unknown> = {}) {
    for (const sub of this.subscribers) sub.socket.write(`${JSON.stringify({ event, data })}\n`)
  }

  /** Simulate herdr dropping a slow subscriber. */
  loseEvents() {
    for (const sub of this.subscribers) {
      sub.socket.write(`${JSON.stringify({ id: sub.id, error: { code: 'events_lost', message: 'lagged' } })}\n`)
      sub.socket.end()
    }
  }
}

function makeDeps(dir: string) {
  const sessions = new Map<string, HerdrSessionRef>()
  const messages = new Map<string, TranscriptMessage[]>()
  const links = new Map<string, HerdrLinkInfo | null>()
  const updated: string[] = []
  const deps: HerdrBridgeDeps = {
    findSessionByNativeId: nativeId => [...sessions.values()].find(s => s.agent_native_session_id === nativeId) ?? null,
    getSession: id => sessions.get(id) ?? null,
    createSession: input => {
      sessions.set(input.id, { id: input.id, agent: input.agent, title: input.title, workspace: input.workspace, agent_native_session_id: input.nativeId, message_count: 0 })
    },
    updateNativeSessionId: (id, nativeId) => { const s = sessions.get(id); if (s) s.agent_native_session_id = nativeId },
    appendMessages: (id, list) => {
      messages.set(id, [...(messages.get(id) ?? []), ...list])
      const s = sessions.get(id); if (s) s.message_count = (s.message_count ?? 0) + list.length
    },
    setLink: (id, link) => { links.set(id, link) },
    notifyUpdated: id => { updated.push(id) },
    locateTranscript: async (_agent, nativeId) => join(dir, `${nativeId}.jsonl`),
    prepareSessionLaunch: async id => ({ agentId: 'claude-code', command: 'claude', args: ['--resume', sessions.get(id)?.agent_native_session_id || ''], env: { A: '1' }, workspaceDir: dir, provider: 'llama-swap', model: 'qwen3' }),
    prepareAgentLaunch: async (agentId, input) => ({ agentId, command: agentId, args: [], env: {}, workspaceDir: input.workspace || dir, provider: input.provider || 'global', model: input.model || '' }),
    herdrKindFor: id => (id === 'claude-code' ? 'claude' : id),
    agentLabel: id => (id === 'claude-code' ? 'Claude Code' : id),
  }
  return { deps, sessions, messages, links, updated }
}

const claudeLine = (role: 'user' | 'assistant', text: string) => `${JSON.stringify({ type: role, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }, timestamp: '2026-11-07T10:00:00Z' })}\n`

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition not met in time')
}

describe('herdr bridge', () => {
  let dir: string
  let herdr: FakeHerdr
  let bridge: HerdrBridge | null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'herdr-bridge-'))
    herdr = new FakeHerdr(join(dir, 'herdr.sock'))
    await herdr.listen()
    bridge = null
  })

  afterEach(async () => {
    bridge?.stop()
    await herdr.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function startBridge(deps: HerdrBridgeDeps, settings = DEFAULT_HERDR_SETTINGS) {
    bridge = new HerdrBridge({ ...settings, enabled: true }, deps, join(dir, 'state.json'), async () => herdr.path)
    return bridge.start()
  }

  it('imports an active herdr agent as a Studio chat and mirrors its transcript', async () => {
    const nativeId = '11111111-2222-3333-4444-555555555555'
    await writeFile(join(dir, `${nativeId}.jsonl`), claudeLine('user', 'Fix the login bug please') + claudeLine('assistant', 'Looking at auth.ts'))
    herdr.panes = [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', cwd: '/repo', agent_session: { kind: 'id', value: nativeId, source: 'herdr:claude' } }]
    const { deps, sessions, messages, links } = makeDeps(dir)
    await startBridge(deps)

    const id = herdrChatId(nativeId)
    expect(sessions.get(id)).toMatchObject({ agent: 'claude-code', title: 'Fix the login bug please', workspace: '/repo' })
    expect(links.get(id)).toEqual({ paneId: 'w1:p1', workspaceId: 'w1', status: 'working' })
    expect(messages.get(id)?.map(m => m.role)).toEqual(['user', 'assistant'])

    // New output while working arrives on the next status change.
    await appendFile(join(dir, `${nativeId}.jsonl`), claudeLine('assistant', 'Fixed and tested'))
    herdr.panes[0].agent_status = 'done'
    herdr.emit('pane_updated')
    await until(() => links.get(id)?.status === 'done')
    await until(() => (messages.get(id)?.length ?? 0) === 3)
    expect(messages.get(id)?.[2].content).toBe('Fixed and tested')
  })

  it('does not create chats for agents opened and closed without doing anything', async () => {
    herdr.panes = [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { kind: 'id', value: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }]
    const { deps, sessions } = makeDeps(dir)
    await startBridge(deps)
    expect(sessions.size).toBe(0)
    expect(bridge!.getState().panes[0]).toMatchObject({ studioAgent: 'claude-code', studioSessionId: null })
  })

  it('links an existing Studio chat by native id and only mirrors new turns', async () => {
    const nativeId = '99999999-2222-3333-4444-555555555555'
    await writeFile(join(dir, `${nativeId}.jsonl`), claudeLine('user', 'old turn already in Studio'))
    const { deps, sessions, messages, links } = makeDeps(dir)
    sessions.set('studio-chat', { id: 'studio-chat', agent: 'claude-code', title: 'Existing', workspace: null, agent_native_session_id: nativeId, message_count: 4 })
    herdr.panes = [{ pane_id: 'w1:p3', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { kind: 'id', value: nativeId } }]
    await startBridge(deps)
    expect(links.get('studio-chat')?.paneId).toBe('w1:p3')
    expect(messages.get('studio-chat')).toBeUndefined()

    await appendFile(join(dir, `${nativeId}.jsonl`), claudeLine('user', 'new from herdr'))
    herdr.panes[0].agent_status = 'working'
    herdr.emit('pane_updated')
    await until(() => (messages.get('studio-chat')?.length ?? 0) === 1)
    expect(messages.get('studio-chat')?.[0].content).toBe('new from herdr')
  })

  it('clears the link when the pane closes but keeps the chat', async () => {
    const nativeId = '12121212-2222-3333-4444-555555555555'
    const { deps, sessions, links } = makeDeps(dir)
    sessions.set('chat-a', { id: 'chat-a', agent: 'codex', title: 'A', workspace: null, agent_native_session_id: nativeId })
    herdr.panes = [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'codex', agent_status: 'blocked', agent_session: { kind: 'id', value: nativeId } }]
    await startBridge(deps)
    expect(links.get('chat-a')?.status).toBe('blocked')
    herdr.panes = []
    herdr.emit('pane_closed')
    await until(() => links.get('chat-a') === null)
    expect(sessions.has('chat-a')).toBe(true)
  })

  it('resubscribes and reconciles after events_lost', async () => {
    const nativeId = '34343434-2222-3333-4444-555555555555'
    const { deps, sessions, links } = makeDeps(dir)
    sessions.set('chat-b', { id: 'chat-b', agent: 'claude-code', title: 'B', workspace: null, agent_native_session_id: nativeId })
    herdr.panes = [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', agent_session: { kind: 'id', value: nativeId } }]
    await startBridge(deps)
    herdr.panes[0].agent_status = 'idle'
    herdr.loseEvents()
    await until(() => links.get('chat-b')?.status === 'idle')
    await until(() => bridge!.getState().connected)
  })

  it('sends chat input to the live pane and reports a blocked agent', async () => {
    const nativeId = '56565656-2222-3333-4444-555555555555'
    const { deps, sessions } = makeDeps(dir)
    sessions.set('chat-c', { id: 'chat-c', agent: 'claude-code', title: 'C', workspace: null, agent_native_session_id: nativeId })
    herdr.panes = [{ pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { kind: 'id', value: nativeId } }]
    await startBridge(deps)
    await expect(bridge!.promptSession('chat-c', 'run the tests')).resolves.toEqual({ paneId: 'w1:p2' })
    expect(herdr.requests.find(r => r.method === 'agent.prompt')?.params).toEqual({ target: 'w1:p2', text: 'run the tests' })
    herdr.promptError = { code: 'agent_blocked', message: 'blocked' }
    await expect(bridge!.promptSession('chat-c', 'again')).rejects.toMatchObject({ status: 409, code: 'agent_blocked' })
    await expect(bridge!.promptSession('missing', 'x')).rejects.toMatchObject({ status: 409 })
  })

  it('opens a Studio chat as a herdr pane with the routed launch command and env', async () => {
    const nativeId = '78787878-2222-3333-4444-555555555555'
    const { deps, sessions, links } = makeDeps(dir)
    sessions.set('chat-d', { id: 'chat-d', agent: 'claude-code', title: 'Refactor', workspace: dir, agent_native_session_id: nativeId })
    await startBridge(deps)
    const link = await bridge!.openSession('chat-d')
    expect(link).toMatchObject({ paneId: 'w9:p2', workspaceId: 'w9' })
    const apply = herdr.requests.find(r => r.method === 'layout.apply')!.params
    expect(apply.tab_id).toBe('w9:t1')
    expect(apply.root.command).toEqual(['claude', '--resume', nativeId])
    expect(apply.root.env).toEqual({ A: '1' })
    expect(links.get('chat-d')?.paneId).toBe('w9:p2')
    // A second open focuses the existing pane instead of starting another process.
    await bridge!.openSession('chat-d')
    expect(herdr.requests.filter(r => r.method === 'layout.apply')).toHaveLength(1)
    expect(herdr.requests.some(r => r.method === 'pane.focus' && r.params.pane_id === 'w9:p2')).toBe(true)
  })

  it('starts an agent and sends its first prompt once it is ready', async () => {
    const { deps } = makeDeps(dir)
    await startBridge(deps)
    const link = await bridge!.launchAgent('claude-code', { title: 'Fix flaky login test', prompt: 'Task: fix it', workspace: dir })
    expect(link.paneId).toBe('w9:p2')
    expect(herdr.requests.find(r => r.method === 'workspace.create')!.params.label).toBe('Fix flaky login test')
    // Not ready yet: no prompt is typed into a starting agent.
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(herdr.requests.some(r => r.method === 'agent.prompt')).toBe(false)
    Object.assign(herdr.panes.find(p => p.pane_id === 'w9:p2'), { agent: 'claude', agent_status: 'idle' })
    herdr.emit('pane.agent_status_changed', { pane_id: 'w9:p2', agent_status: 'idle' })
    await until(() => herdr.requests.some(r => r.method === 'agent.prompt'), 5000)
    expect(herdr.requests.filter(r => r.method === 'agent.prompt').map(r => r.params)).toEqual([{ target: 'w9:p2', text: 'Task: fix it' }])
  })

  it('creates an empty space in a folder', async () => {
    const { deps } = makeDeps(dir)
    await startBridge(deps)
    expect(await bridge!.createWorkspace({ cwd: dir, label: 'scratch' })).toEqual({ workspaceId: 'w9', paneId: 'w9:p1' })
    expect(herdr.requests.find(r => r.method === 'workspace.create')!.params).toMatchObject({ cwd: dir, label: 'scratch', focus: true })
  })

  it('handles many chats created and removed quickly without duplicates', async () => {
    const { deps, sessions, links } = makeDeps(dir)
    await startBridge(deps)
    const ids = Array.from({ length: 25 }, (_, i) => `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`)
    herdr.panes = ids.map((id, i) => ({ pane_id: `w1:p${i + 1}`, workspace_id: 'w1', agent: i % 2 ? 'codex' : 'claude', agent_status: 'working', agent_session: { kind: 'id', value: id } }))
    for (let i = 0; i < 10; i += 1) herdr.emit('pane_created')
    await until(() => sessions.size === 25)
    herdr.panes = herdr.panes.slice(0, 5)
    for (let i = 0; i < 10; i += 1) herdr.emit('pane_closed')
    await until(() => [...links.values()].filter(Boolean).length === 5)
    expect(sessions.size).toBe(25)
    expect(new Set([...sessions.keys()]).size).toBe(25)
  })

  it('does not resurrect a chat deleted in Studio while its agent is still live', async () => {
    const nativeId = '90909090-2222-3333-4444-555555555555'
    herdr.panes = [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', agent_session: { kind: 'id', value: nativeId } }]
    const { deps, sessions, links } = makeDeps(dir)
    await startBridge(deps)
    const id = herdrChatId(nativeId)
    expect(sessions.has(id)).toBe(true)
    sessions.delete(id)
    await bridge!.forgetSession(id)
    herdr.emit('pane_updated')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(sessions.has(id)).toBe(false)
    expect(links.get(id)).toBeNull()
  })
})
