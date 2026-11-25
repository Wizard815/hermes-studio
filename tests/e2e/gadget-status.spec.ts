import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

function status(listening: boolean) {
  return {
    profile: 'default',
    plugin: { installed: true, enabled: true },
    platform: { enabled: true, configured: true, host: '0.0.0.0', port: 8765, path: '/gadget', tls: false },
    gateway: { running: true, state: listening ? 'connected' : null, error: null },
    listening, portOpen: listening, statusUpdatedAt: listening ? Date.now() / 1000 : null,
    devices: [], connected: 0, env: { host: '', port: '' },
  }
}

/** Hermes Gadget card: "Restart gateway" shows "Restarting…" until the gateway listens again. API mocked. */
test('the Gadget card says Restarting… during a gateway restart, then Listening', async ({ page }) => {
  const errors: string[] = []
  let listening = true
  let restarts = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en') })
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/hermes/plugins/gadget/status') return route.fulfill({ json: status(listening) })
    if (path === '/api/hermes/profiles/default/gateway/restart') {
      restarts += 1
      listening = false
      return route.fulfill({ json: { success: true, gateway: { running: true } } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/gadget-status.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__gadget_status__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__gadget_status__')

  const listeningFact = page.getByTestId('gadget-listening')
  await expect(listeningFact).toContainText('Yes')
  await page.getByRole('button', { name: 'Restart gateway' }).click()
  await expect.poll(() => restarts).toBe(1)
  // Not "No ... Restart the gateway to apply" while it restarts.
  await expect(listeningFact).toContainText('Restarting…')
  await expect(page.getByTestId('gadget-notice')).toHaveText(/The gateway is restarting/)
  await expect(page.getByTestId('gadget-notice')).toHaveAttribute('role', 'status')
  listening = true
  await expect(listeningFact).toContainText('Yes', { timeout: 10_000 })
  await expect(page.getByTestId('gadget-notice')).toHaveCount(0)
  expect(errors).toEqual([])
})
