import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadlessBrowserService } from '../../packages/server/src/modules/studio/services/headless-browser-service'
import { BrowserScreencast, type LiveFrame } from '../../packages/server/src/modules/studio/services/browser-live/screencast'

// The Browser panel's live view: Chrome's screencast of the active tab,
// shared by every panel watching it, stopped with the last watcher.
let panel: HeadlessBrowserService | null = null
let server: Server | null = null
const dirs: string[] = []
afterAll(async () => {
  await panel?.stop().catch(() => {})
  server?.close()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function nextFrame(frames: LiveFrame[], after: number, timeout = 5000): Promise<LiveFrame> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (frames.length > after) return resolve(frames[frames.length - 1])
      if (Date.now() - started > timeout) return reject(new Error('no frame'))
      setTimeout(check, 20)
    }
    check()
  })
}

describe('TestBrowserLive_screencast', () => {
  it('streams frames when the page changes, shares them, and stops with the last watcher', async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<title>Live</title><button id="b" style="width:300px;height:100px" onclick="document.body.style.background=\'red\'">Go</button>')
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const origin = `http://127.0.0.1:${(server.address() as any).port}`

    const dir = await mkdtemp(join(tmpdir(), 'live-')); dirs.push(dir)
    panel = new HeadlessBrowserService({ brokerRoot: dir })
    try { await panel.start() } catch (error) { console.warn('No Chromium here, skipping:', error); return }
    const tab = panel.tabs.get(panel.activeTabId!)!
    await tab.page.goto(origin)

    const cast = new BrowserScreencast(id => panel!.tabs.get(id)?.page ?? null, { maxFps: 30 })
    const first: LiveFrame[] = []
    const stopFirst = await cast.watch(tab.id, frame => first.push(frame))
    const frame = await nextFrame(first, 0)
    expect(frame.tabId).toBe(tab.id)
    expect(frame.data.subarray(0, 2).toString('hex')).toBe('ffd8') // JPEG
    expect(frame.width).toBeGreaterThan(0)

    // A second panel gets the last frame at once and shares the stream.
    const second: LiveFrame[] = []
    const stopSecond = await cast.watch(tab.id, f => second.push(f))
    expect(second.length).toBe(1)
    expect(cast.watchedTabs()).toEqual([tab.id])

    // A change on the page arrives as a new frame, fast.
    const before = first.length
    const clickedAt = Date.now()
    await tab.page.click('#b')
    await nextFrame(first, before)
    expect(Date.now() - clickedAt).toBeLessThan(2000)
    await nextFrame(second, 1)

    stopFirst()
    expect(cast.watchedTabs()).toEqual([tab.id])
    stopSecond()
    expect(cast.watchedTabs()).toEqual([])

    await expect(cast.watch('missing', () => {})).rejects.toThrow('Tab not found')

    // Closing the tab tells its watchers; a watcher that left is not told.
    const page = await tab.page.context().newPage()
    await page.goto(origin)
    const ended: string[] = []
    const castFor = new BrowserScreencast(id => (id === 'closing' ? page : null))
    const leave = await castFor.watch('closing', () => {}, () => ended.push('left'))
    leave()
    await castFor.watch('closing', () => {}, () => ended.push('stayed'))
    await page.close()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(ended).toEqual(['stayed'])
    expect(castFor.watchedTabs()).toEqual([])
    await cast.stopAll()
  }, 60_000)
})
