import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

/** Connections → Omi: address and test, a key shown once and revoked, the results webhook, Omi's chats. API mocked. */
test('Omi connects from Connections: key once, revoke, webhook secret once, work chats', async ({ page }) => {
  const errors: string[] = []
  const calls: string[] = []
  const state = {
    settings: { url: '', webUrl: '', profile: '' },
    keys: [] as any[],
    webhook: { registered: false, url: '', enabled: false, runtime: null as any },
  }
  const status = () => ({ ...state, mcpUrl: state.settings.url ? `${state.settings.url}/v1/mcp` : '' })
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en') })
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    calls.push(`${request.method()} ${path}`)
    if (path === '/api/studio/omi/settings') {
      state.settings = { ...state.settings, ...request.postDataJSON() }
      state.webhook.url = `${state.settings.url}/v1/integrations/studio/events`
      return route.fulfill({ json: status() })
    }
    if (path === '/api/studio/omi') return route.fulfill({ json: status() })
    if (path === '/api/studio/omi/test') return route.fulfill({ json: { ok: true, detail: 'Omi answered /v1/health (ok)', error: '' } })
    if (path === '/api/studio/omi/keys' && request.method() === 'POST') {
      const key = { id: 'k1', name: request.postDataJSON().name, preview: 'sk-studio-omi-…WXYZ', userId: 1, createdAt: 1, lastUsedAt: null }
      state.keys = [key]
      return route.fulfill({ status: 201, json: { key, apiKey: `sk-studio-omi-${'A'.repeat(39)}WXYZ` } })
    }
    if (path === '/api/studio/omi/keys/k1') { state.keys = []; return route.fulfill({ json: { revoked: true } }) }
    if (path === '/api/studio/omi/webhook') {
      state.webhook = { ...state.webhook, registered: true, enabled: true, runtime: { state: 'idle', delivered: 0, failed: 0, last_error: null, last_success_at: null } }
      return route.fulfill({ json: { status: status(), secret: 'f'.repeat(64) } })
    }
    if (path === '/api/studio/omi/work') {
      return route.fulfill({ json: { work: state.settings.url ? [{ sessionId: 's9', title: 'Fix the gate sensor', agentId: 'hermes', orb: {}, status: 'blocked', startedAt: 1, updatedAt: 2, source: 'omi' }] : [] } })
    }
    if (path === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default', active: true }, { name: 'robin', active: false }] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/omi-connection.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__omi_connection__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__omi_connection__')

  await expect(page.getByTestId('omi-no-keys')).toBeVisible()
  await expect(page.getByTestId('omi-webhook-state')).toHaveText('Not registered')
  await page.getByTestId('omi-url').locator('input').fill('http://omi.lan:8000')
  await page.getByTestId('omi-save').click()
  await expect.poll(() => state.settings.url).toBe('http://omi.lan:8000')
  await expect(page.getByTestId('omi-open-web')).toHaveAttribute('href', 'http://omi.lan:8000')
  await page.getByTestId('omi-test').click()
  await expect(page.getByTestId('omi-test-result')).toHaveText('Connected: Omi answered /v1/health (ok)')

  await page.getByTestId('omi-key-create').click()
  await expect(page.getByTestId('omi-shown-value').locator('input')).toHaveValue(/^sk-studio-omi-A+WXYZ$/)
  await page.getByTestId('omi-shown-done').click()
  await expect(page.getByTestId('omi-shown-once')).toBeHidden()
  await expect(page.getByTestId('omi-key')).toContainText('sk-studio-omi-…WXYZ')
  await expect(page.getByTestId('omi-key')).toContainText('Not used yet')
  await page.getByTestId('omi-key-revoke').click()
  await page.getByRole('button', { name: 'Revoke' }).last().click()
  await expect(page.getByTestId('omi-no-keys')).toBeVisible()
  expect(calls).toContain('DELETE /api/studio/omi/keys/k1')

  await page.getByTestId('omi-webhook-register').click()
  await expect(page.getByTestId('omi-shown-value').locator('input')).toHaveValue('f'.repeat(64))
  await page.getByTestId('omi-shown-done').click()
  await expect(page.getByTestId('omi-webhook-state')).toHaveText('Registered')

  const work = page.getByTestId('omi-work')
  await expect(work).toContainText('Fix the gate sensor')
  await expect(work).toContainText('Needs you')
  await work.click()
  await expect.poll(() => page.evaluate(() => (window as any).omiFixture.route())).toBe('/hermes/session/s9')
  expect(errors).toEqual([])
})
