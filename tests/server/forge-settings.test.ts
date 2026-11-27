import { describe, expect, it, vi } from 'vitest'
import { ForgeSettingsService, type ForgeSettingsDeps } from '../../packages/server/src/modules/studio/services/forge-settings'

function setup(overrides: Partial<ForgeSettingsDeps> = {}) {
  let config: Record<string, any> = { model: { default: 'x' }, skills: { config: { other: { a: 1 } } } }
  const env: Record<string, string> = {}
  const changed = vi.fn(async () => {})
  const service = new ForgeSettingsService({
    profile: () => 'default',
    readConfig: async () => structuredClone(config),
    updateConfig: async (_p, updater) => { config = updater(structuredClone(config)) },
    readEnv: async () => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'),
    saveEnv: async (_p, key, value) => { if (value) env[key] = value; else delete env[key] },
    githubToken: async () => 'ghp_x',
    fetch: vi.fn() as any,
    env: {},
    changed,
    ...overrides,
  })
  return { service, config: () => config, env, changed }
}

const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response

describe('Settings → Git forges', () => {
  it('saves into the Hermes profile the forgejo skill reads, keeping the token unless a new one is given', async () => {
    const s = setup()
    const view = await s.service.save({ url: 'http://192.168.20.5:3030/', hosts: 'Forgejo:3000, http://forgejo:3000/', defaultHome: 'forge', githubOwner: 'Wizard815', token: 'abc123' })
    expect(s.config().skills.config.forgejo).toEqual({ url: 'http://192.168.20.5:3030', default_home: 'forge', github_owner: 'Wizard815' })
    expect(s.config().skills.config.other).toEqual({ a: 1 })
    expect(s.config().model).toEqual({ default: 'x' })
    expect(s.env).toEqual({ FORGE_HOSTS: 'Forgejo:3000,forgejo:3000', FORGE_TOKEN: 'abc123' })
    expect(view).toMatchObject({ source: 'profile', url: 'http://192.168.20.5:3030', defaultHome: 'forge', tokenSet: true, github: { tokenSet: true } })
    expect(JSON.stringify(view)).not.toContain('abc123')
    expect(s.changed).toHaveBeenCalled()
    await s.service.save({ url: 'http://192.168.20.5:3030', defaultHome: 'github' })
    expect(s.env.FORGE_TOKEN).toBe('abc123')
    expect(s.env.FORGE_HOSTS).toBeUndefined()
    await s.service.save({ url: '', clearToken: true })
    expect(s.config().skills.config.forgejo).toBeUndefined()
    expect(s.env.FORGE_TOKEN).toBeUndefined()
  })

  it('says when FORGE_URL on the Studio host wins, and refuses bad values', async () => {
    const s = setup({ env: { FORGE_URL: 'http://forgejo:3000' } })
    expect((await s.service.read()).source).toBe('host')
    await expect(s.service.save({ url: 'ftp://x' })).rejects.toThrow(/http:\/\/ or https:\/\//)
    await expect(s.service.save({ url: 'http://x', hosts: 'bad host' })).rejects.toThrow(/host:port/)
    await expect(s.service.save({ jobsRepo: 'nope' })).rejects.toThrow(/OWNER\/REPO/)
    await expect(s.service.save({ token: 'two words' })).rejects.toThrow(/spaces/)
  })

  it('tests the forge: answering, token refused, and who the token is', async () => {
    const calls: Array<[string, any]> = []
    let userStatus = 200
    const fetch = vi.fn(async (url: string, init: any) => {
      calls.push([url, init.headers])
      if (url.endsWith('/version')) return reply(200, { version: '17.0.1' })
      return reply(userStatus, { login: 'wizard' })
    })
    const s = setup({ fetch: fetch as any })
    await s.service.save({ url: 'http://forge.lan:3030', token: 'tok' })
    expect(await s.service.test()).toEqual({ ok: true, url: 'http://forge.lan:3030', login: 'wizard', version: '17.0.1' })
    expect(calls.at(-1)).toEqual(['http://forge.lan:3030/api/v1/user', { Authorization: 'token tok' }])
    expect(calls.at(-2)![1]).toEqual({})
    userStatus = 401
    await expect(s.service.test({ token: 'other' })).rejects.toThrow(/refused the token/)
    const down = setup({ fetch: vi.fn(async () => { throw new Error('ECONNREFUSED') }) as any })
    await expect(down.service.test({ url: 'http://nowhere:1' })).rejects.toThrow(/isn't answering/)
    await expect(setup().service.test()).rejects.toThrow(/address first/)
  })
})
