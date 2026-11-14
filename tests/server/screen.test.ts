import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ authenticateUserToken: async () => ({ role: 'super_admin' }) }))

const { ScreenGateway, SCREEN_WS_PATH } = await import('../../packages/server/src/modules/studio/services/screen/gateway')
const { bridgeScript, hermesHome, viewerHash } = await import('../../packages/server/src/modules/studio/services/screen/manager')

describe("agents' screen", () => {
  it('names viewers per user and browser tab, with only safe characters', () => {
    expect(ScreenGateway.viewerId(1, 'abc123')).toBe('studio:1:abc123')
    expect(ScreenGateway.viewerId(2, '../../x y;z')).toBe('studio:2:xyz')
    expect(ScreenGateway.viewerId(3, '')).toBe('studio:3:viewer')
  })

  it("matches Hermes's viewer hash, so Studio knows who holds control", () => {
    // tools/bot_desktop/lease.py public_view: sha256(viewer_id).hexdigest()[:12]
    expect(viewerHash('studio:1:abc')).toBe(createHash('sha256').update('studio:1:abc').digest('hex').slice(0, 12))
    expect(viewerHash('studio:1:abc')).toHaveLength(12)
  })

  it('gives single-use tickets that expire', () => {
    vi.useFakeTimers()
    try {
      const gateway = new ScreenGateway({} as any)
      const ticket = gateway.createTicket('studio:1:a', 'token')
      expect((gateway as any).takeTicket(ticket)).toMatchObject({ viewerId: 'studio:1:a' })
      expect((gateway as any).takeTicket(ticket)).toBeNull()
      const late = gateway.createTicket('studio:1:a', 'token')
      vi.advanceTimersByTime(31_000)
      expect((gateway as any).takeTicket(late)).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('only takes its own websocket path', () => {
    const gateway = new ScreenGateway({} as any)
    expect(gateway.handlesUpgrade({ url: `${SCREEN_WS_PATH}?ticket=x` } as any)).toBe(true)
    expect(gateway.handlesUpgrade({ url: '/socket.io/?x' } as any)).toBe(false)
  })

  it('finds its helper script and Hermes home', () => {
    expect(existsSync(bridgeScript())).toBe(true)
    expect(hermesHome({ HERMES_HOME: '/data/h' } as any)).toBe('/data/h')
  })
})
