import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { resolve } from 'node:path'

// A 2x4 PNG (portrait), so the screen keeps a phone's shape.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAIAAAArjXluAAAAEklEQVR4nGNgYPj/H4QZsDEAvvAP8ZgCZ5UAAAAASUVORK5CYII=', 'base64')

const DEVICES = [
  { serial: 'emulator-5554', state: 'device', kind: 'emulator', model: 'sdk gphone64 x86 64', product: 'sdk', avd: 'Pixel_8_API_35' },
  { serial: '192.168.1.20:5555', state: 'device', kind: 'network', model: 'Pixel 7', product: 'panther' },
  { serial: 'R5CT1234ABC', state: 'unauthorized', kind: 'usb', model: '', product: '' },
]

interface SocketLog { events: Array<{ name: string; data: any }> }

/** Just enough of Engine.IO v4 / Socket.IO v5 for the `/android` namespace. */
function serveAndroidSocket(ws: WebSocketRoute, log: SocketLog) {
  ws.send(`0${JSON.stringify({ sid: 'e2e', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1e6 })}`)
  ws.onMessage(message => {
    const text = String(message)
    if (text === '2') return ws.send('3')
    if (text.startsWith('40/android')) return ws.send('40/android,{"sid":"android-e2e"}')
    const event = /^42\/android,(\d*)(\[.*\])$/.exec(text)
    if (!event) return
    const [name, data] = JSON.parse(event[2])
    log.events.push({ name, data })
    if (event[1]) ws.send(`43/android,${event[1]}[{"ok":true}]`)
    if (name === 'screen.watch') {
      ws.send(`451-/android,["screen.frame",{"serial":${JSON.stringify(data.serial)},"mime":"image/png","width":2,"height":4,"source":"screencap","data":{"_placeholder":true,"num":0}}]`)
      ws.send(PNG)
    }
  })
}

async function openFixture(page: Page) {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const socket: SocketLog = { events: [] }
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', ws => serveAndroidSocket(ws, socket))
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() })
    if (url.pathname === '/api/studio/android') {
      return route.fulfill({ json: {
        adb: '/usr/bin/adb', adbVersion: '1.0.41', emulator: '/opt/android-sdk/emulator/emulator',
        settings: { adbPath: '', sdkPath: '', streamWidth: 540 },
        devices: DEVICES,
        avds: [{ name: 'Pixel_8_API_35', running: true, serial: 'emulator-5554' }, { name: 'Tablet_API_34', running: false }],
      } })
    }
    if (url.pathname === '/api/studio/android/connect') return route.fulfill({ json: { serial: '10.0.0.5:5555', message: 'connected to 10.0.0.5:5555' } })
    return route.fulfill({ json: { ok: true } })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/android-devices-view.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__android_view__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  return { requests, socket, errors }
}

test('lists devices, streams the selected screen and sends taps and keys', async ({ page }) => {
  const { socket, errors } = await openFixture(page)
  await page.goto('/__android_view__')
  const list = page.getByTestId('android-devices')
  await expect(list.locator('.android-device')).toHaveCount(3)
  await expect(list.locator('.android-device').nth(2)).toBeDisabled()

  const screen = page.getByTestId('android-screen')
  await expect(screen).toBeVisible()
  await expect.poll(() => socket.events.find(e => e.name === 'screen.watch')?.data).toEqual({ serial: 'emulator-5554' })

  const box = (await screen.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 4)
  await expect.poll(() => socket.events.find(e => e.name === 'input')?.data).toMatchObject({
    serial: 'emulator-5554', gesture: { type: 'tap', x: expect.closeTo(0.5, 1), y: expect.closeTo(0.25, 1) },
  })

  await page.getByRole('button', { name: 'Home' }).click()
  await expect.poll(() => socket.events.filter(e => e.name === 'input').map(e => e.data.gesture)).toContainEqual({ type: 'key', key: 'home' })

  // Picking the wireless phone moves the stream to it.
  await list.locator('.android-device').nth(1).click()
  await expect.poll(() => socket.events.filter(e => e.name === 'screen.unwatch').map(e => e.data.serial)).toEqual(['emulator-5554'])
  await expect.poll(() => socket.events.filter(e => e.name === 'screen.watch').map(e => e.data.serial)).toContain('192.168.1.20:5555')
  expect(errors).toEqual([])
})

test('connects a network device such as BlueStacks and starts an emulator', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__android_view__')
  await page.getByTestId('android-connect-endpoint').locator('input').fill('10.0.0.5')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/android/connect')?.body).toEqual({ endpoint: '10.0.0.5' })
  await page.getByRole('button', { name: 'Start' }).click()
  await expect.poll(() => requests.some(r => r.path === '/api/studio/android/avds/Tablet_API_34/start')).toBe(true)
  expect(errors).toEqual([])
})
