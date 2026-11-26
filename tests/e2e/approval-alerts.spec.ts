import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/** A JWT-shaped token whose payload says super_admin (the client only reads the role). */
const SUPER_ADMIN_TOKEN = `x.${Buffer.from(JSON.stringify({ role: 'super_admin' })).toString('base64url')}.y`

/** Settings → Watcher → Where approvals reach you, and Settings → Android app (docs/approval-alerts.md). */
async function openFixture(page: Page, options: { inApp?: boolean } = {}) {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const errors: string[] = []
  let prefs = { route: 'mattermost', kinds: { work: true, chat: false, phone: false, blocked: false } }
  let devices: any[] = [
    { id: 'd1', name: 'Pixel 8', preview: 'sk-studio-phone-…a1b2', userId: 1, createdAt: Date.now() - 86_400_000, lastUsedAt: Date.now() - 60_000, connected: true },
  ]
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ token, inApp }) => {
    localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', token); (window as any).__APP_VERSION__ = 'test'
    if (!inApp) return
    // Studio Own's page bridge, as StudioBridge.kt injects it.
    const calls: any[] = []
    ;(window as any).__bridgeCalls = calls
    const state = (detail: any) => window.dispatchEvent(new CustomEvent('studio-own:alerts', { detail: { channel: 'alerts', paired: false, deviceName: '', mode: 'off', notifications: 'granted', unrestricted: false, ...detail } }))
    ;(window as any).StudioOwn = {
      isTermuxInstalled: () => false,
      runInTermux: () => undefined,
      approvalAlerts: {
        status: () => { calls.push(['status']); setTimeout(() => state({}), 0) },
        pair: (code: string, name: string) => { calls.push(['pair', code, name]); setTimeout(() => state({ paired: true, deviceName: 'Pixel 8', mode: 'live', message: 'Paired. Approval alerts are on.' }), 0) },
        setMode: (mode: string) => { calls.push(['mode', mode]); setTimeout(() => state({ paired: true, deviceName: 'Pixel 8', mode }), 0) },
        unpair: () => { calls.push(['unpair']); setTimeout(() => state({}), 0) },
        openBatterySettings: () => calls.push(['battery']),
      },
    }
  }, { token: SUPER_ADMIN_TOKEN, inApp: !!options.inApp })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.method() === 'GET' || request.method() === 'DELETE' ? null : request.postDataJSON()
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body })
    switch (url.pathname) {
      case '/api/studio/approval-alerts':
        return route.fulfill({ json: { prefs, devices, mattermost: { channel: 'agent-work', buttons: false } } })
      case '/api/studio/approval-alerts/prefs':
        prefs = { route: body.prefs.route ?? prefs.route, kinds: { ...prefs.kinds, ...body.prefs.kinds } }
        return route.fulfill({ json: { prefs } })
      case '/api/studio/approval-alerts/pairing':
        return route.fulfill({ json: { code: 'ABCD-EF23', expiresAt: Date.now() + 600_000 } })
      case '/api/studio/approval-alerts/test':
        return route.fulfill({ json: { item: {}, connected: devices.filter(d => d.connected).length } })
    }
    if (url.pathname.startsWith('/api/studio/approval-alerts/devices/') && request.method() === 'DELETE') {
      devices = devices.filter(device => !url.pathname.endsWith(device.id))
      return route.fulfill({ json: { removed: true, devices } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/approval-alerts.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__approval_alerts__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__approval_alerts__')
  return { requests, errors }
}

test('Where approvals reach you: pick Mattermost, the Android app, both or off, and which kinds', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  const section = page.getByTestId('approval-alerts-settings')
  await expect(section.getByRole('heading', { name: 'Where approvals reach you' })).toBeVisible()
  // Nobody picked: what Studio did before.
  await expect(section.getByTestId('approval-alerts-route-hint')).toHaveText(/Agent work's Mattermost channel/)
  await expect(section.getByTestId('approval-alerts-mattermost-note')).toContainText('~agent-work')
  await expect(section.getByText('The posts have no buttons until')).toBeVisible()

  await section.getByTestId('approval-alerts-route').getByText('Android app', { exact: true }).click()
  await expect.poll(() => requests.at(-1)).toMatchObject({ method: 'PUT', path: '/api/studio/approval-alerts/prefs', body: { prefs: { route: 'android' } } })
  await expect(section.getByTestId('approval-alerts-route-hint')).toHaveText(/paired phone \(Studio Own\)/)
  await expect(section.getByTestId('approval-alerts-mattermost-note')).toHaveCount(0)
  await expect(section.getByTestId('approval-alerts-android-note')).toContainText('Phones paired: 1')

  await section.getByTestId('approval-alerts-kind-chat').click()
  await expect.poll(() => requests.at(-1)?.body?.prefs?.kinds?.chat).toBe(true)

  await section.getByTestId('approval-alerts-route').getByText('Both', { exact: true }).click()
  await expect.poll(() => requests.at(-1)?.body?.prefs?.route).toBe('both')
  await expect(section.getByTestId('approval-alerts-mattermost-note')).toBeVisible()
  await expect(section.getByTestId('approval-alerts-android-note')).toBeVisible()

  await section.getByTestId('approval-alerts-route').getByText('Off', { exact: true }).click()
  await expect.poll(() => requests.at(-1)?.body?.prefs?.route).toBe('off')
  await expect(section.getByTestId('approval-alerts-kind-work')).toHaveClass(/n-checkbox--disabled/)

  await section.getByTestId('approval-alerts-route').getByText('Android app', { exact: true }).click()
  await section.getByTestId('approval-alerts-pair').click()
  await expect.poll(() => page.evaluate(() => (window as any).__route())).toContain('tab=android-app')
  expect(errors).toEqual([])
})

test('Settings → Android app makes a one-use pairing code with a QR code, lists phones and removes one', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  const section = page.getByTestId('android-app-settings')
  await expect(section.getByTestId('android-app-route')).toHaveText(/not sent to the Android app yet/)
  await section.getByLabel('Phone name').fill('Robin’s Pixel')
  await section.getByRole('button', { name: 'Make a pairing code' }).click()
  await expect(section.getByTestId('android-app-pin')).toHaveText('ABCD-EF23')
  await expect(section.getByRole('img', { name: 'QR code that pairs a phone with this Studio' })).toBeVisible()
  expect(requests.find(r => r.path === '/api/studio/approval-alerts/pairing')?.body).toEqual({ name: 'Robin’s Pixel' })
  await expect(section.getByText(/Works until/)).toBeVisible()

  const phone = section.getByTestId('android-app-device')
  await expect(phone).toContainText('Pixel 8')
  await expect(phone).toContainText('Connected now')
  await section.getByRole('button', { name: 'Send a test notification' }).click()
  await expect(section.getByTestId('android-app-test-result')).toHaveText('Sent to connected phones: 1.')

  await phone.getByRole('button', { name: 'Remove Pixel 8' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click()
  await expect(section.getByText('No phones yet.')).toBeVisible()
  expect(requests.some(r => r.method === 'DELETE' && r.path === '/api/studio/approval-alerts/devices/d1')).toBe(true)
  await expect(section.getByRole('button', { name: 'Send a test notification' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('inside Studio Own, "Pair this phone" pairs through the app and picks Live or Battery saver', async ({ page }) => {
  const { errors } = await openFixture(page, { inApp: true })
  const card = page.getByTestId('android-app-this-phone')
  await expect(card).toContainText('This phone is not paired.')
  await card.getByRole('button', { name: 'Pair this phone' }).click()
  await expect(card).toContainText('Paired as Pixel 8.')
  await expect(card).toContainText('Paired. Approval alerts are on.')
  expect(await page.evaluate(() => (window as any).__bridgeCalls)).toContainEqual(['pair', 'ABCD-EF23', ''])
  await expect(card.getByText(/Keeps one connection to Studio open/)).toBeVisible()
  await card.getByRole('button', { name: 'Open battery settings' }).click()
  await card.getByText('Battery saver', { exact: true }).click()
  await expect(card.getByText(/Checks every 15 minutes/)).toBeVisible()
  const calls = await page.evaluate(() => (window as any).__bridgeCalls)
  expect(calls).toContainEqual(['mode', 'saver'])
  expect(calls).toContainEqual(['battery'])
  expect(errors).toEqual([])
})
