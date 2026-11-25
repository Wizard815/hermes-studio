import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_WATCHER_SETTINGS, sanitizeWatcherSettings, trustPatternMatches, type TrustRule } from '../../packages/shared/watcher'
import { WatcherStore } from '../../packages/server/src/modules/studio/services/watcher/store'
import { WatcherConfigFile, sanitizeTrustRule } from '../../packages/server/src/modules/studio/services/watcher/config'
import { findTrustRule } from '../../packages/server/src/modules/studio/services/watcher/trust'
import { WatcherExtras, innerwardenHooked, langfuseConfig } from '../../packages/server/src/modules/studio/services/watcher/extras'
import { closeWatcher, configureWatcher, observeWatcherChatEvent, recordWatcherEvent, type WatcherService } from '../../packages/server/src/modules/studio/services/watcher'
import { watchAgentWork } from '../../packages/server/src/modules/studio/services/agent-work'
import { chatApprovalOverride, setChatApprovalOverride, writeAgentApprovalSettings } from '../../packages/server/src/modules/coding-agents/services/approvals'
import { handleProxy, openUpstream } from '../../packages/server/src/modules/coding-agents/services/cleanroom'
import { waitForEkkoToolApproval } from '../../packages/server/src/modules/ekko/services/approvals'
import { cronModeFrom } from '../../packages/server/src/modules/hermes/services/cron/approval-mode'
import { codingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { configureRunState } from '../../packages/server/src/modules/studio/public/run-state'
import { applyResponseStreamEvent, flushResponseRunToDb } from '../../packages/server/src/modules/studio/services/chat-run/response-stream'
import { extractResponseText } from '../../packages/server/src/modules/studio/services/chat-run/response-utils'

function setup(options: { now?: () => number; settings?: unknown; mattermost?: (event: any, title: string) => Promise<boolean>; tasks?: Record<string, string[]> } = {}) {
  const db = new DatabaseSync(':memory:')
  const store = new WatcherStore(db)
  const config = new WatcherConfigFile(() => join(mkdtempSync(join(tmpdir(), 'watcher-')), 'watcher.json'))
  if (options.settings) config.saveSettings(options.settings)
  const emitted: Array<{ event: string; payload: any }> = []
  const service = configureWatcher({
    store, config,
    emit: (event, payload) => { emitted.push({ event, payload }) },
    mattermost: options.mattermost,
    sessionInfo: id => ({ title: `Chat ${id}`, agent: 'codex', folder: '/srv/app' }),
    tasksForSession: id => options.tasks?.[id] || [],
    chatApprovalMode: id => chatApprovalOverride(id),
    setChatApprovalMode: (id, mode) => setChatApprovalOverride(id, mode),
    now: options.now,
  })
  return { service, store, config, emitted }
}

afterEach(() => closeWatcher())

describe('the watcher keeps a small history', () => {
  it('prunes by count and by age', () => {
    const store = new WatcherStore(new DatabaseSync(':memory:'))
    const day = 86_400_000
    for (let i = 0; i < 10; i += 1) store.add({ kind: 'approval_asked', severity: 'warn', text: `old ${i}` }, 1_000 + i)
    for (let i = 0; i < 10; i += 1) store.add({ kind: 'approval_asked', severity: 'warn', text: `new ${i}` }, 40 * day + i)
    // Age first: the ten from day 0 are older than 30 days.
    expect(store.prune(100, 30 * day, 40 * day + 20)).toBe(10)
    expect(store.total()).toBe(10)
    // Then count: only the newest 4 stay.
    store.prune(4, 30 * day, 40 * day + 20)
    expect(store.list().map(event => event.text)).toEqual(['new 9', 'new 8', 'new 7', 'new 6'])
  })

  it('records what Settings keeps, drops repeats, and posts the kinds Settings sends to Mattermost', async () => {
    let now = 1_000_000
    const posted: any[] = []
    const { service, emitted } = setup({ now: () => now, mattermost: async (event, title) => { posted.push({ kind: event.kind, title }); return true } })
    // Run limits post to Mattermost by default (as before the watcher); approvals do not.
    expect(service.record({ kind: 'run_limit', severity: 'block', sessionId: 's1', text: 'cost limit reached' })).toMatchObject({ kind: 'run_limit', agent: 'codex', folder: '/srv/app', link: '/hermes/session/s1', read: false })
    expect(service.record({ kind: 'approval_asked', severity: 'warn', sessionId: 's1', text: 'Codex asks to run: rm x' })).not.toBeNull()
    // The same alert again within a minute is a repeat.
    expect(service.record({ kind: 'run_limit', severity: 'block', sessionId: 's1', text: 'cost limit reached' })).toBeNull()
    now += 61_000
    expect(service.record({ kind: 'run_limit', severity: 'block', sessionId: 's1', text: 'cost limit reached' })).not.toBeNull()
    // Approved approvals are off by default.
    expect(service.record({ kind: 'approval_approved', severity: 'info', sessionId: 's1', text: 'Approved' })).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(posted).toEqual([{ kind: 'run_limit', title: 'Chat s1' }, { kind: 'run_limit', title: 'Chat s1' }])
    expect(emitted.filter(entry => entry.event === 'watcher.event').map(entry => entry.payload.unread)).toEqual([1, 2, 3])

    service.saveSettings({ kinds: { approval_asked: { alert: false } } })
    expect(service.record({ kind: 'approval_asked', severity: 'warn', sessionId: 's2', text: 'asks again' })).toBeNull()
  })

  it('marks read, marks all read and clears', () => {
    const { service } = setup()
    const a = service.record({ kind: 'cleanroom_blocked', severity: 'block', sessionId: 'a', text: 'blocked evil.example' })!
    service.record({ kind: 'cleanroom_leak', severity: 'warn', sessionId: 'a', text: '.env in the folder' })
    expect(service.list().unread).toBe(2)
    expect(service.markRead([a.id])).toEqual({ unread: 1 })
    expect(service.list().events.find(event => event.id === a.id)?.read).toBe(true)
    expect(service.markAllRead()).toEqual({ unread: 0 })
    expect(service.clear([a.id])).toEqual({ unread: 0 })
    expect(service.list().total).toBe(1)
    service.clear()
    expect(service.list().total).toBe(0)
  })

  it('keeps settings within bounds', () => {
    const settings = sanitizeWatcherSettings({ historySize: 9, maxAgeDays: 9999, extras: { pipelock: { enabled: true, proxyUrl: 'javascript:alert(1)' } } })
    expect(settings.historySize).toBe(50)
    expect(settings.maxAgeDays).toBe(365)
    expect(settings.extras.pipelock).toEqual({ enabled: true, proxyUrl: DEFAULT_WATCHER_SETTINGS.extras.pipelock.proxyUrl })
    expect(settings.extras.innerwarden.enabled).toBe(false)
    expect(settings.extras.langfuse.enabled).toBe(false)
  })
})

describe('approvals from every chat type reach the feed', () => {
  it('notes asked, denied and approved, with the action "Trust this" would allow', () => {
    const { service } = setup()
    observeWatcherChatEvent('chat-h', 'approval.requested', { approval_id: 'ap-1', command: 'rm -rf /srv/data/cache' }, 'bridge')
    observeWatcherChatEvent('chat-h', 'approval.requested', { approval_id: 'ap-1', command: 'rm -rf /srv/data/cache' }, 'bridge')
    observeWatcherChatEvent('chat-h', 'approval.resolved', { approval_id: 'ap-1', choice: 'deny', reason: 'No answer in time' }, 'bridge')
    observeWatcherChatEvent('chat-h', 'approval.resolved', { approval_id: 'ap-1', choice: 'deny' }, 'bridge')
    observeWatcherChatEvent('chat-c', 'approval.requested', { approval_id: 'ap-2', title: 'Codex wants to edit', trust_action: { kind: 'write', value: '/etc/hosts' }, source: 'codex' }, 'codex')
    const events = service.list().events
    expect(events.map(event => [event.kind, event.severity, event.text])).toEqual([
      ['approval_asked', 'warn', 'Codex asks to run: Codex wants to edit'],
      ['approval_denied', 'block', 'Denied (No answer in time): rm -rf /srv/data/cache'],
      ['approval_asked', 'warn', 'Hermes asks to run: rm -rf /srv/data/cache'],
    ])
    expect(events[0].action).toEqual({ kind: 'write', value: '/etc/hosts' })
    expect(events[1]).toMatchObject({ agent: 'hermes', action: { kind: 'command', value: 'rm -rf /srv/data/cache' } })
    // Approved ones are kept when Settings turns them on.
    service.saveSettings({ kinds: { approval_approved: { alert: true } } })
    observeWatcherChatEvent('chat-c', 'approval.resolved', { approval_id: 'ap-2', choice: 'session' }, 'codex')
    expect(service.list().events[0]).toMatchObject({ kind: 'approval_approved', severity: 'info', text: 'Approved for this chat: Codex wants to edit' })
  })

  it('notes Agent work waiting, blocked and decided', () => {
    const { service } = setup()
    const work = { id: 'w1', title: 'Fix login', agent: 'codex', sessionId: 'chat-w', status: 'awaiting_approval', summary: '', decision: '', decidedVia: '', decidedBy: '' } as any
    watchAgentWork(work, 'status')
    watchAgentWork({ ...work, status: 'blocked', summary: 'needs a key' }, 'status')
    service.saveSettings({ kinds: { work_decided: { alert: true } } })
    watchAgentWork({ ...work, status: 'done', decision: 'approved', decidedVia: 'mattermost', decidedBy: 'robin' }, 'decided')
    expect(service.list().events.map(event => [event.kind, event.text, event.taskId, event.link])).toEqual([
      ['work_decided', 'Approved in Mattermost by robin: Fix login', 'w1', '/hermes/connections?tab=agent-work'],
      ['work_blocked', 'Blocked: Fix login (needs a key)', 'w1', '/hermes/connections?tab=agent-work'],
      ['work_approval', 'Waiting for your approval: Fix login', 'w1', '/hermes/connections?tab=agent-work'],
    ])
  })
})

describe('trust rules', () => {
  const rule = (input: Partial<TrustRule>): TrustRule => ({ id: 'r', kind: 'command', scope: 'chat', target: 'c1', pattern: 'npm run *', expiresAt: 0, createdAt: 0, createdBy: '', note: '', ...input })

  it('match by pattern, scope and expiry', () => {
    expect(trustPatternMatches('npm run *', 'npm run build')).toBe(true)
    expect(trustPatternMatches('npm run *', 'npm install x')).toBe(false)
    expect(trustPatternMatches('rm /tmp/a.txt', 'rm /tmp/a.txt')).toBe(true)
    expect(trustPatternMatches('rm /tmp/a.txt', 'rm /tmp/a.txt; rm -rf /')).toBe(false)
    const request = { kind: 'command' as const, values: ['npm run build'] }
    expect(findTrustRule([rule({})], { sessionId: 'c1' }, request, 10)).not.toBeNull()
    expect(findTrustRule([rule({})], { sessionId: 'c2' }, request, 10)).toBeNull()
    expect(findTrustRule([rule({ expiresAt: 5 })], { sessionId: 'c1' }, request, 10)).toBeNull()
    expect(findTrustRule([rule({ kind: 'write' })], { sessionId: 'c1' }, request, 10)).toBeNull()
    expect(findTrustRule([rule({ scope: 'agent', target: 'codex' })], { agentId: 'codex' }, request, 10)).not.toBeNull()
    expect(findTrustRule([rule({ scope: 'task', target: 'w1' })], { taskIds: ['w1'] }, request, 10)).not.toBeNull()
    expect(findTrustRule([rule({ scope: 'folder', target: '/srv/app' })], { folder: '/srv/app/web' }, request, 10)).not.toBeNull()
    expect(findTrustRule([rule({ scope: 'folder', target: '/srv/app' })], { folder: '/srv/apple' }, request, 10)).toBeNull()
    // Every written path must match.
    const writes = { kind: 'write' as const, values: ['/srv/data/a', '/etc/passwd'] }
    expect(findTrustRule([rule({ kind: 'write', pattern: '/srv/data/*' })], { sessionId: 'c1' }, writes, 10)).toBeNull()
  })

  it('say what is wrong with a rule in plain words', () => {
    expect(() => sanitizeTrustRule({ kind: 'command', scope: 'agent', target: 'codex', pattern: '*' }, 1)).toThrow('"*" alone allows everything')
    expect(() => sanitizeTrustRule({ kind: 'command', scope: 'folder', target: 'app', pattern: 'ls' }, 1)).toThrow('full path')
    expect(() => sanitizeTrustRule({ kind: 'command', scope: 'chat', target: 'c', pattern: 'ls', expiresAt: 1 }, 5)).toThrow('already past')
    expect(sanitizeTrustRule({ kind: 'tool', scope: 'chat', target: 'c', pattern: 'Bash', expiresAt: 100 }, 5, 'admin')).toMatchObject({ kind: 'tool', expiresAt: 100, createdBy: 'admin' })
  })

  it('answer a task\'s approvals and note it, while other chats still ask', () => {
    const { service } = setup({ tasks: { 'chat-t': ['w7'] } })
    service.addRule({ kind: 'command', scope: 'task', target: 'w7', pattern: 'make deploy*' })
    expect(service.trusts({ sessionId: 'chat-t' }, { kind: 'command', values: ['make deploy-staging'] })).not.toBeNull()
    expect(service.trusts({ sessionId: 'chat-x' }, { kind: 'command', values: ['make deploy-staging'] })).toBeNull()
    // approval_trusted is off by default in the bell; on, it shows.
    service.saveSettings({ kinds: { approval_trusted: { alert: true } } })
    service.trusts({ sessionId: 'chat-t' }, { kind: 'command', values: ['make deploy-prod'] })
    expect(service.list().events[0]).toMatchObject({ kind: 'approval_trusted', severity: 'info' })
    expect(service.rules()).toHaveLength(1)
    expect(service.removeRule(service.rules()[0].id)).toBe(true)
    expect(service.rules()).toHaveLength(0)
  })
})

describe('trust rules feed the approval policy; auto mode is never held up', () => {
  const sessionId = `watch-run-${Date.now().toString(36)}`
  const emitted: Array<{ event: string; payload: any }> = []
  let watcher: WatcherService

  beforeAll(() => { initAllHermesTables() })
  beforeEach(() => {
    emitted.length = 0
    watcher = setup().service
    writeAgentApprovalSettings({ agents: { codex: 'ask' } })
    setChatApprovalOverride(sessionId, null)
    configureRunState({
      applyResponseStreamEvent, calcAndUpdateUsage: async () => ({}), completeWorkspaceRunCheckpoint: () => undefined,
      extractResponseText, flushResponseRunToDb,
      getChatRunServer: () => ({ emitExternalEvent: (_id: string, event: string, payload: unknown) => { emitted.push({ event, payload }) } }),
      getOrCreateSession: () => ({ messages: [], isWorking: false, events: [], queue: [] }),
      startWorkspaceRunCheckpoint: () => undefined, updateContextTokenUsage: () => undefined,
    } as any)
    codingAgentRunManager.start({ agentSessionId: sessionId, agentId: 'codex', mode: 'global', profile: 'default', provider: 'custom:llama',
      model: 'qwen3-coder-next', sessionId, command: 'codex', args: [], shellCommand: '', workspaceDir: '/srv/app' })
  })
  afterEach(() => {
    codingAgentRunManager.stop(sessionId)
    setChatApprovalOverride(sessionId, null)
  })

  const run = () => (codingAgentRunManager as any).runs.get(sessionId)
  const command = { key: 'command:rm', action: { kind: 'command' as const, command: 'rm /srv/shared/cache.db' }, title: 'Codex wants to run a command', command: 'rm /srv/shared/cache.db' }

  it('asks without a rule (with the action in the card), and goes through with one', async () => {
    void codingAgentRunManager.askApproval(run(), command)
    const asked = emitted.find(entry => entry.event === 'approval.requested')
    expect(asked?.payload.trust_action).toEqual({ kind: 'command', value: 'rm /srv/shared/cache.db' })
    emitted.length = 0
    watcher.addRule({ kind: 'command', scope: 'chat', target: sessionId, pattern: 'rm /srv/shared/*' })
    expect(await codingAgentRunManager.askApproval(run(), command)).toBe('once')
    expect(emitted.some(entry => entry.event === 'approval.requested')).toBe(false)
  })

  it('a task set to auto runs unattended; set back to inherit it asks again', async () => {
    watcher.setChatMode(sessionId, 'auto')
    expect(await codingAgentRunManager.askApproval(run(), command)).toBe('once')
    expect(emitted.some(entry => entry.event === 'approval.requested')).toBe(false)
    watcher.setChatMode(sessionId, null)
    void codingAgentRunManager.askApproval(run(), command)
    expect(emitted.some(entry => entry.event === 'approval.requested')).toBe(true)
  })

  it('in auto mode nothing the watcher sees stops the run', async () => {
    writeAgentApprovalSettings({ agents: { codex: 'auto' } })
    // Alerts of every kind arrive; none of them answers or blocks an approval.
    recordWatcherEvent({ kind: 'cleanroom_leak', severity: 'warn', sessionId, text: '.env found' })
    recordWatcherEvent({ kind: 'approval_denied', severity: 'block', sessionId, text: 'denied earlier' })
    expect(await codingAgentRunManager.askApproval(run(), { ...command, command: 'sudo rm -rf /', action: { kind: 'command', command: 'sudo rm -rf /' } })).toBe('once')
    writeAgentApprovalSettings({ agents: { codex: 'ask' } })
  })

  it('Ekko\'s approvals follow trust rules too', async () => {
    watcher.addRule({ kind: 'command', scope: 'agent', target: 'ekko', pattern: 'git status*' })
    const choice = await waitForEkkoToolApproval({ approvalId: 'e1', toolName: 'terminal', key: 'terminal', command: 'git status --short', description: '', choices: ['once', 'deny'], allowPermanent: false, timeoutMs: 1000 },
      { sessionId: 'ekko-chat', onRequested: () => { throw new Error('should not ask') } })
    expect(choice).toBe('once')
  })
})

describe('clean rooms report to the watcher', () => {
  let servers: Server[] = []
  afterEach(() => { for (const server of servers) server.close(); servers = [] })
  const listen = (handler: (socket: Socket) => void) => new Promise<number>(resolve => {
    const server = createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port))
  })
  const ask = (port: number, request: string) => new Promise<string>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(request))
    let reply = ''
    socket.on('data', chunk => { reply += chunk.toString() })
    socket.on('close', () => resolve(reply))
    setTimeout(() => { socket.destroy(); resolve(reply) }, 2000)
  })

  it('a connection the allowlist refuses is a block in the bell', async () => {
    const { service } = setup()
    const port = await listen(socket => handleProxy(socket, 'room-chat'))
    expect(await ask(port, 'CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n')).toContain('403')
    expect(service.list().events[0]).toMatchObject({ kind: 'cleanroom_blocked', severity: 'block', sessionId: 'room-chat', text: 'Clean room blocked a connection to evil.example:443 (not an allowed host)' })
  })

  it('pipelock refusing is a block; pipelock not answering falls back and says so', async () => {
    const { service } = setup()
    const refusing = await listen(socket => socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\n\r\nsecret in request\n')))
    await expect(openUpstream('registry.npmjs.org', 443, 'room', `http://127.0.0.1:${refusing}`)).rejects.toMatchObject({ pipelock: true })
    // Nothing at this port: the room goes out without pipelock (here: straight to a local server).
    const target = await listen(socket => socket.end())
    const dead = await listen(() => undefined)
    servers.pop()!.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    const socket = await openUpstream('127.0.0.1', target, 'room', `http://127.0.0.1:${dead}`)
    socket.destroy()
    expect(service.list().events[0]).toMatchObject({ kind: 'connection', severity: 'warn' })
    expect(service.list().events[0].text).toContain('pipelock is on but does not answer')
  })
})

describe('extras say what they need', () => {
  it('reports pipelock, innerwarden and langfuse honestly', async () => {
    const extras = new WatcherExtras({
      hermesConfigText: () => 'model: x\n',
      profileEnv: () => ({}),
      reachable: async () => false,
      findProgram: () => '',
    })
    const status = await extras.status(DEFAULT_WATCHER_SETTINGS)
    expect(status.map(item => [item.id, item.enabled, item.available])).toEqual([['pipelock', false, false], ['innerwarden', false, false], ['langfuse', false, false]])
    expect(status[1].detail).toContain('not installed on this host')
    expect(status[2].detail).toContain('HERMES_LANGFUSE_PUBLIC_KEY')
    expect(innerwardenHooked('hooks:\n  pre_tool_call:\n    - command: innerwarden hook hermes\n')).toBe(true)
    expect(langfuseConfig({ HERMES_LANGFUSE_PUBLIC_KEY: 'pk-lf-1', LANGFUSE_SECRET_KEY: 'sk-lf-1', HERMES_LANGFUSE_BASE_URL: 'http://lf.local/' })).toEqual({ publicKey: 'pk-lf-1', secretKey: 'sk-lf-1', baseUrl: 'http://lf.local' })
  })

  it('links Hermes chats to their Langfuse session once the project is known', async () => {
    const fetchJson = vi.fn(async () => ({ data: [{ id: 'proj-1' }] }))
    const extras = new WatcherExtras({ hermesConfigText: () => '', profileEnv: () => ({ HERMES_LANGFUSE_PUBLIC_KEY: 'pk', HERMES_LANGFUSE_SECRET_KEY: 'sk', HERMES_LANGFUSE_BASE_URL: 'http://lf.local' }), fetchJson })
    const on = sanitizeWatcherSettings({ extras: { langfuse: { enabled: true } } })
    expect(extras.traceLink(DEFAULT_WATCHER_SETTINGS, 'chat-1')).toBe('')
    expect(extras.traceLink(on, 'chat-1')).toBe('')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(extras.traceLink(on, 'chat-1')).toBe('http://lf.local/project/proj-1/sessions/chat-1')
    expect(fetchJson).toHaveBeenCalledWith('http://lf.local/api/public/projects', { authorization: `Basic ${Buffer.from('pk:sk').toString('base64')}` })
  })
})

describe('scheduled jobs', () => {
  it('read Hermes\'s cron_mode (deny unless approve)', () => {
    expect(cronModeFrom({})).toBe('deny')
    expect(cronModeFrom({ approvals: { cron_mode: 'approve' } })).toBe('approve')
    expect(cronModeFrom({ approvals: { cron_mode: 'something' } })).toBe('deny')
  })
})
