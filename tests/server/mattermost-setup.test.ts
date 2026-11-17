import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
const savedEnv: Record<string, string> = {}
let yamlConfig: Record<string, any> = {}
const restart = vi.fn(async () => ({ running: true, profile: 'default' }))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getProfileDir: () => dir,
  getActiveProfileName: () => 'default',
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  saveEnvValueForProfile: async (_p: string, key: string, value: string) => { savedEnv[key] = value },
  // Same contract as safeFileStore.updateYaml: return the new config, or { data, result }.
  updateConfigYamlForProfile: async (_p: string, fn: (c: Record<string, any>) => any) => {
    const out = await fn(structuredClone(yamlConfig))
    if (out && typeof out === 'object' && 'data' in out && 'result' in out) { yamlConfig = out.data; return out.result }
    yamlConfig = out
    return undefined
  },
}))
vi.mock('../../packages/server/src/modules/hermes/services/gateway/autostart', () => ({
  gatewayAutostartDisabledByEnv: () => false,
  restartGatewayForProfile: (...args: unknown[]) => (restart as any)(...args),
}))
vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({
  readAppConfig: async () => ({ gatewayAutoStart: { enabled: true } }),
  normalizeGatewayAutoStartConfig: (v: any) => v,
}))
vi.mock('../../packages/server/src/modules/studio/public/safe-file-store', async () => {
  const fs = await import('node:fs')
  return { safeFileStore: { writeText: async (p: string, c: string) => fs.writeFileSync(p, c) } }
})
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

/** A tiny in-memory Mattermost: one team, a user, a bot; the bot may or may not create channels. */
function fakeMattermost(opts: { botCanCreate: boolean }) {
  const BOT = 'bot-token', ADMIN = 'admin-session'
  const teamMembers = new Set(['bot1'])
  const channels: Record<string, { id: string; name: string; display_name: string; team_id: string; delete_at: number; members: Set<string> }> = {}
  const calls: string[] = []
  let loggedOut = false
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  const fetchFn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace('/api/v4', '')
    const method = init.method || 'GET'
    const auth = String((init.headers as Record<string, string>)?.Authorization || '').replace('Bearer ', '')
    const body = init.body ? JSON.parse(String(init.body)) : {}
    calls.push(`${method} ${path}`)
    const admin = auth === ADMIN
    if (method === 'POST' && path === '/users/login') {
      return body.password === 'pw' ? json(200, { id: 'adm' }, { token: ADMIN }) : json(401, { message: 'bad login' })
    }
    if (method === 'POST' && path === '/users/logout') { loggedOut = true; return json(200, {}) }
    if (auth !== BOT && !admin) return json(401, { message: 'unauthorized' })
    if (path === '/users/me') return json(200, admin ? { id: 'adm', username: 'admin' } : { id: 'bot1', username: 'hermes' })
    if (path === '/users/me/teams') return json(200, admin || teamMembers.has('bot1') ? [{ id: 't1', name: 'home', display_name: 'Home', delete_at: 0 }] : [])
    if (path === '/teams') return json(200, [{ id: 't1', name: 'home', display_name: 'Home', delete_at: 0 }])
    if (path === '/teams/t1') return json(200, { id: 't1', name: 'home', display_name: 'Home' })
    if (path === '/users/username/alex') return json(200, { id: 'u1', username: 'alex' })
    if (path.startsWith('/users/username/')) return json(404, { message: 'not found' })
    let m = path.match(/^\/teams\/t1\/members\/(\w+)$/)
    if (m) return teamMembers.has(m[1]) ? json(200, {}) : json(404, {})
    if (method === 'POST' && path === '/teams/t1/members') { teamMembers.add(body.user_id); return json(201, {}) }
    m = path.match(/^\/teams\/t1\/channels\/name\/([\w-]+)$/)
    if (m) { const c = Object.values(channels).find(c => c.name === m![1]); return c ? json(200, c) : json(404, {}) }
    if (method === 'POST' && path === '/channels') {
      if (!admin && !opts.botCanCreate) return json(403, { message: 'You do not have the appropriate permissions.' })
      const id = `c${Object.keys(channels).length + 1}`
      channels[id] = { id, name: body.name, display_name: body.display_name, team_id: body.team_id, delete_at: 0, members: new Set() }
      return json(201, channels[id])
    }
    m = path.match(/^\/channels\/(\w+)\/members\/(\w+)$/)
    if (m) return channels[m[1]]?.members.has(m[2]) ? json(200, {}) : json(404, {})
    m = path.match(/^\/channels\/(\w+)\/members$/)
    if (m && method === 'POST') { channels[m[1]].members.add(body.user_id); return json(201, {}) }
    return json(404, { message: `no route ${method} ${path}` })
  })
  return { fetchFn, channels, calls, get loggedOut() { return loggedOut } }
}

describe('Mattermost setup for Hermes', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mm-setup-'))
    writeFileSync(join(dir, '.env'), 'MATTERMOST_URL=http://mm.local:8065/\nMATTERMOST_TOKEN=bot-token\nMATTERMOST_ALLOWED_USERS=old1\n')
    for (const key of Object.keys(savedEnv)) delete savedEnv[key]
    yamlConfig = { platforms: { mattermost: { enabled: false }, webhook: { enabled: true } } }
    restart.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  it('normalises channel names and merges id lists', async () => {
    const { channelSlug, mergeCsv } = await import('../../packages/server/src/modules/hermes/controllers/mattermost-setup')
    expect(channelSlug('#Server Alerts!')).toBe('server-alerts')
    expect(channelSlug('~hermes')).toBe('hermes')
    expect(mergeCsv('a, b', ['b', 'c'])).toBe('a,b,c')
    expect(mergeCsv('', ['x'])).toBe('x')
  })

  it('creates the three channels, adds bot and user, sets Hermes env and restarts the gateway', async () => {
    const mm = fakeMattermost({ botCanCreate: true })
    vi.stubGlobal('fetch', mm.fetchFn)
    const { applySetup, readSetupRecord } = await import('../../packages/server/src/modules/hermes/controllers/mattermost-setup')
    const result = await applySetup('default', { team_id: 't1', username: '@Alex' })

    expect(result.channels.map(c => [c.role, c.name])).toEqual([['main', 'hermes'], ['home_alerts', 'home-alerts'], ['server_alerts', 'server-alerts']])
    for (const c of Object.values(mm.channels)) expect([...c.members].sort()).toEqual(['bot1', 'u1'])
    expect(savedEnv).toEqual({
      MATTERMOST_HOME_CHANNEL: 'c1',
      MATTERMOST_FREE_RESPONSE_CHANNELS: 'c1',
      MATTERMOST_ALLOWED_CHANNELS: 'c1,c2,c3',
      MATTERMOST_ALLOWED_USERS: 'old1,u1',
    })
    expect(yamlConfig.platforms).toEqual({ mattermost: { enabled: true }, webhook: { enabled: true } })
    expect(result.steps).toContain('turned Mattermost on in Hermes')
    expect(restart).toHaveBeenCalledWith('default')
    expect(result.restarted).toBe(true)
    expect(readSetupRecord('default')?.channels.find(c => c.role === 'server_alerts')?.id).toBe('c3')
    expect(JSON.parse(readFileSync(join(dir, 'channel_aliases.json'), 'utf-8'))).toEqual({ mattermost: { c1: 'hermes', c2: 'home-alerts', c3: 'server-alerts' } })
  })

  it('explains a bot without permission, then works with a one-time admin sign-in that is logged out and not stored', async () => {
    const mm = fakeMattermost({ botCanCreate: false })
    vi.stubGlobal('fetch', mm.fetchFn)
    const { applySetup, MattermostError } = await import('../../packages/server/src/modules/hermes/controllers/mattermost-setup')
    const err = await applySetup('default', { team_id: 't1', username: 'alex' }).catch(e => e)
    expect(err).toBeInstanceOf(MattermostError)
    expect(err.code).toBe('bot_cannot_create_channels')
    expect(existsSync(join(dir, 'studio-mattermost.json'))).toBe(false)

    const result = await applySetup('default', { team_id: 't1', username: 'alex', admin: { login_id: 'admin', password: 'pw' } })
    expect(result.ok).toBe(true)
    expect(mm.loggedOut).toBe(true)
    const stored = readFileSync(join(dir, 'studio-mattermost.json'), 'utf-8') + readFileSync(join(dir, 'channel_aliases.json'), 'utf-8')
    expect(stored).not.toContain('pw')
    expect(stored).not.toContain('admin-session')
  })

  it('reports an unknown username plainly', async () => {
    vi.stubGlobal('fetch', fakeMattermost({ botCanCreate: true }).fetchFn)
    const { applySetup } = await import('../../packages/server/src/modules/hermes/controllers/mattermost-setup')
    await expect(applySetup('default', { team_id: 't1', username: 'nobody' })).rejects.toMatchObject({ code: 'user_not_found' })
  })
})
