import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/** A JWT-shaped token whose payload says super_admin (the client only reads the role). */
const SUPER_ADMIN_TOKEN = `x.${Buffer.from(JSON.stringify({ role: 'super_admin' })).toString('base64url')}.y`

async function openFixture(page: Page, options: { toolSearch?: string } = {}) {
  const requests: Array<{ method: string; path: string; body: any; profile: string | null }> = []
  const errors: string[] = []
  let notice = { sessionId: 'chat-1', profile: 'rea', total: 252, deferred: 247, toolSearchActive: true, toolSearch: 'auto', threshold: 80, at: Date.now(), dismissed: false }
  let toolSearch: unknown = { enabled: options.toolSearch || 'auto' }
  let threshold = 80
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(token => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', token); localStorage.setItem('hermes_active_profile_name', 'rea'); (window as any).__APP_VERSION__ = 'test' }, SUPER_ADMIN_TOKEN)
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON(), profile: request.headers()['x-hermes-profile'] || null })
    if (url.pathname === '/api/studio/tool-load/chats/chat-1') return route.fulfill({ json: { notice } })
    if (url.pathname === '/api/studio/tool-load/chats/chat-1/dismiss') { notice = { ...notice, dismissed: true }; return route.fulfill({ json: { notice } }) }
    if (url.pathname === '/api/studio/tool-load') {
      if (request.method() === 'PUT') threshold = request.postDataJSON().settings.threshold
      return route.fulfill({ json: { settings: { threshold } } })
    }
    if (url.pathname === '/api/hermes/config') {
      if (request.method() === 'PUT') toolSearch = request.postDataJSON().values.tool_search
      return route.fulfill({ json: request.method() === 'PUT' ? { success: true } : { tools: { tool_search: toolSearch } } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/tool-load.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__tool_load__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  return { requests, errors }
}

test('a Hermes chat with too many tools shows a one-time notice that turns off tool search for its profile', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__tool_load__')
  const banner = page.getByTestId('tool-load-banner')
  await expect(banner).toContainText('This chat has 252 tools. Small models may struggle')
  await expect(banner).toContainText('Tool search hides 247 of them behind tool_search')
  await expect(banner).toContainText('for the profile rea')
  await expect(banner).toHaveAttribute('role', 'status')
  await page.getByTestId('tool-load-search-off').click()
  await expect.poll(() => requests.find(r => r.path === '/api/hermes/config')).toEqual({
    method: 'PUT', path: '/api/hermes/config', profile: 'rea', body: { section: 'tools', values: { tool_search: { enabled: 'off' } } },
  })
  await expect(page.getByTestId('tool-load-search-off')).toHaveCount(0)
  await expect(banner).toContainText('Tool search is already off for this profile.')
  await page.getByTestId('tool-load-mcp').click()
  await expect.poll(() => page.evaluate(() => (window as any).__route())).toBe('/hermes/mcp')
  await page.getByTestId('tool-load-settings').click()
  await expect.poll(() => page.evaluate(() => (window as any).__route())).toBe('/hermes/config/settings?tab=tools')
  await page.getByTestId('tool-load-dismiss').click()
  await expect(banner).toHaveCount(0)
  expect(requests.some(r => r.path === '/api/studio/tool-load/chats/chat-1/dismiss')).toBe(true)
  expect(errors).toEqual([])
})

test('Settings → Tools switches tool search for the active profile and changes the warning threshold', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__tool_load__')
  const settings = page.getByTestId('tool-search-settings')
  await expect(settings).toContainText('Tool search for rea')
  const toggle = page.getByTestId('tool-search-switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(settings).toContainText('Off')
  expect(requests.find(r => r.path === '/api/hermes/config')?.body).toEqual({ section: 'tools', values: { tool_search: { enabled: 'off' } } })
  await toggle.click()
  await expect.poll(() => requests.filter(r => r.path === '/api/hermes/config').map(r => r.body.values.tool_search.enabled)).toEqual(['off', 'auto'])
  const input = page.getByTestId('tool-load-threshold').locator('input')
  await input.fill('120')
  await input.blur()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/tool-load')?.body).toEqual({ settings: { threshold: 120 } })
  expect(errors).toEqual([])
})

test('after a reload the notice reads the profile\'s current tool search: off already, so no button to turn it off', async ({ page }) => {
  // The saved notice still says toolSearch: auto (from when it was made); the profile has it off now.
  const { errors } = await openFixture(page, { toolSearch: 'off' })
  await page.goto('/__tool_load__')
  const banner = page.getByTestId('tool-load-banner')
  await expect(banner).toContainText('This chat has 252 tools.')
  await expect(banner).toContainText('Tool search is already off for this profile.')
  await expect(page.getByTestId('tool-load-search-off')).toHaveCount(0)
  await expect(banner).not.toContainText('Tool search hides 247')
  expect(errors).toEqual([])
})
