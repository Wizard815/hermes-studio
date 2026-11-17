import { describe, expect, it, vi } from 'vitest'

const auth = { credential_pool: { openrouter: [
  { auth_type: 'api_key', access_token: 'pool-1' },
  { auth_type: 'api_key', access_token: 'pool-2' },
] } }

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
})
