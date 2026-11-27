import { afterEach, describe, expect, it } from 'vitest'
import { getStatus } from '../../packages/server/src/modules/studio/controllers/browser'
import { setHeadlessBrowserService, type HeadlessBrowserService } from '../../packages/server/src/modules/studio/services/headless-browser-service'

afterEach(() => setHeadlessBrowserService(null as unknown as HeadlessBrowserService))

describe('TestBrowser_statusHidesBrokerToken', () => {
  it('the public status route never returns the broker master token', async () => {
    setHeadlessBrowserService({
      descriptor: { schema: 1, endpoint: 'http://127.0.0.1:1/v1', token: 'secret-master-token' },
      masterToken: 'secret-master-token',
      getStats: () => ({ tabCount: 1, clientCount: 0, leaseCount: 0 }),
    } as unknown as HeadlessBrowserService)
    const ctx: any = { body: undefined }
    await getStatus(ctx)
    expect(ctx.body).toEqual({ available: true, stats: { tabCount: 1, clientCount: 0, leaseCount: 0 } })
    expect(JSON.stringify(ctx.body)).not.toContain('secret-master-token')
  })
})
