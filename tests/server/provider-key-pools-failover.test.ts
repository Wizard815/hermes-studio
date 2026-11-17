import { describe, expect, it, vi } from 'vitest'

const auth = { credential_pool: {
  openrouter: [
    { auth_type: 'api_key', access_token: 'pool-1' },
    { auth_type: 'api_key', access_token: 'pool-2' },
  ],
  fake2: [
    { auth_type: 'api_key', access_token: 'p-a' },
    { auth_type: 'api_key', access_token: 'p-b' },
  ],
  fake: [
    { auth_type: 'api_key', access_token: 'dummy-a' },
    { auth_type: 'api_key', access_token: 'dummy-b' },
  ],
  allbad: [
    { auth_type: 'api_key', access_token: 'bad-1' },
    { auth_type: 'api_key', access_token: 'bad-2' },
  ],
} }

vi.mock('../../packages/server/src/modules/studio/services/providers/account-store', () => ({
  importAccountProviders: async () => undefined,
  providerAccountHome: () => '/tmp/account',
  providerAccountId: () => 7,
}))
vi.mock('../../packages/server/src/modules/studio/public/safe-file-store', () => ({
  safeFileStore: { readText: async () => JSON.stringify(auth) },
}))

const pools = await import('../../packages/server/src/modules/studio/services/providers/key-pools')

describe('key pools on a rate limit', () => {
  it('rests a rate-limited key and moves to the next one', async () => {
    const now = 1_000_000
    const next = await pools.failoverPooledApiKey('openrouter', 'main', 'default', '30', now)
    expect(next).toBe('pool-1')
    // While "main" rests, turns skip it.
    const turns = [] as Array<string | undefined>
    for (let i = 0; i < 4; i += 1) turns.push(await pools.nextPooledApiKey('openrouter', 'main', 'default', now + 1_000))
    expect(turns).not.toContain('main')
    // After its rest, it is back in the rotation.
    const later = [] as Array<string | undefined>
    for (let i = 0; i < 3; i += 1) later.push(await pools.nextPooledApiKey('openrouter', 'main', 'default', now + 31_000))
    expect(later).toContain('main')
  })

  it('gives no other key when every key is resting', async () => {
    const now = 5_000_000
    expect(await pools.failoverPooledApiKey('openrouter', 'main', 'default', null, now)).toBe('pool-1')
    expect(await pools.failoverPooledApiKey('openrouter', 'pool-1', 'default', null, now)).toBe('pool-2')
    expect(await pools.failoverPooledApiKey('openrouter', 'pool-2', 'default', null, now)).toBeUndefined()
  })

  it('reads Retry-After as seconds or a date, with sensible bounds', () => {
    expect(pools.restMs('30')).toBe(30_000)
    expect(pools.restMs(null)).toBe(60_000)
    expect(pools.restMs('99999')).toBe(600_000)
    expect(pools.restMs(new Date(2_000_000 + 5_000).toUTCString(), 2_000_000)).toBeGreaterThanOrEqual(1_000)
  })

  it('keeps the Provider\'s own key in the pool when a pooled key fails', async () => {
    const now = 9_000_000
    // The gateway's turn tells the pool which key is the Provider's own.
    await pools.nextPooledApiKey('fake', 'good-key', 'default', now)
    // dummy-a fails: the Provider's own key is still a candidate (it used to drop out).
    expect(await pools.failoverPooledApiKey('fake', 'dummy-a', 'default', '30', now)).toBe('good-key')
    expect(await pools.failoverPooledApiKey('fake', 'good-key', 'default', '30', now)).toBe('dummy-b')
  })

  it('moves a request across every rate-limited key until one answers', async () => {
    const sent: Array<string | undefined> = []
    await pools.nextPooledApiKey('fake2', 'm', 'default')
    const limited = new Set(['p-a', 'm'])
    const send = async (key: string | undefined) => {
      sent.push(key)
      return limited.has(String(key))
        ? new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '30' } })
        : new Response(`ok ${key}`, { status: 200 })
    }
    const response = await pools.sendWithKeyPool({ provider: 'fake2', apiKey: 'p-a', profile: 'default' }, send)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok p-b')
    expect(sent).toEqual(['p-a', 'm', 'p-b'])
  })

  it('answers with one clear error when every key in the pool is rate-limited', async () => {
    await pools.nextPooledApiKey('allbad', 'bad-main', 'default')
    const sent: Array<string | undefined> = []
    const response = await pools.sendWithKeyPool({ provider: 'allbad', apiKey: 'bad-main', profile: 'default' }, async key => {
      sent.push(key)
      return new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '20' } })
    })
    expect(sent).toEqual(['bad-main', 'bad-1', 'bad-2'])
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    const body = await response.json()
    expect(body.error.code).toBe('key_pool_exhausted')
    expect(body.error.message).toContain('All 3 API keys for allbad are rate-limited')
  })

  it('passes other answers through untouched', async () => {
    const response = await pools.sendWithKeyPool({ provider: 'fake', apiKey: 'x', profile: 'default' }, async () => new Response('bad', { status: 401 }))
    expect(response.status).toBe(401)
  })
})
