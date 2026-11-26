import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/middleware/auth', () => ({
  authenticateUserToken: vi.fn(async (token: string) => token === 'admin-login' ? { id: 1, username: 'me', role: 'super_admin' }
    : token === 'user-login' ? { id: 2, username: 'you', role: 'user' } : null),
  issueUserJwt: vi.fn(async (user: { id: number }) => `jwt-for-${user.id}-${Math.random()}`),
  getUserJwtExpiresSeconds: () => 3600,
}))

const { upstreamUpkeepProxy, tokenForUpstream } = await import('../../packages/server/src/modules/studio/middleware/upstream-upkeep-proxy')

function ctxFor(path: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  const sent: Record<string, string> = {}
  return {
    sent,
    ctx: {
      path, method: 'GET', search: '', query, secure: false, status: 404, body: undefined as unknown,
      headers, req: { headers }, cookies: { set: vi.fn() }, set: (k: string, v: string) => { sent[k] = v }, type: '',
    } as any,
  }
}

describe('Studio hands Upstream a login through its proxy', () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> })
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends Studio\'s address and a login with every request of its administrator', async () => {
    const { ctx } = ctxFor('/upstream/work', { authorization: 'Bearer admin-login', 'x-studio-token': 'forged', 'x-studio-url': 'http://evil' })
    await upstreamUpkeepProxy()(ctx, async () => {})
    expect(calls).toHaveLength(1)
    const h = calls[0].headers
    expect(h['x-upstream-base']).toBe('/upstream')
    expect(h['x-studio-url']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(h['x-studio-token']).toMatch(/^jwt-for-1-/)
    expect(h.authorization).toBeUndefined()
  })

  it('keeps one login per administrator until half its life is gone', async () => {
    const user = { id: 9, username: 'a', role: 'super_admin' as const }
    const first = await tokenForUpstream(user, 1_000)
    expect(await tokenForUpstream(user, 1_000 + 1_700_000)).toBe(first)
    expect(await tokenForUpstream(user, 1_000 + 1_900_000)).not.toBe(first)
  })

  it('forwards nothing for anyone but a super administrator', async () => {
    for (const auth of [{}, { authorization: 'Bearer user-login' }, { authorization: 'Bearer nonsense' }]) {
      const { ctx } = ctxFor('/upstream/api/tasks', auth)
      await upstreamUpkeepProxy()(ctx, async () => {})
      expect([401, 403]).toContain(ctx.status)
    }
    expect(calls).toHaveLength(0)
  })

  it('answers whether Upstream is up, for administrators only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ status: 'open' }] }), { status: 200 })))
    const { ctx } = ctxFor('/api/studio/upstream/status', { authorization: 'Bearer admin-login' })
    await upstreamUpkeepProxy()(ctx, async () => {})
    expect(ctx.body).toMatchObject({ reachable: true, openTasks: 1 })
    const other = ctxFor('/api/studio/upstream/status', { authorization: 'Bearer user-login' })
    await upstreamUpkeepProxy()(other.ctx, async () => {})
    expect(other.ctx.status).toBe(403)
  })

  it('leaves other paths to the rest of Studio', async () => {
    const { ctx } = ctxFor('/api/hermes/sessions')
    const next = vi.fn(async () => {})
    await upstreamUpkeepProxy()(ctx, next)
    expect(next).toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })
})
