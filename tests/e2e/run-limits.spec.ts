import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/** A JWT-shaped token whose payload says super_admin (the client only reads the role). */
const SUPER_ADMIN_TOKEN = `x.${Buffer.from(JSON.stringify({ role: 'super_admin' })).toString('base64url')}.y`

async function openFixture(page: Page) {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const errors: string[] = []
  let defaults = { costUsd: null as number | null, tokens: null as number | null, minutes: null as number | null, loopRepeats: 5 as number | null }
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(token => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', token); (window as any).__APP_VERSION__ = 'test' }, SUPER_ADMIN_TOKEN)
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() })
    if (url.pathname === '/api/studio/run-limits') {
      if (request.method() === 'PUT') defaults = { ...defaults, ...request.postDataJSON().defaults }
      return route.fulfill({ json: { defaults } })
    }
    if (url.pathname === '/api/studio/run-limits/chats/chat-1/continue') {
      return route.fulfill({ json: { defaults, overrides: { loopRepeats: 10 }, effective: { ...defaults, loopRepeats: 10 }, hit: null, run: null, raised: { kind: 'loop', value: 10 } } })
    }
    if (url.pathname === '/api/studio/run-limits/chats/chat-1/stop') {
      return route.fulfill({ json: { defaults, overrides: {}, effective: defaults, hit: null, run: null } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/run-limits.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__run_limits__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  return { requests, errors }
}

test('run limits in Settings: loop detector on by default, a cost limit can be turned on and changed', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__run_limits__')
  const settings = page.getByTestId('run-limits-settings')
  await expect(settings).toBeVisible()
  await expect(page.getByTestId('run-limit-loop-switch')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('run-limit-cost-switch')).toHaveAttribute('aria-checked', 'false')
  await page.getByTestId('run-limit-cost-switch').click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/run-limits')?.body).toEqual({ defaults: { costUsd: 2 } })
  const cost = page.getByTestId('run-limit-cost-input').locator('input')
  await cost.fill('0.5')
  await cost.blur()
  await expect.poll(() => requests.filter(r => r.path === '/api/studio/run-limits').map(r => r.body)).toContainEqual({ defaults: { costUsd: 0.5 } })
  expect(errors).toEqual([])
})

test('the limit card says which limit stopped the run and offers Continue with a higher limit or Stop', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__run_limits__')
  const banner = page.getByTestId('run-limit-banner')
  await expect(banner).toContainText('Run stopped by a limit')
  await expect(banner).toContainText('The same tool call with the same arguments ran 5 times in a row.')
  await expect(banner).toContainText('terminal({"command":"ls"})')
  await expect(page.getByTestId('run-limit-continue')).toHaveText('Continue with a higher limit (10 in a row)')
  await page.getByTestId('run-limit-continue').click()
  await expect.poll(() => requests.some(r => r.path === '/api/studio/run-limits/chats/chat-1/continue')).toBe(true)
  await page.getByTestId('run-limit-stop').click()
  await expect.poll(() => requests.some(r => r.path === '/api/studio/run-limits/chats/chat-1/stop')).toBe(true)
  await page.evaluate(() => (window as any).__clearLimit())
  await expect(banner).toHaveCount(0)
  expect(errors).toEqual([])
})
