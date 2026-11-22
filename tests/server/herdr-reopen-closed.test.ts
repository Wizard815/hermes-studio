import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closedChatEntries,
  HerdrBridge,
  MAX_CLOSED_CHATS,
  pushClosedChats,
  type ClosedChatEntry,
  type HerdrBridgeDeps,
  type HerdrLinkInfo,
  type HerdrSessionRef,
} from '../../packages/server/src/modules/coding-agents/services/herdr/bridge'
import { DEFAULT_HERDR_SETTINGS } from '../../packages/server/src/modules/coding-agents/services/herdr/runtime'
import { renderPluginManifest } from '../../packages/server/src/modules/coding-agents/services/herdr/plugin'
import {
  chooseStudioKey,
  existingStudioKey,
  herdrKeys,
  renderStudioBinding,
  STUDIO_REOPEN_ACTION,
  STUDIO_REOPEN_BINDING,
} from '../../packages/server/src/modules/coding-agents/services/herdr/keybind'
import { herdrManager } from '../../packages/server/src/modules/coding-agents/services/herdr/manager'
import * as ctrl from '../../packages/server/src/modules/coding-agents/controllers/herdr'
import { herdrPluginRoutes, herdrRoutes } from '../../packages/server/src/modules/coding-agents/routes/herdr'

const DEFAULT_CONFIG = readFileSync(join(__dirname, 'fixtures/herdr-default-config.toml'), 'utf8')

/** A herdr socket server holding spaces and panes; closes remove them like herdr does. */
class FakeHerdr {
  server: Server
  subscribers = new Set<Socket>()
  requests: Array<{ method: string; params: any }> = []
  panes: any[] = []
  workspaces: any[] = []
  processes: Record<string, Array<{ argv: string[] }>> = {}
  created = 0

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
    for (const socket of this.subscribers) socket.destroy()
    return new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private handle(socket: Socket, request: { id: string; method: string; params: any }) {
    this.requests.push({ method: request.method, params: request.params })
    const reply = (result: unknown) => socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
    switch (request.method) {
      case 'ping': return reply({ type: 'pong' })
      case 'events.subscribe':
        this.subscribers.add(socket)
        socket.on('close', () => this.subscribers.delete(socket))
        return reply({ type: 'subscription_started' })
      case 'session.snapshot':
        return reply({ type: 'session_snapshot', snapshot: { version: '0.9.5', workspaces: this.workspaces, panes: this.panes } })
      case 'workspace.create': {
        this.created += 1
        const id = `n${this.created}`
        this.workspaces.push({ workspace_id: id, label: request.params.label })
        return reply({ type: 'workspace_created', workspace: { workspace_id: id }, tab: { tab_id: `${id}:t1` }, root_pane: { pane_id: `${id}:p1` } })
      }
      case 'layout.apply': {
        const id = request.params.tab_id.split(':')[0]
        this.panes.push({ pane_id: `${id}:p2`, workspace_id: id, tab_id: request.params.tab_id, agent_status: 'unknown', cwd: request.params.root.cwd })
        return reply({ type: 'layout_apply', layout: { focused_pane_id: `${id}:p2` } })
      }
      case 'workspace.close':
        this.workspaces = this.workspaces.filter(w => w.workspace_id !== request.params.workspace_id)
        this.panes = this.panes.filter(p => p.workspace_id !== request.params.workspace_id)
        return reply({ type: 'ok' })
      case 'pane.process_info':
        return reply({ type: 'pane_process_info', process_info: { foreground_processes: this.processes[request.params.pane_id] ?? [] } })
      case 'pane.focus':
      case 'pane.send_keys':
      case 'pane.report_agent':
      case 'pane.rename':
      case 'workspace.rename':
      case 'workspace.move_block':
        return reply({ type: 'ok' })
      default:
        return socket.write(`${JSON.stringify({ id: request.id, error: { code: 'unknown_method', message: request.method } })}\n`)
    }
  }

  emit() { for (const socket of this.subscribers) socket.write(`${JSON.stringify({ event: 'pane.closed', data: {} })}\n`) }

  /** The user closes a pane, a tab or a space in herdr. */
  closePane(paneId: string) { this.panes = this.panes.filter(p => p.pane_id !== paneId); this.emit() }
  closeTab(tabId: string) { this.panes = this.panes.filter(p => p.tab_id !== tabId); this.emit() }
  closeSpace(workspaceId: string) {
    this.workspaces = this.workspaces.filter(w => w.workspace_id !== workspaceId)
    this.panes = this.panes.filter(p => p.workspace_id !== workspaceId)
    this.emit()
  }
}

const uuid = (n: number) => `${String(n).padStart(8, '0')}-2222-3333-4444-555555555555`

function makeDeps() {
  const sessions = new Map<string, HerdrSessionRef & { archived?: boolean }>()
  const links = new Map<string, HerdrLinkInfo | null>()
  const launched: string[] = []
  const deps: HerdrBridgeDeps = {
    findSessionByNativeId: nativeId => [...sessions.values()].find(s => s.agent_native_session_id === nativeId) ?? null,
    getSession: id => sessions.get(id) ?? null,
    createSession: input => { sessions.set(input.id, { id: input.id, agent: input.agent, title: input.title, workspace: input.workspace, agent_native_session_id: input.nativeId }) },
    updateNativeSessionId: (id, nativeId) => { const s = sessions.get(id); if (s) s.agent_native_session_id = nativeId },
    appendMessages: () => {},
    setLink: (id, link) => { links.set(id, link) },
    notifyUpdated: () => {},
    locateTranscript: async () => null,
    prepareSessionLaunch: async id => {
      launched.push(id)
      const row = sessions.get(id)!
      const agentId = row.agent
      const command = agentId === 'claude-code' ? 'claude' : `/opt/bin/${agentId}`
      return { agentId, command, args: ['--resume', row.agent_native_session_id], env: {}, workspaceDir: '/tmp', provider: 'llama-swap', model: 'qwen3' }
    },
    prepareAgentLaunch: async (agentId, input) => ({ agentId, command: `/opt/bin/${agentId}`, args: [], env: {}, workspaceDir: input.workspace || '/tmp', provider: input.provider || 'global', model: input.model || '' }),
    herdrKindFor: id => (id === 'claude-code' ? 'claude' : id === 'dsh' ? null : id),
    agentLabel: id => id,
    // Every chat that is not archived (archived chats have no herdr space).
    listChatSpaces: async () => [...sessions.values()].filter(s => !s.archived).map(s => ({ id: s.id, title: s.title || '', folderPath: [], agent: s.agent, hostable: true, workspace: null, lastActive: 0 })),
  }
  return { deps, sessions, links, launched }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition not met in time')
}

describe('closed chats (pure)', () => {
  const pane = (pane_id: string, workspace_id: string, tab_id: string, studioSessionId: string | null) => ({ pane_id, workspace_id, tab_id, studioSessionId })

  it('records a closed pane, tab or space as one entry each', () => {
    const before = [
      pane('w1:p1', 'w1', 'w1:t1', 'a'),
      pane('w1:p2', 'w1', 'w1:t2', 'b'), pane('w1:p3', 'w1', 'w1:t2', 'c'),
      pane('w2:p1', 'w2', 'w2:t1', 'd'), pane('w2:p2', 'w2', 'w2:t1', 'e'),
      pane('w3:p1', 'w3', 'w3:t1', 'f'), pane('w3:p2', 'w3', 'w3:t1', null),
    ]
    // a's pane closed, tab w1:t2 closed (b, c), space w2 closed (d, e); f stays.
    const after = [pane('w3:p1', 'w3', 'w3:t1', 'f'), pane('w1:p9', 'w1', 'w1:t1', null)]
    const entries = closedChatEntries({ before, after, workspaces: new Set(['w1', 'w3']), now: 5, titles: new Map([['a', 'Chat A']]) })
    expect(entries).toEqual([
      { at: 5, closed: 'pane', chats: [{ sessionId: 'a', paneId: 'w1:p1', workspaceId: 'w1', tabId: 'w1:t1', title: 'Chat A' }] },
      { at: 5, closed: 'tab', chats: [{ sessionId: 'b', paneId: 'w1:p2', workspaceId: 'w1', tabId: 'w1:t2' }, { sessionId: 'c', paneId: 'w1:p3', workspaceId: 'w1', tabId: 'w1:t2' }] },
      { at: 5, closed: 'workspace', chats: [{ sessionId: 'd', paneId: 'w2:p1', workspaceId: 'w2', tabId: 'w2:t1' }, { sessionId: 'e', paneId: 'w2:p2', workspaceId: 'w2', tabId: 'w2:t1' }] },
    ])
  })

  it('does not count spaces Studio closed itself, or a chat that only moved to another pane', () => {
    const before = [pane('w1:p1', 'w1', 'w1:t1', 'a'), pane('w2:p1', 'w2', 'w2:t1', 'b')]
    const after = [pane('w3:p1', 'w3', 'w3:t1', 'b')]
    expect(closedChatEntries({ before, after, workspaces: new Set(['w3']), studioClosed: new Set(['w1']) })).toEqual([])
  })

  it('keeps the newest entries, up to the cap', () => {
    const entry = (n: number): ClosedChatEntry => ({ at: n, closed: 'pane', chats: [{ sessionId: `s${n}`, paneId: `p${n}`, workspaceId: 'w' }] })
    let stack: ClosedChatEntry[] = []
    for (let n = 1; n <= MAX_CLOSED_CHATS + 7; n += 1) stack = pushClosedChats(stack, [entry(n)])
    expect(stack).toHaveLength(MAX_CLOSED_CHATS)
    expect(stack[0].at).toBe(8)
    expect(stack.at(-1)!.at).toBe(MAX_CLOSED_CHATS + 7)
  })
})

describe('Reopen closed chat in Studio\'s herdr plugin', () => {
  it('adds the plugin action and binds prefix+t, free in herdr\'s defaults', () => {
    const manifest = renderPluginManifest('/usr/bin/node', '/opt/studio/bin/herdr-plugin/studio-herdr.mjs', '/usr/local/bin/herdr')
    expect(manifest).toContain('id = "reopen"')
    expect(manifest).toContain('title = "Reopen closed chat"')
    expect(manifest).toContain('command = ["/usr/bin/node", "/opt/studio/bin/herdr-plugin/studio-herdr.mjs", "reopen"]')
    expect(STUDIO_REOPEN_ACTION).toBe('studio.hermes.reopen')
    const key = chooseStudioKey(DEFAULT_CONFIG, '', STUDIO_REOPEN_BINDING.candidates)
    expect(key).toBe('prefix+t')
    // herdr's own prefix+shift+t (rename tab) is not ours; a user's prefix+t moves Studio on.
    expect(chooseStudioKey(DEFAULT_CONFIG, '[[keys.command]]\nkey = "prefix+t"\ntype = "popup"\ncommand = "x"\n', STUDIO_REOPEN_BINDING.candidates)).toBe('prefix+alt+t')
    const config = renderStudioBinding(key!, STUDIO_REOPEN_BINDING)
    expect(config).toContain('command = "studio.hermes.reopen"')
    expect(existingStudioKey(config, STUDIO_REOPEN_ACTION)).toBe('prefix+t')
    expect(herdrKeys(config).reopen).toBe('prefix+t')
  })

  it('has a super-admin route and a plugin route', () => {
    const paths = (router: any) => router.stack.map((layer: any) => `${layer.methods.filter((m: string) => m !== 'HEAD').join(',')} ${layer.path}`)
    expect(paths(herdrRoutes)).toContain('POST /api/coding-agents/herdr/closed-chats/reopen')
    expect(paths(herdrRoutes)).toContain('GET /api/coding-agents/herdr/closed-chats')
    expect(paths(herdrPluginRoutes)).toContain('POST /api/coding-agents/herdr/plugin/reopen')
  })

  it('the route reopens through the bridge and reports when nothing is left', async () => {
    const reopenClosed = vi.fn()
      .mockResolvedValueOnce({ reopened: [{ sessionId: 's1', title: 'One', link: { paneId: 'p', workspaceId: 'w', status: 'unknown' } }], remaining: 0 })
      .mockResolvedValueOnce({ reopened: [], remaining: 0 })
    const spy = vi.spyOn(herdrManager, 'requireBridge').mockReturnValue({ reopenClosed } as any)
    try {
      const ctx: any = { state: {}, request: { body: {} } }
      await ctrl.reopenClosedChat(ctx)
      expect(ctx.body.reopened.map((chat: any) => chat.sessionId)).toEqual(['s1'])
      await ctrl.reopenClosedChat(ctx)
      expect(ctx.body).toEqual({ reopened: [], remaining: 0 })
    } finally { spy.mockRestore() }
  })
})

describe('herdr bridge: closed chats and reopening them', () => {
  let dir: string
  let herdr: FakeHerdr
  let bridge: HerdrBridge | null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'herdr-reopen-'))
    herdr = new FakeHerdr(join(dir, 'herdr.sock'))
    await herdr.listen()
    bridge = null
  })

  afterEach(async () => {
    bridge?.stop()
    await herdr.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function startBridge(deps: HerdrBridgeDeps) {
    bridge = new HerdrBridge({ ...DEFAULT_HERDR_SETTINGS, enabled: true, chatSpaces: false }, deps, join(dir, 'state.json'), async () => herdr.path)
    return bridge.start()
  }

  /** Three Claude chats, each live in its own herdr space. */
  function threeChats(sessions: ReturnType<typeof makeDeps>['sessions']) {
    for (const n of [1, 2, 3]) {
      sessions.set(`chat-${n}`, { id: `chat-${n}`, agent: 'claude-code', title: `Chat ${n}`, workspace: null, agent_native_session_id: uuid(n) })
      herdr.workspaces.push({ workspace_id: `w${n}`, label: `Chat ${n}` })
      herdr.panes.push({ pane_id: `w${n}:p1`, workspace_id: `w${n}`, tab_id: `w${n}:t1`, agent: 'claude', agent_status: 'idle', agent_session: { kind: 'id', value: uuid(n) } })
    }
  }

  it('remembers chats closed in herdr (persisted), newest last, and reopens them newest first', async () => {
    const { deps, sessions, launched } = makeDeps()
    threeChats(sessions)
    await startBridge(deps)
    // Its tab's only pane: herdr closes the tab with it.
    herdr.closePane('w1:p1')
    await until(() => bridge!.closedChats().length === 1)
    herdr.closeSpace('w2')
    await until(() => bridge!.closedChats().length === 2)
    expect(bridge!.closedChats().map(entry => [entry.closed, entry.chats.map(chat => chat.sessionId)])).toEqual([['tab', ['chat-1']], ['workspace', ['chat-2']]])
    await until(async () => (JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).closedChats || []).length === 2)

    // A Studio restart keeps the stack.
    bridge!.stop()
    const again = makeDeps()
    for (const [id, row] of sessions) again.sessions.set(id, row)
    await startBridge(again.deps)
    expect(bridge!.closedChats()).toHaveLength(2)

    const first = await bridge!.reopenClosed()
    expect(first.reopened.map(chat => chat.sessionId)).toEqual(['chat-2'])
    expect(again.launched).toEqual(['chat-2'])
    // Resumed with its own native session, as the chat's pane.
    const apply = herdr.requests.filter(r => r.method === 'layout.apply').at(-1)!
    expect(apply.params.root.command).toEqual(['claude', '--resume', uuid(2)])
    const second = await bridge!.reopenClosed()
    expect(second.reopened.map(chat => chat.sessionId)).toEqual(['chat-1'])
    expect(second.remaining).toBe(0)
    expect(await bridge!.reopenClosed()).toEqual({ reopened: [], remaining: 0 })
    expect(launched).toEqual([])
  })

  it('a closed tab with several chats is one entry and comes back together', async () => {
    const { deps, sessions } = makeDeps()
    for (const n of [1, 2]) {
      sessions.set(`chat-${n}`, { id: `chat-${n}`, agent: 'claude-code', title: `Chat ${n}`, workspace: null, agent_native_session_id: uuid(n) })
      herdr.panes.push({ pane_id: `w1:p${n}`, workspace_id: 'w1', tab_id: 'w1:t2', agent: 'claude', agent_status: 'idle', agent_session: { kind: 'id', value: uuid(n) } })
    }
    herdr.workspaces.push({ workspace_id: 'w1', label: 'two' })
    herdr.panes.push({ pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'unknown' })
    await startBridge(deps)
    herdr.closeTab('w1:t2')
    await until(() => bridge!.closedChats().length === 1)
    expect(bridge!.closedChats()[0]).toMatchObject({ closed: 'tab', chats: [{ sessionId: 'chat-1' }, { sessionId: 'chat-2' }] })
    const result = await bridge!.reopenClosed()
    expect(result.reopened.map(chat => chat.sessionId).sort()).toEqual(['chat-1', 'chat-2'])
  })

  it('skips chats that are open again, deleted or archived, going further back', async () => {
    const { deps, sessions } = makeDeps()
    threeChats(sessions)
    sessions.set('chat-4', { id: 'chat-4', agent: 'claude-code', title: 'Chat 4', workspace: null, agent_native_session_id: uuid(4) })
    herdr.workspaces.push({ workspace_id: 'w4', label: 'Chat 4' })
    herdr.panes.push({ pane_id: 'w4:p1', workspace_id: 'w4', tab_id: 'w4:t1', agent: 'claude', agent_status: 'idle', agent_session: { kind: 'id', value: uuid(4) } })
    await startBridge(deps)
    for (const n of [1, 2, 3, 4]) {
      herdr.closeSpace(`w${n}`)
      await until(() => bridge!.closedChats().length === n)
    }
    // chat-4 is open again (its agent runs in herdr), chat-3 was deleted, chat-2 archived.
    herdr.workspaces.push({ workspace_id: 'w5', label: 'Chat 4' })
    herdr.panes.push({ pane_id: 'w5:p1', workspace_id: 'w5', tab_id: 'w5:t1', agent: 'claude', agent_status: 'idle', agent_session: { kind: 'id', value: uuid(4) } })
    herdr.emit()
    await until(() => bridge!.linkFor('chat-4')?.paneId === 'w5:p1')
    sessions.delete('chat-3')
    sessions.get('chat-2')!.archived = true
    const result = await bridge!.reopenClosed()
    expect(result.reopened.map(chat => chat.sessionId)).toEqual(['chat-1'])
    expect(result.remaining).toBe(0)
    expect(bridge!.closedChats()).toEqual([])
  })

  it('does not count a waiting space Studio closes itself (the chat was deleted)', async () => {
    const { deps, sessions } = makeDeps()
    sessions.set('chat-x', { id: 'chat-x', agent: 'claude-code', title: 'X', workspace: null, agent_native_session_id: uuid(7) })
    deps.chatPane = async () => ({ script: '/opt/studio-chat.sh', env: {}, cardsDir: join(dir, 'cards'), studioUrl: 'http://studio' })
    bridge = new HerdrBridge({ ...DEFAULT_HERDR_SETTINGS, enabled: true, chatSpaces: true, chatSpacesAwakeDays: 0 }, deps, join(dir, 'state.json'), async () => herdr.path)
    await bridge.start()
    await until(() => bridge!.getState().panes.some(pane => pane.studioSessionId === 'chat-x'))
    sessions.delete('chat-x')
    bridge.scheduleChatSync(0)
    await until(() => herdr.requests.some(r => r.method === 'workspace.close'))
    herdr.emit()
    await until(() => !bridge!.getState().panes.some(pane => pane.studioSessionId === 'chat-x'))
    expect(bridge.closedChats()).toEqual([])
  })

  it('lists a chat\'s waiting pane until its agent runs there (Herdr App layout: not an agent)', async () => {
    const { deps, sessions } = makeDeps()
    sessions.set('chat-w', { id: 'chat-w', agent: 'claude-code', title: 'W', workspace: null, agent_native_session_id: uuid(8) })
    deps.chatPane = async () => ({ script: '/opt/studio-chat.sh', env: {}, cardsDir: join(dir, 'cards'), studioUrl: 'http://studio' })
    bridge = new HerdrBridge({ ...DEFAULT_HERDR_SETTINGS, enabled: true, chatSpaces: true, chatSpacesAwakeDays: 0 }, deps, join(dir, 'state.json'), async () => herdr.path)
    await bridge.start()
    await until(() => bridge!.getState().panes.some(pane => pane.studioSessionId === 'chat-w'))
    const paneId = bridge.getState().panes.find(pane => pane.studioSessionId === 'chat-w')!.pane_id
    expect(bridge.getState().waitingPanes).toEqual([paneId])
    // Enter in the waiting pane: the chat's own agent runs there now.
    Object.assign(herdr.panes.find(pane => pane.pane_id === paneId)!, { agent: 'claude', agent_status: 'working', agent_session: { kind: 'id', value: uuid(8) } })
    herdr.emit()
    await until(() => (bridge!.getState().waitingPanes || []).length === 0)
    expect(bridge.getState().panes.find(pane => pane.pane_id === paneId)?.studioSessionId).toBe('chat-w')
  })

  it('does not count a herdr restart as closes', async () => {
    const { deps, sessions } = makeDeps()
    threeChats(sessions)
    await startBridge(deps)
    // herdr starts over: every pane is gone with the old server (not closes).
    bridge!.stop()
    herdr.panes = []
    herdr.workspaces = []
    await startBridge(deps)
    expect(bridge!.closedChats()).toEqual([])
  })

  it('a closed chat is closed for "hand-opened chats" too; reopening opens it by hand again', async () => {
    const { deps, sessions } = makeDeps()
    threeChats(sessions)
    await startBridge(deps)
    await bridge!.openSession('chat-1')
    let state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    expect(state.openedChats['chat-1']).toBeTypeOf('number')
    herdr.closeSpace('w1')
    await until(() => bridge!.closedChats().length === 1)
    await until(async () => !(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).openedChats || {})['chat-1'])
    await bridge!.reopenClosed()
    state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    expect(state.openedChats['chat-1']).toBeTypeOf('number')
  })
})

describe('herdr bridge: agents herdr cannot detect (CodeBuddy, ZCode)', () => {
  let dir: string
  let herdr: FakeHerdr
  let bridge: HerdrBridge | null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'herdr-undetected-'))
    herdr = new FakeHerdr(join(dir, 'herdr.sock'))
    await herdr.listen()
    bridge = null
  })

  afterEach(async () => {
    bridge?.stop()
    await herdr.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function startBridge(deps: HerdrBridgeDeps) {
    bridge = new HerdrBridge({ ...DEFAULT_HERDR_SETTINGS, enabled: true, chatSpaces: false }, deps, join(dir, 'state.json'), async () => herdr.path)
    return bridge.start()
  }

  for (const agent of ['codebuddy', 'zcode']) {
    it(`${agent}: a new chat is a Studio chat at once, its pane is reported to herdr and stays linked across a Studio restart`, async () => {
      const { deps, sessions, links } = makeDeps()
      await startBridge(deps)
      const link = await bridge!.launchAgent(agent, { title: `My ${agent} chat` })
      const sessionId = [...sessions.keys()][0]
      expect(sessions.get(sessionId)).toMatchObject({ agent, title: `My ${agent} chat`, agent_native_session_id: '' })
      expect(links.get(sessionId)).toMatchObject({ paneId: link.paneId })
      // Once the CLI runs in the pane, Studio reports the pane as that agent (herdr cannot tell its state).
      herdr.processes[link.paneId] = [{ argv: [`/opt/bin/${agent}`] }]
      await until(() => herdr.requests.some(r => r.method === 'pane.report_agent'))
      expect(herdr.requests.find(r => r.method === 'pane.report_agent')!.params).toEqual({ pane_id: link.paneId, source: 'studio:chat', agent, state: 'unknown' })
      herdr.panes.find(p => p.pane_id === link.paneId).agent = agent
      herdr.emit()
      await until(() => bridge!.getState().panes.some(p => p.pane_id === link.paneId && p.studioSessionId === sessionId && p.studioAgent === agent))
      await until(async () => !!JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).hosted?.[link.paneId])

      bridge!.stop()
      const again = makeDeps()
      for (const [id, row] of sessions) again.sessions.set(id, row)
      await startBridge(again.deps)
      expect(again.links.get(sessionId)).toMatchObject({ paneId: link.paneId, status: 'unknown' })

      // Closing it puts it on the closed stack; reopening resumes the same chat.
      herdr.closePane(link.paneId)
      await until(() => bridge!.closedChats().length === 1)
      const result = await bridge!.reopenClosed()
      expect(result.reopened.map(chat => chat.sessionId)).toEqual([sessionId])
    })
  }

  it('a waiting pane resumes the CLI on Enter; herdr lists it under a name it keeps while the shell waits', async () => {
    const { deps, sessions } = makeDeps()
    sessions.set('cb', { id: 'cb', agent: 'codebuddy', title: 'CB', workspace: null, agent_native_session_id: 'native-cb' })
    deps.chatPane = async () => ({ script: '/opt/studio-chat.sh', env: {}, cardsDir: join(dir, 'cards'), studioUrl: 'http://studio' })
    bridge = new HerdrBridge({ ...DEFAULT_HERDR_SETTINGS, enabled: true, chatSpaces: true, chatSpacesAwakeDays: 0 }, deps, join(dir, 'state.json'), async () => herdr.path)
    await bridge.start()
    await until(() => herdr.requests.some(r => r.method === 'layout.apply'))
    const env = herdr.requests.find(r => r.method === 'layout.apply')!.params.root.env
    expect(env).toMatchObject({ STUDIO_CHAT_KIND: 'codebuddy', STUDIO_CHAT_AGENT: 'hermes' })
  })

  it('a waiting pane resumes the agent and reports it; a pane that runs something else is not linked after a restart', async () => {
    const { deps, sessions } = makeDeps()
    sessions.set('cb', { id: 'cb', agent: 'codebuddy', title: 'CB', workspace: null, agent_native_session_id: 'native-cb' })
    herdr.workspaces.push({ workspace_id: 'w1', label: 'CB' })
    herdr.panes.push({ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'unknown' })
    herdr.processes['w1:p1'] = [{ argv: ['/opt/bin/codebuddy', '--resume', 'native-cb'] }]
    await startBridge(deps)
    const launch = await bridge!.prepareResume('cb', 'w1:p1')
    expect(launch.args).toEqual(['--resume', 'native-cb'])
    await until(() => herdr.requests.some(r => r.method === 'pane.report_agent' && r.params.agent === 'codebuddy'))
    bridge!.stop()
    // After a herdr restart the pane id now runs a plain shell: not the chat's.
    herdr.panes[0].agent = undefined
    const again = makeDeps()
    for (const [id, row] of sessions) again.sessions.set(id, row)
    await startBridge(again.deps)
    expect(again.links.get('cb') ?? null).toBeNull()
  })
})
