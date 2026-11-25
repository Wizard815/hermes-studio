import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const fixture = vi.hoisted(() => ({ active: true }))
vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({ getToken: async () => 'fixture-jwt-secret' }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/http-access', () => ({ handleSessionShareHttp: async () => false }))
vi.mock('../../packages/server/src/modules/studio/services/auth/run-mcp-credentials', () => ({ runMcpCredentials: { recognizes: () => false } }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: (id: number) => ({ id, username: 'wizard', role: 'super_admin', status: fixture.active ? 'active' : 'disabled' }),
  listUserProfiles: () => [], userCanAccessProfile: () => true, touchUserLogin: () => undefined, getDefaultProfileForUser: () => 'default',
}))

const { requireUserJwt } = await import('../../packages/server/src/modules/studio/middleware/auth')
const { phoneKeyAllows, setPhoneKeyLookup } = await import('../../packages/server/src/modules/studio/services/approval-alerts/scope')
const { ApprovalAlertsFile, normalizePairingCode } = await import('../../packages/server/src/modules/studio/services/approval-alerts/settings')
const { ApprovalAlertsService } = await import('../../packages/server/src/modules/studio/services/approval-alerts/service')
const { AgentWorkStore } = await import('../../packages/server/src/modules/studio/services/agent-work/store')
const { AgentWorkService } = await import('../../packages/server/src/modules/studio/services/agent-work/service')
const { normalizeAgentWorkSettings } = await import('../../packages/server/src/modules/studio/services/agent-work/settings')
const { WatcherService } = await import('../../packages/server/src/modules/studio/services/watcher/service')
const { WatcherStore } = await import('../../packages/server/src/modules/studio/services/watcher/store')
const { WatcherConfigFile } = await import('../../packages/server/src/modules/studio/services/watcher/config')
const { looksDangerous, sanitizeApprovalAlertPrefs } = await import('../../packages/shared/approval-alerts')

const request = (method: string, path: string, token: string, query: Record<string, string> = {}): any => ({
  method, path, state: {}, query, headers: query.token ? {} : { authorization: `Bearer ${token}` },
  request: { body: {} }, req: { socket: { remoteAddress: '10.0.0.9' } }, ip: '10.0.0.9',
  get(name: string) { return this.headers[name] || '' },
})

/** A Mattermost stand-in that records posts and patches. */
function fakeMattermost() {
  const posts: Array<{ id: string; channelId: string; message: string; props?: any }> = []
  const patches: Array<{ id: string; message: string }> = []
  return {
    posts, patches,
    port: {
      botUserId: async () => 'bot',
      createPost: async (channelId: string, message: string, props?: any) => { const id = `p${posts.length + 1}`; posts.push({ id, channelId, message, props }); return { id } },
      patchPost: async (id: string, message: string) => { patches.push({ id, message }) },
      reactions: async () => [],
      findChannel: async (name: string) => ({ id: `ch-${name}`, teamId: 't', name }),
      userIds: async () => ({}),
    },
  }
}

function agentWork(mm = fakeMattermost(), wanted?: () => boolean, channel = 'hermes') {
  const settings = normalizeAgentWorkSettings({ mattermost: { channel, channelId: channel ? `ch-${channel}` : '', actionUrl: 'http://studio:8648' } })
  return new AgentWorkService({
    store: new AgentWorkStore(new DatabaseSync(':memory:')),
    settings: { load: async () => structuredClone(settings), save: async () => ({}) as any, publicSettings: async () => ({}) as any },
    mattermost: mm.port as any,
    setupRecord: () => null,
    orb: { connected: async () => false } as any,
    allglance: { configured: async () => false } as any,
    wiki: { configured: async () => false } as any,
    approvalPostWanted: wanted,
  })
}

let dir = ''
afterEach(async () => {
  setPhoneKeyLookup(null)
  fixture.active = true
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function setup(options: { admins?: number[]; channel?: string } = {}) {
  dir = await mkdtemp(join(tmpdir(), 'approval-alerts-'))
  const file = new ApprovalAlertsFile(join(dir, 'approval-alerts.json'))
  const mm = fakeMattermost()
  const recorded: any[] = []
  const phonePending: any[] = []
  const phoneAnswers: Array<{ id: string; allowed: boolean }> = []
  const chatAnswers: any[] = []
  let chatAnswer = true
  const users: Record<number, any> = { 7: { id: 7, username: 'robin', role: 'super_admin', status: 'active' }, 8: { id: 8, username: 'sam', role: 'super_admin', status: 'active' }, 9: { id: 9, username: 'kid', role: 'user', status: 'active' } }
  let service!: InstanceType<typeof ApprovalAlertsService>
  const aw = agentWork(mm, () => service.mattermostWants('work'), options.channel ?? 'hermes')
  service = new ApprovalAlertsService({
    file,
    user: id => users[id] || null,
    superAdmins: () => (options.admins ?? [7]).map(id => users[id]),
    work: () => ({
      pending: () => aw.list({ status: ['awaiting_approval'] }),
      decide: (id, decision, via, by) => aw.decide(id, decision, via, by),
    }),
    phone: () => ({
      pending: () => phonePending,
      respond: (id, allowed) => {
        const index = phonePending.findIndex(item => item.id === id)
        if (index < 0) return false
        phonePending.splice(index, 1)
        phoneAnswers.push({ id, allowed })
        service.observePhone('agent.approval.resolved', { id, allowed })
        return true
      },
    }),
    answerChat: async (sessionId, approvalId, choice) => {
      chatAnswers.push({ sessionId, approvalId, choice })
      if (chatAnswer) service.observeChat(sessionId, 'approval.resolved', { approval_id: approvalId, choice, resolved: true })
      return chatAnswer
    },
    sessionTitle: () => 'Fix the gate',
    mattermost: {
      post: input => aw.postQuestion(input),
      resolve: (postId, message) => aw.resolveQuestion(postId, message),
    },
    record: input => recorded.push(input),
  })
  aw.setAlertActionHandler(input => service.answerFromMattermost(input))
  const pair = (userId = 7, name = 'Pixel 8') => service.pair(service.startPairing(userId, name).code, '')
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  return { service, file, aw, mm, recorded, phonePending, phoneAnswers, chatAnswers, pair, tick, setChatAnswer: (value: boolean) => { chatAnswer = value } }
}

describe('Phone key scope', () => {
  const valid = `sk-studio-phone-${'a'.repeat(43)}`
  const lookup = (token: string) => token === valid ? { id: 'd1', name: 'Pixel 8', userId: 7 } : null

  it('allows only reading and answering approvals', () => {
    expect(phoneKeyAllows('GET', '/api/studio/approval-alerts/device')).toBe(true)
    expect(phoneKeyAllows('GET', '/api/studio/approval-alerts/device/approvals')).toBe(true)
    expect(phoneKeyAllows('GET', '/api/studio/approval-alerts/device/stream')).toBe(true)
    expect(phoneKeyAllows('POST', '/api/studio/approval-alerts/device/approvals/work-abc/approve')).toBe(true)
    expect(phoneKeyAllows('POST', '/api/studio/approval-alerts/device/approvals/chat-1/reject')).toBe(true)
    expect(phoneKeyAllows('POST', '/api/studio/approval-alerts/prefs')).toBe(false)
    expect(phoneKeyAllows('PUT', '/api/studio/approval-alerts/prefs')).toBe(false)
    expect(phoneKeyAllows('POST', '/api/studio/approval-alerts/pairing')).toBe(false)
    expect(phoneKeyAllows('DELETE', '/api/studio/approval-alerts/devices/d1')).toBe(false)
    expect(phoneKeyAllows('POST', '/api/studio/agent-work/abc/approve')).toBe(false)
    expect(phoneKeyAllows('GET', '/api/hermes/sessions')).toBe(false)
  })

  it('signs in as the owner on its paths and is refused everywhere else, in the URL, unknown or disabled', async () => {
    setPhoneKeyLookup(lookup)
    const ok = request('GET', '/api/studio/approval-alerts/device/stream', valid)
    const next = vi.fn()
    await requireUserJwt(ok, next)
    expect(next).toHaveBeenCalledOnce()
    expect(ok.state.phoneKey).toEqual({ id: 'd1', name: 'Pixel 8', userId: 7 })
    for (const path of ['/api/studio/sessions', '/api/studio/approval-alerts', '/api/hermes/mcp/servers']) {
      const ctx = request('GET', path, valid)
      const refused = vi.fn()
      await requireUserJwt(ctx, refused)
      expect(ctx.status, path).toBe(403)
      expect(refused).not.toHaveBeenCalled()
    }
    const inUrl = request('GET', '/api/studio/approval-alerts/device/approvals', valid, { token: valid })
    await requireUserJwt(inUrl, vi.fn())
    expect(inUrl.status).toBe(401)
    const unknown = request('GET', '/api/studio/approval-alerts/device/approvals', `sk-studio-phone-${'b'.repeat(43)}`)
    await requireUserJwt(unknown, vi.fn())
    expect(unknown.status).toBe(401)
    fixture.active = false
    const disabled = request('GET', '/api/studio/approval-alerts/device/approvals', valid)
    await requireUserJwt(disabled, vi.fn())
    expect(disabled.status).toBe(403)
  })
})

describe('Pairing a phone', () => {
  it('trades a one-use code for a key that is stored only as a hash, and revokes it', async () => {
    const { service, pair } = await setup()
    const { code, expiresAt } = service.startPairing(7, 'Pixel 8')
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(expiresAt).toBeGreaterThan(Date.now())
    expect(normalizePairingCode(code.toLowerCase().replace('-', ' '))).toBe(code)
    const paired = service.pair(code.toLowerCase(), 'Robin\'s Pixel')
    expect(paired.key).toMatch(/^sk-studio-phone-[A-Za-z0-9_-]{43}$/)
    expect(paired.device).toMatchObject({ name: "Robin's Pixel", userId: 7, connected: false })
    expect(paired.device).not.toHaveProperty('hash')
    expect(paired.username).toBe('robin')
    const stored = await readFile(join(dir, 'approval-alerts.json'), 'utf8')
    expect(stored).not.toContain(paired.key)
    expect(() => service.pair(code, '')).toThrow(/wrong or has expired/)
    expect(service.authenticate(paired.key)?.id).toBe(paired.device.id)
    // Default name from Studio's pairing screen.
    expect(pair().device.name).toBe('Pixel 8')
    expect(service.devices(7)).toHaveLength(2)
    expect(service.devices(8)).toHaveLength(0)
    expect(() => service.removeDevice(8, paired.device.id)).toThrow(/No such phone/)
    service.removeDevice(7, paired.device.id)
    expect(service.authenticate(paired.key)).toBeNull()
  })

  it('refuses expired codes, codes from someone who is no longer a super admin, and too many wrong codes', async () => {
    const { service } = await setup()
    let now = Date.now()
    ;(service as any).deps.now = () => now
    const { code } = service.startPairing(7, '')
    now += 11 * 60_000
    expect(() => service.pair(code, '')).toThrow(/expired/)
    now = Date.now()
    const other = service.startPairing(9, '')
    expect(() => service.pair(other.code, '')).toThrow(/not a Studio super admin/)
    for (let i = 0; i < 20; i++) expect(() => service.pair('AAAA-AAAA', '')).toThrow()
    const fresh = service.startPairing(7, '')
    expect(() => service.pair(fresh.code, '')).toThrow(/Too many wrong codes/)
  })
})

describe('Where approvals reach you', () => {
  it('keeps what Studio did before for people who never picked: Agent work to Mattermost only', async () => {
    const { service, aw, mm, pair } = await setup()
    expect(service.prefs(7)).toEqual({ route: 'mattermost', kinds: { work: true, chat: false, phone: false, blocked: false } })
    expect(service.mattermostWants('work')).toBe(true)
    expect(service.mattermostWants('chat')).toBe(false)
    await aw.create({ title: 'Deploy', status: 'awaiting_approval' })
    expect(mm.posts).toHaveLength(1)
    expect(mm.posts[0].props.attachments[0].actions.map((a: any) => a.name)).toEqual(['Approve', 'Reject'])
    pair()
    expect(service.forUser(7)).toEqual([])
  })

  it('routes each kind by the choice: Mattermost, Android app, both, off', async () => {
    const { service, aw, mm, tick } = await setup()
    const chatPosts = () => mm.posts.filter(post => post.message.includes('#chatapproval')).length

    service.savePrefs(7, { route: 'android', kinds: { work: true, chat: true, phone: true, blocked: true } })
    await aw.create({ title: 'Ship it', status: 'awaiting_approval' })
    service.observeChat('s1', 'approval.requested', { approval_id: 'a1', command: 'npm publish' }, 'claude-code')
    await tick()
    expect(mm.posts).toHaveLength(0)
    expect(service.forUser(7).map(item => item.kind).sort()).toEqual(['chat', 'work'])

    service.savePrefs(7, { route: 'both' })
    service.observeChat('s1', 'approval.requested', { approval_id: 'a2', command: 'npm test' }, 'claude-code')
    await tick()
    expect(chatPosts()).toBe(1)
    expect(service.forUser(7)).toHaveLength(3)

    service.savePrefs(7, { route: 'mattermost' })
    service.observeChat('s1', 'approval.requested', { approval_id: 'a3', command: 'ls' }, 'claude-code')
    await tick()
    expect(chatPosts()).toBe(2)
    expect(service.forUser(7)).toEqual([])

    service.savePrefs(7, { route: 'off' })
    service.observeChat('s1', 'approval.requested', { approval_id: 'a4', command: 'pwd' }, 'claude-code')
    await tick()
    expect(chatPosts()).toBe(2)
    expect(service.forUser(7)).toEqual([])
    expect(service.mattermostWants('work')).toBe(false)
    await aw.create({ title: 'Not posted', status: 'awaiting_approval' })
    expect(mm.posts.some(post => post.message.includes('Not posted'))).toBe(false)

    // Kinds narrow the phone's list.
    service.savePrefs(7, { route: 'android', kinds: { work: false, chat: true, phone: false, blocked: false } })
    expect(service.forUser(7).every(item => item.kind === 'chat')).toBe(true)
  })

  it('counts every super admin: one who never picked still gets Agent work in Mattermost', async () => {
    const { service } = await setup({ admins: [7, 8] })
    service.savePrefs(7, { route: 'android' })
    expect(service.mattermostWants('work')).toBe(true)
    service.savePrefs(8, { route: 'off' })
    expect(service.mattermostWants('work')).toBe(false)
    expect(sanitizeApprovalAlertPrefs({ route: 'pager', kinds: { work: 'yes' } })).toEqual({ route: 'mattermost', kinds: { work: true, chat: false, phone: false, blocked: false } })
  })
})

describe('The live stream and answers', () => {
  it('streams the list, answers once, and says where it was answered', async () => {
    const { service, aw, pair, recorded } = await setup()
    service.savePrefs(7, { route: 'android', kinds: { work: true, chat: true, phone: true, blocked: true } })
    const device = service.device(pair().device.id)
    const events: Array<{ event: string; data: any }> = []
    const unsubscribe = service.subscribe(device, (event, data) => events.push({ event, data }))
    expect(events[0]).toEqual({ event: 'approvals', data: { items: [] } })
    expect(service.devices(7)[0].connected).toBe(true)

    const work = await aw.create({ title: 'Deploy the gate fix', summary: 'rm -rf build && npm publish', sessionId: 'chat-9', status: 'awaiting_approval' })
    service.flush()
    const item = events.at(-1)!.data.items[0]
    expect(item).toMatchObject({ id: `work-${work.id}`, kind: 'work', sessionId: 'chat-9', answerable: true, dangerous: true })
    expect(item.detail).toContain('Deploy the gate fix')

    const first = await service.answerFromPhone(device, item.id, 'approve')
    expect(first).toMatchObject({ changed: true })
    expect(aw.get(work.id).work).toMatchObject({ decision: 'approved', decidedVia: 'phone', decidedBy: 'Pixel 8' })
    expect(aw.get(work.id).activity.find(entry => entry.kind === 'approved')?.message).toBe('approved on phone (Pixel 8)')
    expect(recorded.at(-1)).toMatchObject({ kind: 'approval_remote', text: expect.stringMatching(/^Approved on phone \(Pixel 8\): Deploy the gate fix/) })
    service.flush()
    expect(events.at(-1)!.data.items).toEqual([])

    // Studio tries afterwards.
    expect(await aw.decide(work.id, 'reject', 'studio', 'robin')).toMatchObject({ changed: false, message: 'Already approved on phone (Pixel 8).' })
    // And the other way round.
    const second = await aw.create({ title: 'Second', status: 'awaiting_approval' })
    await aw.decide(second.id, 'reject', 'studio', 'robin')
    expect(await service.answerFromPhone(device, `work-${second.id}`, 'approve')).toEqual({ changed: false, message: 'Already rejected in Studio by robin.' })

    unsubscribe()
    expect(service.devices(7)[0].connected).toBe(false)
  })

  it("answers a chat's approval once; a later answer from Studio or the phone is a no-op with where it went", async () => {
    const { service, pair, chatAnswers, setChatAnswer } = await setup()
    service.savePrefs(7, { route: 'android', kinds: { work: true, chat: true, phone: true, blocked: false } })
    const device = service.device(pair().device.id)
    service.observeChat('s1', 'approval.requested', { approval_id: 'a1', command: 'sudo rm -rf /srv/cache' }, 'claude-code')
    const [item] = service.forUser(7)
    expect(item).toMatchObject({ kind: 'chat', title: 'Claude Code asks to run a command in Fix the gate', detail: 'sudo rm -rf /srv/cache', dangerous: true, link: '/hermes/session/s1' })
    expect(await service.answerFromPhone(device, item.id, 'reject')).toEqual({ changed: true, message: 'Rejected.' })
    expect(chatAnswers).toEqual([{ sessionId: 's1', approvalId: 'a1', choice: 'deny' }])
    expect(await service.answerFromPhone(device, item.id, 'approve')).toEqual({ changed: false, message: 'Already rejected on phone (Pixel 8).' })

    // Answered in Studio first: the chat's own "resolved" event.
    service.observeChat('s1', 'approval.requested', { approval_id: 'a2', command: 'npm test' }, 'hermes')
    const studioItem = service.forUser(7)[0]
    service.observeChat('s1', 'approval.resolved', { approval_id: 'a2', choice: 'once', resolved: true })
    expect(await service.answerFromPhone(device, studioItem.id, 'reject')).toEqual({ changed: false, message: 'Already approved in Studio.' })

    // The run ended: nothing to answer any more.
    service.observeChat('s2', 'approval.requested', { approval_id: 'a3', command: 'make' }, 'hermes')
    const gone = service.forUser(7)[0]
    service.observeChat('s2', 'run.failed', {})
    expect(service.forUser(7)).toEqual([])
    expect((await service.answerFromPhone(device, gone.id, 'approve')).message).toBe('This is no longer waiting for an answer.')

    // The chat refused the answer (already resolved elsewhere).
    setChatAnswer(false)
    service.observeChat('s3', 'approval.requested', { approval_id: 'a4', command: 'make' }, 'hermes')
    expect((await service.answerFromPhone(device, service.forUser(7)[0].id, 'approve')).changed).toBe(false)
  })

  it('answers phone tool questions and refuses what the owner does not get on the phone', async () => {
    const { service, pair, phonePending, phoneAnswers } = await setup()
    service.savePrefs(7, { route: 'android', kinds: { work: true, chat: false, phone: true, blocked: false } })
    const device = service.device(pair().device.id)
    phonePending.push({ id: 'q1', at: Date.now(), device: 'Pixel emulator', action: 'shell', summary: 'run "pm clear com.app"', reason: '', agent: 'codex', sessionId: 's1' })
    service.observePhone('agent.approval', phonePending[0])
    const [item] = service.forUser(7)
    expect(item).toMatchObject({ id: 'phone-q1', kind: 'phone', title: 'Codex wants to use Pixel emulator', dangerous: true, link: '/android' })
    expect(await service.answerFromPhone(device, 'phone-q1', 'approve')).toEqual({ changed: true, message: 'Approved.' })
    expect(phoneAnswers).toEqual([{ id: 'q1', allowed: true }])
    expect((await service.answerFromPhone(device, 'phone-q1', 'reject')).message).toBe('Already approved on phone (Pixel 8).')

    service.observeChat('s1', 'approval.requested', { approval_id: 'a1', command: 'ls' }, 'hermes')
    const chatId = (service as any).chatByApproval.get('s1\u0000a1')
    await expect(service.answerFromPhone(device, chatId, 'approve')).rejects.toMatchObject({ status: 403 })
    service.savePrefs(7, { route: 'mattermost' })
    await expect(service.answerFromPhone(device, 'phone-q1', 'approve')).rejects.toThrow(/off in Studio/)
    fixture.active = true
    await expect(service.answerFromPhone({ ...device, userId: 9 }, 'phone-q1', 'approve')).rejects.toMatchObject({ status: 403 })
  })

  it('closes the stream of a revoked phone', async () => {
    const { service, pair } = await setup()
    const device = service.device(pair().device.id)
    const events: string[] = []
    service.subscribe(device, event => events.push(event))
    service.removeDevice(7, device.id)
    expect(events).toEqual(['approvals', 'revoked'])
    expect(service.connectedDevices()).toBe(0)
  })
})

describe('Mattermost buttons on chat approvals and phone questions', () => {
  it('posts with the same buttons, answers through the chat, and closes the post wherever it was answered', async () => {
    const { service, mm, chatAnswers, tick, pair } = await setup()
    service.savePrefs(7, { route: 'both', kinds: { work: true, chat: true, phone: true, blocked: false } })
    service.observeChat('s1', 'approval.requested', { approval_id: 'a1', command: 'npm publish' }, 'codex')
    await tick()
    const post = mm.posts[0]
    expect(post.message).toMatch(/^#approval #chatapproval \*\*Codex asks to run a command in Fix the gate\*\*\n> npm publish/)
    const approve = post.props.attachments[0].actions[0]
    expect(approve.integration.url).toBe('http://studio:8648/api/studio/agent-work/mattermost/action')
    const context = approve.integration.context
    expect(context).toMatchObject({ decision: 'approve', alert_id: expect.stringMatching(/^chat-/) })

    // Wrong secret.
    await expect(service.answerFromMattermost({ alertId: context.alert_id, token: 'nope', decision: 'approve', by: 'sam' })).rejects.toMatchObject({ status: 403 })
    const result = await service.answerFromMattermost({ alertId: context.alert_id, token: context.token, decision: 'approve', by: 'sam' })
    expect(result).toEqual({ message: 'Approved.', resolved: '#approved ~~#approval~~ **Codex asks to run a command in Fix the gate** was approved in Mattermost by sam.' })
    expect(chatAnswers).toEqual([{ sessionId: 's1', approvalId: 'a1', choice: 'once' }])
    // The phone is too late.
    const device = service.device(pair().device.id)
    expect((await service.answerFromPhone(device, context.alert_id, 'reject')).message).toBe('Already approved in Mattermost by sam.')

    // Answered on the phone: the Mattermost post loses its buttons.
    service.observeChat('s1', 'approval.requested', { approval_id: 'a2', command: 'npm test' }, 'codex')
    await tick()
    const id = mm.posts[1].props.attachments[0].actions[0].integration.context.alert_id
    await service.answerFromPhone(device, id, 'reject')
    await tick()
    expect(mm.patches.at(-1)).toEqual({ id: mm.posts[1].id, message: '#rejected ~~#approval~~ **Codex asks to run a command in Fix the gate** was rejected on phone (Pixel 8).' })
  })

  it('reaches the alert handler through Agent work\'s one action route', async () => {
    const { service, aw, mm, tick } = await setup()
    service.savePrefs(7, { route: 'mattermost', kinds: { work: true, chat: true, phone: true, blocked: false } })
    service.observeChat('s1', 'approval.requested', { approval_id: 'a1', command: 'npm publish' }, 'codex')
    await tick()
    const context = mm.posts[0].props.attachments[0].actions[1].integration.context
    const answer = await aw.mattermostAction({ context, user_id: 'u1', user_name: 'sam' })
    expect(answer.ephemeral_text).toBe('Rejected.')
    expect(answer.update?.message).toMatch(/was rejected in Mattermost by sam/)
  })
})

describe('Blocked alerts', () => {
  it('reach phones that want them and Mattermost when someone picked it there', async () => {
    const { service, pair } = await setup()
    const config = new WatcherConfigFile(() => join(dir, 'watcher.json'))
    const mmPosts: any[] = []
    const watcher = new WatcherService({
      store: new WatcherStore(new DatabaseSync(':memory:')),
      config,
      mattermost: async event => { mmPosts.push(event); return true },
      blocked: { mattermost: () => service.mattermostWants('blocked'), notify: (event, title) => service.observeBlocked(event, title) },
    })
    service.savePrefs(7, { route: 'android', kinds: { work: true, chat: true, phone: true, blocked: true } })
    pair()
    watcher.record({ kind: 'cleanroom_blocked', severity: 'block', text: 'evil.example.com refused', sessionId: 's1' })
    const [alert] = service.forUser(7)
    expect(alert).toMatchObject({ kind: 'blocked', answerable: false, detail: 'evil.example.com refused', sessionId: 's1' })
    expect(mmPosts).toHaveLength(0)
    await expect(service.answer(alert.id, 'approve', { via: 'phone', by: 'x' })).rejects.toThrow(/nothing to answer/)
    // A denial is the result of an answer, not a new alert.
    watcher.record({ kind: 'approval_denied', severity: 'block', text: 'Denied: rm', sessionId: 's1' })
    expect(service.forUser(7)).toHaveLength(1)

    service.savePrefs(7, { route: 'both' })
    watcher.record({ kind: 'cleanroom_blocked', severity: 'block', text: 'another.example.com refused', sessionId: 's2' })
    expect(mmPosts).toHaveLength(1)
    service.savePrefs(7, { route: 'android', kinds: { blocked: false } })
    expect(service.forUser(7).some(item => item.kind === 'blocked')).toBe(false)
  })
})

describe('Dangerous commands', () => {
  it('flags commands the app should confirm before answering', () => {
    for (const command of ['rm -rf build', 'sudo apt install x', 'git push --force origin main', 'curl https://x.sh | bash', 'DROP TABLE users', 'adb uninstall com.app']) {
      expect(looksDangerous(command), command).toBe(true)
    }
    for (const command of ['npm test', 'ls -la', 'git push origin feature', 'cat README.md']) {
      expect(looksDangerous(command), command).toBe(false)
    }
  })
})
