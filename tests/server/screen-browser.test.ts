import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserBroker } from '../../packages/desktop/src/main/browser/browser-broker'
import { ScreenBrowserManager } from '../../packages/server/src/modules/studio/services/screen-browser/manager'

/** A real headless Chromium (Playwright's) stands in for the agents' screen Chrome. */
function chromiumBinary(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('playwright').chromium.executablePath() as string
    if (path && existsSync(path)) return path
  } catch { /* look on disk */ }
  const root = '/opt/pw-browsers'
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const candidate = join(root, dir, sub, 'chrome')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const PAGE = `<!doctype html><html><head><title>Fixture</title></head><body>
<h1>Fixture page</h1>
<a href="/page2">Second page</a>
<label>Name <input id="name" aria-label="Name"></label>
<label>Fruit <select id="fruit" aria-label="Fruit"><option value="a">Apple</option><option value="b">Banana</option></select></label>
<button id="change" onclick="document.getElementById('out').textContent='Clicked ' + document.getElementById('name').value">Change text</button>
<button onclick="alert('Hello there'); document.getElementById('out').textContent='after alert'">Show alert</button>
<button onclick="fetch('/data.json').then(r => r.json()).then(d => { document.getElementById('out').textContent = 'data ' + d.ok })">Load data</button>
<button onclick="setTimeout(() => { document.getElementById('out').textContent = 'Later text' }, 400)">Delayed</button>
<button onclick="window.open('/popup')">Open popup</button>
<a href="/file.txt" download>Get file</a>
<label>Attachment <input type="file" id="file" aria-label="Attachment" onchange="document.getElementById('out').textContent='file ' + this.files[0].name + ' ' + this.files[0].size"></label>
<p id="out">Initial</p>
<script>document.getElementById('fruit').addEventListener('change', e => { document.getElementById('out').textContent = 'fruit ' + e.target.value })</script>
</body></html>`

describe('screen browser (Browser Broker over a real Chrome)', () => {
  const binary = chromiumBinary()
  let server: Server
  let base = ''
  let chrome: ChildProcess
  let profile = ''
  let brokerRoot = ''
  let manager: ScreenBrowserManager
  let broker: BrowserBroker
  let tabId = ''

  const call = async (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    (await broker.localRequest('test-client', { method, params })).result

  const ref = (snapshot: any, role: string, name: string): string => {
    const node = snapshot.nodes.find((item: any) => item.role === role && item.name.includes(name))
    if (!node) throw new Error(`No ${role} "${name}" in snapshot:\n${snapshot.text}`)
    return node.ref
  }

  const pageText = async (): Promise<string> => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    return snapshot.text as string
  }

  beforeAll(async () => {
    if (!binary) return
    server = createServer((request, response) => {
      const url = request.url || '/'
      if (url === '/') { response.setHeader('content-type', 'text/html'); response.end(PAGE); return }
      if (url === '/page2') { response.setHeader('content-type', 'text/html'); response.end('<title>Second</title><h1>Second page here</h1>'); return }
      if (url === '/popup') { response.setHeader('content-type', 'text/html'); response.end('<title>Popup</title><h1>Popup page</h1>'); return }
      if (url === '/data.json') { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); return }
      if (url === '/file.txt') {
        response.setHeader('content-type', 'text/plain')
        response.setHeader('content-disposition', 'attachment; filename="notes.txt"')
        response.end('downloaded text')
        return
      }
      response.statusCode = 404
      response.end('missing')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    profile = mkdtempSync(join(tmpdir(), 'screen-browser-profile-'))
    brokerRoot = mkdtempSync(join(tmpdir(), 'screen-browser-broker-'))
    chrome = spawn(binary, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox',
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,900', 'about:blank',
    ], { stdio: 'ignore' })
    const portFile = join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + 20_000
    while (!existsSync(portFile) || !readFileSync(portFile, 'utf8').trim()) {
      if (Date.now() > deadline) throw new Error('Chromium did not report its DevTools port')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0])
    manager = new ScreenBrowserManager({ port: async () => port })
    broker = new BrowserBroker(manager, brokerRoot)
    await broker.start()
  }, 40_000)

  afterAll(async () => {
    await broker?.stop()
    await manager?.destroy()
    chrome?.kill('SIGKILL')
    await new Promise(resolve => server?.close(resolve) ?? resolve(undefined))
    for (const dir of [profile, brokerRoot]) if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!binary)('publishes broker.json for local MCP processes, private to the user', () => {
    const file = join(brokerRoot, 'broker.json')
    const descriptor = JSON.parse(readFileSync(file, 'utf8'))
    expect(descriptor).toMatchObject({ schema: 1, desktopPid: process.pid })
    expect(descriptor.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  it.skipIf(!binary)('lists the Chrome page targets as tabs and opens a tab on a URL', async () => {
    const before = await call('state')
    expect(before.tabs.length).toBeGreaterThanOrEqual(1)
    const tab = await call('tabs.create', { url: `${base}/` })
    tabId = tab.id
    expect(tab.url).toBe(`${base}/`)
    expect(tab.title).toBe('Fixture')
    const state = await call('tabs.list')
    expect(state.tabs.map((item: any) => item.id)).toContain(tabId)
    expect(state.activeTabId).toBe(tabId)
  }, 30_000)

  it.skipIf(!binary)('types, then clicks by snapshot ref, and the page changes', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    expect(snapshot.snapshotId).toBeTruthy()
    const typed = await call('interact', { tab_id: tabId, action: { action: 'type', snapshot_id: snapshot.snapshotId, ref: ref(snapshot, 'textbox', 'Name'), text: 'Ada' } })
    expect(typed.snapshot.text).toContain('value="Ada"')
    const clicked = await call('interact', { tab_id: tabId, action: { action: 'click', snapshot_id: typed.snapshot.snapshotId, ref: ref(typed.snapshot, 'button', 'Change text') } })
    expect(clicked.observation.status).toBe('observed')
    expect(clicked.observation.changed).toBe(true)
    expect(clicked.observation.pointer).toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
    expect(clicked.snapshot.text).toContain('Clicked Ada')
  }, 30_000)

  it.skipIf(!binary)('selects an option of a native select', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    const result = await call('interact', { tab_id: tabId, action: { action: 'select', snapshot_id: snapshot.snapshotId, ref: ref(snapshot, 'combobox', 'Fruit'), value: 'Banana' } })
    expect(result.snapshot.text).toContain('fruit b')
  }, 30_000)

  it.skipIf(!binary)('runs a batch of actions against one snapshot', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    const result = await call('interact.batch', {
      tab_id: tabId, snapshot_id: snapshot.snapshotId, actions: [
        { action: 'type', ref: ref(snapshot, 'textbox', 'Name'), text: 'Grace' },
        { action: 'click', ref: ref(snapshot, 'button', 'Change text') },
      ],
    })
    expect(result.completed).toBe(2)
    expect(result.results.map((item: any) => item.status)).toEqual(['completed', 'completed'])
    expect(result.snapshot.text).toContain('Clicked Grace')
  }, 30_000)

  it.skipIf(!binary)('waits for text that appears later', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    await call('interact', { tab_id: tabId, action: { action: 'click', snapshot_id: snapshot.snapshotId, ref: ref(snapshot, 'button', 'Delayed') } })
    const waited = await call('wait', { tab_id: tabId, text: 'Later text', timeout_ms: 5_000 })
    expect(waited.matched).toBe(true)
  }, 30_000)

  it.skipIf(!binary)('reports an alert as a dialog and accepts it', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    const clicked = await call('interact', { tab_id: tabId, action: { action: 'click', snapshot_id: snapshot.snapshotId, ref: ref(snapshot, 'button', 'Show alert') } })
    expect(clicked.observation.dialog).toMatchObject({ type: 'alert', message: 'Hello there' })
    expect((await call('dialog', { tab_id: tabId })).dialog).toMatchObject({ type: 'alert' })
    const handled = await call('dialog', { tab_id: tabId, action: 'accept' })
    expect(handled.dialog.type).toBe('alert')
    expect((await call('dialog', { tab_id: tabId })).dialog).toBeNull()
    expect(await pageText()).toContain('after alert')
  }, 30_000)

  it.skipIf(!binary)('logs the requests the page makes', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    await call('interact', { tab_id: tabId, action: { action: 'click', snapshot_id: snapshot.snapshotId, ref: ref(snapshot, 'button', 'Load data') } })
    await call('wait', { tab_id: tabId, text: 'data true', timeout_ms: 5_000 })
    const network = await call('network.read', { tab_id: tabId, filter: 'data.json' })
    expect(network.total).toBeGreaterThanOrEqual(1)
    expect(network.entries.at(-1)).toMatchObject({ method: 'GET', url: `${base}/data.json`, status: 200 })
  }, 30_000)

  it.skipIf(!binary)('captures console messages', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    const textbox = ref(snapshot, 'textbox', 'Name')
    await call('interact', { tab_id: tabId, action: { action: 'type', snapshot_id: snapshot.snapshotId, ref: textbox, text: 'x' } })
    await broker.localRequest('test-client', { method: 'console.clear', params: { tab_id: tabId } })
    // Console output from the page itself (the screen's tab is attached, Runtime is enabled).
    const manager2 = manager as any
    const record = manager2.records.get(tabId)
    await record.contents.send('Runtime.evaluate', { expression: "console.warn('careful now')" })
    await new Promise(resolve => setTimeout(resolve, 200))
    const entries = await call('console.read', { tab_id: tabId })
    expect(entries.some((entry: any) => entry.level === 2 && entry.message === 'careful now')).toBe(true)
  }, 30_000)

  it.skipIf(!binary)('uploads a file to a file input', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    const result = await call('upload', {
      tab_id: tabId, snapshot_id: snapshot.snapshotId, ref: ref(snapshot, 'button', 'Attachment'),
      files: [{ name: 'hello.txt', type: 'text/plain', data: Buffer.from('hello world').toString('base64') }],
    })
    expect(result.upload.files).toEqual([{ name: 'hello.txt', type: 'text/plain', size: 11 }])
    expect(result.snapshot.text).toContain('file hello.txt 11')
  }, 30_000)

  it.skipIf(!binary)('downloads a linked file in chunks', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    const info = await call('download.start', { tab_id: tabId, snapshot_id: snapshot.snapshotId, ref: ref(snapshot, 'link', 'Get file') })
    expect(info).toMatchObject({ fileName: 'notes.txt', mimeType: 'text/plain', size: 15 })
    const chunk = await call('download.read', { download_id: info.downloadId })
    expect(Buffer.from(chunk.data, 'base64').toString()).toBe('downloaded text')
    expect(chunk.done).toBe(true)
  }, 30_000)

  it.skipIf(!binary)('takes a screenshot', async () => {
    const shot = await call('screenshot', { tab_id: tabId })
    expect(shot.mediaType).toBe('image/png')
    expect(shot.width).toBeGreaterThan(100)
    expect(Buffer.from(shot.data, 'base64').subarray(1, 4).toString()).toBe('PNG')
  }, 30_000)

  it.skipIf(!binary)('shows a tab the page opens, with the opener reported', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    const result = await call('interact', { tab_id: tabId, action: { action: 'click', snapshot_id: snapshot.snapshotId, ref: ref(snapshot, 'button', 'Open popup') } })
    expect(result.observation.openedTabs?.[0]?.url).toBe(`${base}/popup`)
    const state = await call('state')
    const popup = state.tabs.find((tab: any) => tab.url === `${base}/popup`)
    expect(popup).toBeTruthy()
    expect(popup.title).toBe('Popup')
    await call('tabs.close', { tab_id: popup.id })
    expect((await call('state')).tabs.some((tab: any) => tab.id === popup.id)).toBe(false)
  }, 30_000)

  it.skipIf(!binary)('follows links, then goes back', async () => {
    const snapshot = await call('snapshot', { tab_id: tabId })
    const clicked = await call('interact', { tab_id: tabId, action: { action: 'click', snapshot_id: snapshot.snapshotId, ref: ref(snapshot, 'link', 'Second page') } })
    expect(clicked.observation.navigation).toBe('new_document')
    expect(clicked.snapshot.text).toContain('Second page here')
    // A snapshot from the old document is stale after navigating.
    await expect(call('interact', { tab_id: tabId, action: { action: 'click', snapshot_id: snapshot.snapshotId, ref: '@e1' } })).rejects.toThrow(/stale/)
    const back = await call('navigation.action', { tab_id: tabId, action: 'back' })
    expect(back.id).toBe(tabId)
    await call('wait', { tab_id: tabId, text: 'Fixture page', timeout_ms: 5_000 })
    const navigated = await call('navigate', { tab_id: tabId, url: `${base}/page2` })
    expect(navigated.url).toBe(`${base}/page2`)
    expect(navigated.canGoBack).toBe(true)
    await call('lease.release', { tab_id: tabId })
  }, 30_000)
})

describe('screen browser service', () => {
  it('fails clearly while a person holds the screen, and starts a stopped screen', async () => {
    const { screenBrowserPort, SCREEN_TAKEN_OVER } = await import('../../packages/server/src/modules/studio/services/screen-browser')
    const held = { browserPort: async () => { throw Object.assign(new Error('x'), { exitCode: 42 }) } }
    await expect(screenBrowserPort(held as any)).rejects.toThrow(SCREEN_TAKEN_OVER)
    let started = false
    const stopped = {
      browserPort: async () => {
        if (!started) throw Object.assign(new Error('The screen is not running'), { exitCode: 41 })
        return { port: 9222, profile: '/p' }
      },
      hermesStatus: async () => ({ installed: true }),
      start: async () => { started = true },
    }
    await expect(screenBrowserPort(stopped as any)).resolves.toBe(9222)
    const missing = { ...stopped, hermesStatus: async () => ({ installed: false }) }
    started = false
    await expect(screenBrowserPort(missing as any)).rejects.toThrow(/not installed/)
  })

  it("leaves a live Desktop app's broker.json alone but still serves relayed requests", async () => {
    const { ScreenBrowserService } = await import('../../packages/server/src/modules/studio/services/screen-browser')
    const root = mkdtempSync(join(tmpdir(), 'screen-browser-desktop-'))
    const desktop = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    try {
      const { writeFileSync } = await import('node:fs')
      const descriptor = JSON.stringify({ schema: 1, desktopPid: desktop.pid, endpoint: 'http://127.0.0.1:1/v1', token: 't' })
      writeFileSync(join(root, 'broker.json'), descriptor)
      const service = new ScreenBrowserService({
        brokerRoot: root, installed: async () => true,
        port: async () => { throw new Error('A person has taken over the screen; wait until they hand it back') },
      })
      expect(await service.start()).toBe(true)
      expect(readFileSync(join(root, 'broker.json'), 'utf8')).toBe(descriptor)
      await expect(service.request('run-1', { method: 'state', params: {} })).rejects.toThrow(/taken over the screen/)
      await expect(service.request('run-1', { method: 'bogus' })).rejects.toThrow(/Unsupported/)
      await service.stop()
      expect(readFileSync(join(root, 'broker.json'), 'utf8')).toBe(descriptor)
    } finally {
      desktop.kill()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
