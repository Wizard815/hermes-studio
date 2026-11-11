import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

/** Connections → Pondering Orb: connect Orb, and see the Studio chats working on Orb tasks. API mocked. */
test('Pondering Orb connects from Connections and lists the chats working on Orb tasks', async ({ page }) => {
  const errors: string[] = []
  const saved: any[] = []
  let orb = { url: '', hasToken: false }
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en') })
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/studio/orb/settings') {
      saved.push(request.postDataJSON())
      orb = { url: request.postDataJSON().url, hasToken: true }
      return route.fulfill({ json: { ...orb, fromEnv: false } })
    }
    if (path === '/api/studio/orb') return route.fulfill({ json: { connected: !!orb.url, version: orb.url ? '0.3.0' : '', error: '', settings: { ...orb, fromEnv: false } } })
    if (path === '/api/studio/orb/work') {
      return route.fulfill({ json: { work: orb.url ? [{ sessionId: 's1', title: 'Fix flaky login test', agentId: 'ekko-agent', orb: { task: { title: 'Fix flaky login test', list: 'site' } }, status: 'blocked', startedAt: 1, updatedAt: 2 }] : [] } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/orb-connection.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__orb_connection__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__orb_connection__')

  await expect(page.getByTestId('orb-state')).toHaveText('Not connected')
  await expect(page.getByTestId('orb-work-empty')).toBeVisible()
  await page.getByTestId('orb-url').locator('input').fill('http://orb.local:8080')
  await page.getByTestId('orb-token').locator('input').fill('studio:secret')
  await page.getByTestId('orb-save').click()
  await expect.poll(() => saved).toEqual([{ url: 'http://orb.local:8080', token: 'studio:secret' }])
  await expect(page.getByTestId('orb-state')).toHaveText('Connected 0.3.0')
  const work = page.getByTestId('orb-work')
  await expect(work).toContainText('Fix flaky login test')
  await expect(work).toContainText('Needs you')
  await expect(work).toContainText('ekko-agent')
  await work.click()
  await expect.poll(() => page.evaluate(() => (window as any).orbFixture.route())).toBe('/hermes/session/s1')
  expect(errors).toEqual([])
})
