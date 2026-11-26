import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { resolve } from 'node:path'

// Agents on the phone: the Android page lets the person open a device to agents, answer their
// questions, see what they did (and where they tapped), and take the phone over.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAIAAAArjXluAAAAEklEQVR4nGNgYPj/H4QZsDEAvvAP8ZgCZ5UAAAAASUVORK5CYII=', 'base64')
const DEVICE = { serial: 'emulator-5554', state: 'device', kind: 'emulator', model: 'sdk gphone64', product: 'sdk', avd: 'Pixel_8_API_35' }
const QUESTION = { id: 'q1', at: Date.now(), serial: 'emulator-5554', device: 'Pixel_8_API_35', action: 'tap', summary: 'tap e4 "Send"', reason: 'presses "Send"', agent: 'hermes', sessionId: 'chat-1', trustValue: 'android:emulator-5554:com.example.chat:tap' }
const TAP = { id: 'a1', at: Date.now(), serial: 'emulator-5554', action: 'tap', summary: 'tap e2 "Compose"', status: 'done', level: 'act', agent: 'hermes', sessionId: 'chat-1', point: { x: 0.9, y: 0.9 } }

function serve(ws: WebSocketRoute, sockets: WebSocketRoute[]) {
  sockets.push(ws)
  ws.send(`0${JSON.stringify({ sid: 'e2e', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1e6 })}`)
  ws.onMessage(message => {
    const text = String(message)
    if (text === '2') return ws.send('3')
    if (text.startsWith('40/android')) return ws.send('40/android,{"sid":"android-e2e"}')
    const event = /^42\/android,(\d*)(\[.*\])$/.exec(text)
    if (!event) return
    const [name, data] = JSON.parse(event[2])
    if (event[1]) ws.send(`43/android,${event[1]}[{"ok":true}]`)
    if (name === 'screen.watch') {
      ws.send(`451-/android,["screen.frame",{"serial":${JSON.stringify(data.serial)},"mime":"image/png","width":2,"height":4,"source":"screencap","data":{"_placeholder":true,"num":0}}]`)
      ws.send(PNG)
    }
  })
}

async function open(page: Page) {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const sockets: WebSocketRoute[] = []
  const errors: string[] = []
  let settings = { adbPath: '', sdkPath: '', streamWidth: 540, autoConnect: [], detectBlueStacks: false, adbServer: '', agentDevices: [] as string[] }
  let held = false
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', ws => serve(ws, sockets))
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() })
    if (url.pathname === '/api/studio/android/settings') { settings = { ...settings, ...request.postDataJSON() }; return route.fulfill({ json: { settings } }) }
    if (url.pathname === '/api/studio/android') return route.fulfill({ json: { adb: '/usr/bin/adb', adbVersion: '1.0.41', emulator: null, settings, bluestacks: [], devices: [DEVICE], avds: [] } })
    if (url.pathname === '/api/studio/android/agent') return route.fulfill({ json: { log: [], approvals: [], takenOver: held ? ['emulator-5554'] : [] } })
    if (url.pathname === '/api/studio/android/devices/emulator-5554/takeover') { held = request.postDataJSON().held; return route.fulfill({ json: { serial: 'emulator-5554', held } }) }
    return route.fulfill({ json: { ok: true } })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/android-devices-view.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__android_view__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  const push = (name: string, data: unknown) => { for (const ws of sockets) ws.send(`42/android,${JSON.stringify([name, data])}`) }
  return { requests, errors, push }
}

test('a device is closed to agents until the person opens it; then questions, the log and the tap mark show', async ({ page }) => {
  const { requests, errors, push } = await open(page)
  await page.goto('/__android_view__')
  const panel = page.getByTestId('android-agent-panel')
  await expect(panel).toContainText('Agents cannot see or use this device.')
  const allow = page.getByTestId('android-agent-allow')
  await expect(allow).toHaveAttribute('aria-checked', 'false')
  await allow.click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/android/settings')?.body).toEqual({ agentDevices: ['emulator-5554'] })
  await expect(allow).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('android-screen')).toBeVisible()

  push('agent.approval', QUESTION)
  const questions = page.getByTestId('android-agent-questions')
  await expect(questions).toContainText('hermes wants to tap e4 "Send" on Pixel_8_API_35.')
  await expect(questions).toContainText('Why it asks: presses "Send".')
  // The question names the chat that asked; Open chat goes there.
  await page.getByTestId('android-agent-open-chat').click()
  await expect.poll(() => page.evaluate(() => (window as any).__route())).toBe('/hermes/session/chat-1')
  await page.getByTestId('android-agent-allow-once').click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/android/agent/approvals/q1')?.body).toEqual({ allow: true })
  await expect(questions).toHaveCount(0)

  push('agent.action', TAP)
  await expect(page.getByTestId('android-agent-log')).toContainText('Donehermes: tap e2 "Compose"')
  await expect(page.getByTestId('android-agent-mark')).toBeVisible()
  await expect(page.getByTestId('android-agent-mark')).toHaveAttribute('aria-label', 'hermes: tap e2 "Compose"')
  expect(errors).toEqual([])
})

test('Take over keeps agents off the phone until it is handed back', async ({ page }) => {
  const { requests, errors } = await open(page)
  await page.goto('/__android_view__')
  await page.getByTestId('android-agent-allow').click()
  const button = page.getByTestId('android-agent-takeover')
  await expect(button).toHaveText('Take over')
  await button.click()
  await expect(page.getByTestId('android-agent-held')).toHaveText('You have it')
  await expect(button).toHaveText('Hand back to agents')
  await button.click()
  await expect(page.getByTestId('android-agent-held')).toHaveCount(0)
  expect(requests.filter(r => r.path.endsWith('/takeover')).map(r => r.body)).toEqual([{ held: true }, { held: false }])
  expect(errors).toEqual([])
})
