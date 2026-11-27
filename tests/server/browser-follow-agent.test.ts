import { afterAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadlessBrowserService } from '../../packages/server/src/modules/studio/services/headless-browser-service'

// One browser for the chat's model and the Browser panel (docs/browser-panel.md):
// without the Screen, the chat's browser tools (bin/ekko-studio-mcp.mjs, toolset
// "browser", relayed to ScreenBrowserService) drive the panel's own browser. The
// panel shows the tabs they open and repaints on every change.
let panel: HeadlessBrowserService | null = null
let tools: { stop(): Promise<void> } | null = null
let server: Server | null = null
const dirs: string[] = []
afterAll(async () => {
  await tools?.stop().catch(() => {})
  await panel?.stop().catch(() => {})
  server?.close()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

describe('TestBrowser_oneBrowserForChatAndPanel', () => {
  it("the chat's browser tools drive the panel's browser, and the panel follows them", async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      if (req.url === '/next') return res.end('<title>Next page</title><h1>Next</h1>')
      res.end('<title>Start</title><a href="/next" style="display:block;width:300px;height:100px">Open next</a>')
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const origin = `http://127.0.0.1:${(server.address() as any).port}`

    const panelDir = await mkdtemp(join(tmpdir(), 'panel-')); dirs.push(panelDir)
    panel = new HeadlessBrowserService({ brokerRoot: panelDir })
    try { await panel.start() } catch (error) { console.warn('No Chromium here, skipping:', error); return }
    expect(panel.devToolsPort()).toBeGreaterThan(0)
    const changes: Array<string | null> = []
    panel.setOnChange(tabId => changes.push(tabId))

    // The Screen is not installed: the tools' broker drives the panel's browser.
    const { ScreenBrowserService } = await import('../../packages/server/src/modules/studio/services/screen-browser')
    const brokerDir = await mkdtemp(join(tmpdir(), 'tools-')); dirs.push(brokerDir)
    const service = new ScreenBrowserService({ brokerRoot: brokerDir, installed: async () => false })
    tools = service
    expect(await service.start()).toBe(false)
    service.usePanelBrowser(() => panel!.devToolsPort())
    expect(await service.start()).toBe(true)

    // The chat's model opens a page: it becomes the panel's tab, with its address and title.
    const opened = await service.request('run-1', { method: 'tabs.create', params: { url: `${origin}/` } }) as any
    expect(opened.result).toBeTruthy()
    await vi.waitFor(async () => {
      const state = await panel!.getState()
      expect(state.tabs.find(tab => tab.id === state.activeTabId)).toMatchObject({ url: `${origin}/`, title: 'Start' })
    }, { timeout: 15_000 })
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0))

    // It navigates: the panel's tab follows.
    const tabs = (await service.request('run-1', { method: 'tabs.list', params: {} }) as any).result
    const tabId = (tabs.tabs || tabs).find((tab: any) => String(tab.url).startsWith(origin)).id
    const before = changes.length
    await service.request('run-1', { method: 'navigate', params: { tab_id: tabId, url: `${origin}/next` } })
    await vi.waitFor(async () => {
      const state = await panel!.getState()
      expect(state.tabs.find(tab => tab.id === state.activeTabId)).toMatchObject({ url: `${origin}/next`, title: 'Next page' })
    }, { timeout: 15_000 })
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(before))

    // A tab Studio opens itself in the background stays in the background.
    const active = (await panel.getState()).activeTabId
    await panel.executeMethod('tabs.create', { url: null, activate: false })
    expect((await panel.getState()).activeTabId).toBe(active)
  }, 90_000)
})
