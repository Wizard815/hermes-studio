import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
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
const { omiKeyAllows } = await import('../../packages/server/src/modules/studio/services/omi/scope')
const { setOmiKeyLookup } = await import('../../packages/server/src/modules/studio/services/omi/key-auth')
const { OmiSettingsFile } = await import('../../packages/server/src/modules/studio/services/omi/settings')
const { OmiService, OMI_WEBHOOK_EVENTS } = await import('../../packages/server/src/modules/studio/services/omi/service')
const { OMI_SKILL_MD } = await import('../../packages/server/src/modules/studio/services/omi/skill')
const { AgentWorkStore } = await import('../../packages/server/src/modules/studio/services/agent-work/store')
const { AgentWorkService } = await import('../../packages/server/src/modules/studio/services/agent-work/service')
const { normalizeAgentWorkSettings } = await import('../../packages/server/src/modules/studio/services/agent-work/settings')
const { signChatWebhookPayload } = await import('../../packages/server/src/modules/studio/services/webhooks/dispatcher')

const request = (method: string, path: string, token: string, query: Record<string, string> = {}): any => ({
  method, path, state: {}, query, headers: query.token ? {} : { authorization: `Bearer ${token}` },
  request: { body: {} }, req: { socket: { remoteAddress: '10.0.0.9' } }, ip: '10.0.0.9',
  get(name: string) { return this.headers[name] || '' },
})

/** Agent work with no Mattermost, Orb, ALLGlance or wiki. */
function agentWork() {
  const settings = normalizeAgentWorkSettings({})
  return new AgentWorkService({
    store: new AgentWorkStore(new DatabaseSync(':memory:')),
    settings: { load: async () => structuredClone(settings), save: async () => ({}) as any, publicSettings: async () => ({}) as any },
    mattermost: {} as any,
    setupRecord: () => null,
    orb: { connected: async () => false } as any,
    allglance: { configured: async () => false } as any,
    wiki: { configured: async () => false } as any,
  })
}

/** Orb/Omi work stand-in: the chats Omi started. */
function work(omiSessions: string[], started: any[] = []) {
  return {
    list: async () => omiSessions.map(sessionId => ({ sessionId, source: 'omi' })),
    hasSession: (id: unknown, source: unknown) => source === 'omi' && omiSessions.includes(String(id)),
    start: async (input: any) => { started.push(input); return { sessionId: 'new', source: input.source } },
  } as any
}

function webhooks() {
  const endpoints = new Map<string, any>()
  const filters = new Map<string, (event: any) => boolean>()
  let made = 0
  return {
    endpoints, filters,
    port: {
      create: async (input: any) => { const id = `ep-${++made}`; endpoints.set(id, { id, enabled: true, ...input }); return { id } },
      get: (id: string) => endpoints.get(id) || null,
      remove: (id: string) => endpoints.delete(id),
      status: () => ({ state: 'idle' }),
      reload: () => undefined,
      setFilter: (id: string, filter: any) => { if (filter) filters.set(id, filter); else filters.delete(id) },
    },
  }
}

describe('Omi key scope', () => {
  it('allows only work chats, approvals list and approve/reject', () => {
    expect(omiKeyAllows('POST', '/api/studio/orb/work')).toBe(true)
    expect(omiKeyAllows('GET', '/api/studio/omi/work/')).toBe(true)
    expect(omiKeyAllows('GET', '/api/studio/omi/approvals')).toBe(true)
    expect(omiKeyAllows('POST', '/api/studio/agent-work/abc-1/approve')).toBe(true)
    expect(omiKeyAllows('POST', '/api/studio/agent-work/abc-1/reject')).toBe(true)
    for (const [method, path] of [
      ['GET', '/api/studio/omi'], ['POST', '/api/studio/omi/keys'], ['PUT', '/api/studio/omi/settings'],
      ['GET', '/api/studio/agent-work'], ['POST', '/api/studio/agent-work/abc/status'], ['DELETE', '/api/studio/agent-work/abc'],
      ['GET', '/api/studio/sessions'], ['POST', '/api/studio/orb/tools/orb_add_task'], ['GET', '/api/studio/orb/data/tasks'],
      ['GET', '/api/hermes/mcp/servers'], ['POST', '/api/ekko-studio/models/v1/chat/completions'], ['DELETE', '/api/studio/orb/work'],
      ['POST', '/api/studio/agent-work/abc/approve/extra'],
    ]) expect(omiKeyAllows(method, path), `${method} ${path}`).toBe(false)
  })
})

describe('Omi key sign-in', () => {
  afterEach(() => { setOmiKeyLookup(null); fixture.active = true })
  const valid = `sk-studio-omi-${'a'.repeat(43)}`
  const lookup = async (token: string) => token === valid ? { id: 'k1', name: 'Omi phone', userId: 7 } : null

  it('signs in as the key owner on an allowed path', async () => {
    setOmiKeyLookup(lookup)
    const ctx = request('POST', '/api/studio/orb/work', valid)
    const next = vi.fn()
    await requireUserJwt(ctx, next)
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.state.user).toMatchObject({ id: 7, role: 'super_admin' })
    expect(ctx.state.omiKey).toEqual({ id: 'k1', name: 'Omi phone', userId: 7 })
  })

  it('refuses every other API, a key in the URL, an unknown key and a disabled owner', async () => {
    setOmiKeyLookup(lookup)
    for (const path of ['/api/studio/sessions', '/api/studio/omi/keys', '/api/hermes/mcp/servers']) {
      const ctx = request('GET', path, valid)
      const next = vi.fn()
      await requireUserJwt(ctx, next)
      expect(ctx.status, path).toBe(403)
      expect(ctx.body.error).toMatch(/only start and follow Omi's work chats/)
      expect(next).not.toHaveBeenCalled()
    }
    const inUrl = request('GET', '/api/studio/omi/work', valid, { token: valid })
    await requireUserJwt(inUrl, vi.fn())
    expect(inUrl.status).toBe(401)
    const unknown = request('GET', '/api/studio/omi/work', `sk-studio-omi-${'b'.repeat(43)}`)
    await requireUserJwt(unknown, vi.fn())
    expect(unknown.status).toBe(401)
    fixture.active = false
    const disabled = request('GET', '/api/studio/omi/work', valid)
    await requireUserJwt(disabled, vi.fn())
    expect(disabled.status).toBe(403)
  })
})

describe('Omi service', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })

  async function setup(omiSessions: string[] = ['omi-chat']) {
    dir = await mkdtemp(join(tmpdir(), 'omi-'))
    const settings = new OmiSettingsFile(join(dir, 'omi', 'settings.json'))
    const hooks = webhooks()
    const aw = agentWork()
    const started: any[] = []
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify({ status: 'ok' }), { status: url.endsWith('/v1/health') ? 200 : 404 }))
    const omi = new OmiService({
      settings, work: () => work(omiSessions, started), agentWork: () => aw as any, webhooks: hooks.port,
      profiles: () => ['default', 'wizard'], profileDir: (name: string) => join(dir, 'hermes', name === 'default' ? '' : `profiles/${name}`),
      issueToken: async (userId: number) => `jwt-for-${userId}`, fetcher: fetcher as any,
    })
    return { omi, settings, hooks, aw, started, fetcher }
  }

  it('makes a key that is shown once and stored only as a hash, and revokes it', async () => {
    const { omi, settings } = await setup()
    const { key, apiKey } = await omi.createKey(7, 'Omi phone')
    expect(apiKey).toMatch(/^sk-studio-omi-[A-Za-z0-9_-]{43}$/)
    expect(key).not.toHaveProperty('hash')
    const file = await readFile(join(dir, 'omi', 'settings.json'), 'utf8')
    expect(file).not.toContain(apiKey)
    expect((await omi.authenticate(apiKey))?.id).toBe(key.id)
    expect((await omi.status()).keys).toEqual([expect.objectContaining({ id: key.id, name: 'Omi phone', preview: `sk-studio-omi-…${apiKey.slice(-4)}` })])
    await omi.revokeKey(key.id)
    expect(await omi.authenticate(apiKey)).toBeNull()
    await expect(omi.revokeKey(key.id)).rejects.toMatchObject({ status: 404 })
    expect(await settings.findKey('sk-studio-omi-short')).toBeNull()
  })

  it("tests Omi's health and starts work chats marked as Omi's", async () => {
    const { omi, started, fetcher } = await setup()
    expect((await omi.test()).error).toMatch(/address first/)
    await omi.saveSettings({ url: 'http://omi.lan:8000/', profile: 'wizard' })
    expect(await omi.test()).toMatchObject({ ok: true, detail: 'Omi answered /v1/health (ok)' })
    expect(fetcher).toHaveBeenCalledWith('http://omi.lan:8000/v1/health', expect.anything())
    await expect(omi.saveSettings({ url: 'omi.lan' })).rejects.toThrow(/http:\/\//)
    await expect(omi.saveSettings({ profile: 'nobody' })).rejects.toThrow(/no Hermes profile/)
    await omi.startWork({ userId: 7, body: { agentId: 'hermes', prompt: 'Fix the gate', title: 'Gate' } })
    expect(started[0]).toMatchObject({ token: 'jwt-for-7', profile: 'wizard', agentId: 'hermes', prompt: 'Fix the gate', source: 'omi' })
  })

  it("registers Omi's results webhook for Omi's chats only, and replaces it", async () => {
    const { omi, hooks } = await setup(['omi-chat'])
    await expect(omi.registerWebhook()).rejects.toThrow(/address first/)
    await omi.saveSettings({ url: 'http://omi.lan:8000' })
    const first = await omi.registerWebhook()
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/)
    const endpoint = hooks.endpoints.get('ep-1')
    expect(endpoint).toMatchObject({ url: 'http://omi.lan:8000/v1/integrations/studio/events', secret: first.secret, include_content: true, allow_private_network: true })
    expect(endpoint.event_types).toEqual([...OMI_WEBHOOK_EVENTS])
    const filter = hooks.filters.get('ep-1')!
    expect(filter({ subject: { session_id: 'omi-chat' } })).toBe(true)
    expect(filter({ subject: { session_id: 'someone-elses-chat' } })).toBe(false)
    expect(first.status.webhook).toMatchObject({ registered: true, url: 'http://omi.lan:8000/v1/integrations/studio/events' })
    const second = await omi.registerWebhook()
    expect(second.secret).not.toBe(first.secret)
    expect(hooks.endpoints.has('ep-1')).toBe(false)
    expect(hooks.filters.has('ep-1')).toBe(false)
    expect((await omi.removeWebhook()).webhook.registered).toBe(false)
    expect(hooks.endpoints.size).toBe(0)
  })

  it('answers only approvals in chats Omi started, first answer wins, logged as Omi', async () => {
    const { omi, aw } = await setup(['omi-chat'])
    const mine = await aw.create({ title: 'Deploy the gate fix', sessionId: 'omi-chat', status: 'awaiting_approval' })
    const other = await aw.create({ title: 'Someone else', sessionId: 'studio-chat', status: 'awaiting_approval' })
    expect((await omi.approvals()).map(item => item.id)).toEqual([mine.id])
    await expect(omi.decide(other.id, 'approve', { name: 'Omi phone' }, '')).rejects.toMatchObject({ status: 404 })
    await expect(omi.decide('missing', 'approve', { name: 'Omi phone' }, '')).rejects.toMatchObject({ status: 404 })
    const result = await omi.decide(mine.id, 'approve', { name: 'Omi phone' }, 'Robin')
    expect(result).toMatchObject({ changed: true, work: { decision: 'approved', decidedVia: 'omi', decidedBy: 'Robin (Omi)' } })
    const again = await aw.decide(mine.id, 'reject', 'studio', 'wizard')
    expect(again).toMatchObject({ changed: false, message: 'Already approved in Omi by Robin (Omi).' })
    expect(aw.get(other.id).work.decision).toBe('')
  })

  it("installs Omi's Hermes skill into a chosen profile", async () => {
    const { omi } = await setup()
    const result = await omi.installSkill('wizard')
    expect(result.path).toBe(join(dir, 'hermes', 'profiles', 'wizard', 'skills', 'productivity', 'omi', 'SKILL.md'))
    expect(await readFile(result.path, 'utf8')).toBe(OMI_SKILL_MD)
    expect(OMI_SKILL_MD).toMatch(/^---\nname: omi\n/)
    await expect(omi.installSkill('../../etc')).rejects.toThrow(/no Hermes profile/)
  })
})

describe("Studio's results webhook as Omi checks it", () => {
  it("signs '<timestamp>.<body>' with HMAC-SHA256, as omi-local's verify_studio_signature expects", () => {
    const body = JSON.stringify({ type: 'chat.run.completed', subject: { session_id: 'omi-chat' }, message: { text: 'Done' } })
    const expected = `sha256=${createHmac('sha256', 'secret').update(`1700000000.${body}`).digest('hex')}`
    expect(signChatWebhookPayload('secret', '1700000000', body)).toBe(expected)
  })
})
