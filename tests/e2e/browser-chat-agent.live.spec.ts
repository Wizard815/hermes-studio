import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { HeadlessBrowserService } from '../../packages/server/src/modules/studio/services/headless-browser-service'
import { ScreenBrowserService } from '../../packages/server/src/modules/studio/services/screen-browser'

// Live: ONE model (the chat's) drives the Browser panel with Studio's own browser
// tools, and the panel follows it. Real pieces: the panel's browser
// (HeadlessBrowserService), the Browser Broker the tools reach (ScreenBrowserService
// on the panel's browser, as when the Screen is not installed), the browser MCP
// (bin/ekko-studio-mcp.mjs browser) and a real model calling its tools. The chat run
// itself is stood in: this test plays the agent loop. docs/browser-panel.md
//   LIVE_BROWSER_CHAT=1 LIVE_BROWSER_CHAT_KEY=... npx playwright test tests/e2e/browser-chat-agent.live.spec.ts
// BROWSER_CHAT_VIDEO=1 records the run; BROWSER_CHAT_SHOTS=<dir> keeps screenshots.
const live = process.env.LIVE_BROWSER_CHAT === '1'
const BASE_URL = process.env.LIVE_BROWSER_CHAT_BASE_URL || 'https://openrouter.ai/api/v1'
const MODEL = process.env.LIVE_BROWSER_CHAT_MODEL || 'anthropic/claude-haiku-5.5'
const ASK = 'Open https://example.com in the browser, click its "Learn more" link, and tell me the title of the page you land on.'
const shotDir = process.env.BROWSER_CHAT_SHOTS || ''
const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const session = { id: 'chat-1', title: 'One model, one browser', profile: 'default', source: 'web', agent: 'hermes', model: MODEL, started_at: 1, last_active: 1, message_count: 1 }

test.use({ video: process.env.BROWSER_CHAT_VIDEO === '1' ? { mode: 'on', size: { width: 1500, height: 940 } } : 'retain-on-failure' })

async function shot(page: Page, name: string) {
  await page.screenshot({ path: shotDir ? join(shotDir, name) : test.info().outputPath(name) })
}

/** The smallest MCP stdio client: newline-delimited JSON-RPC. */
class McpClient {
  private next = 1
  private waiting = new Map<number, (message: any) => void>()
  constructor(private readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', line => {
      let message: any
      try { message = JSON.parse(line) } catch { return }
      if (message.id != null && this.waiting.has(message.id)) {
        this.waiting.get(message.id)!(message)
        this.waiting.delete(message.id)
      }
    })
  }
  call(method: string, params: unknown = {}): Promise<any> {
    const id = this.next++
    return new Promise((done, fail) => {
      this.waiting.set(id, message => message.error ? fail(new Error(message.error.message)) : done(message.result))
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  notify(method: string) { this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') }
}

test.describe(() => {
  test.skip(!live, 'set LIVE_BROWSER_CHAT=1')
  test('One model: the chat model drives the Browser panel with its own browser tools', async ({ page }) => {
    test.setTimeout(300_000)
    const home = mkdtempSync(join(tmpdir(), 'browser-chat-'))
    mkdirSync(join(home, 'desktop-browser'), { mode: 0o700 })
    const panel = new HeadlessBrowserService({ brokerRoot: join(home, 'panel') })
    const tools = new ScreenBrowserService({ brokerRoot: join(home, 'desktop-browser'), installed: async () => false })
    let mcp: ChildProcess | null = null
    const sockets: Array<(event: string, data: unknown) => void> = []
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await panel.start()
      panel.setOnChange(tabId => sockets.forEach(send => send('browser.changed', { tabId })))
      tools.usePanelBrowser(() => panel.devToolsPort())
      expect(await tools.start()).toBe(true)

      // The panel in the chat.
      const history = [{ id: 1, role: 'user', content: ASK, timestamp: 1 }]
      await page.setViewportSize({ width: 1500, height: 940 })
      await page.addInitScript(tok => {
        localStorage.setItem('hermes_locale', 'en')
        localStorage.setItem('hermes_active_profile_name', 'default')
        localStorage.setItem('hermes_api_key', tok)
      }, token)
      await page.routeWebSocket('**/socket.io/**', ws => {
        ws.send('0' + JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 60000, pingTimeout: 60000 }))
        sockets.push((event, data) => { try { ws.send('42' + JSON.stringify([event, data])) } catch { /* closed */ } })
        ws.onMessage(raw => {
          const value = String(raw)
          if (value.startsWith('40')) ws.send(value.split(',')[0] + ',' + JSON.stringify({ sid: 'fixture' }))
          if (!value.startsWith('42')) return
          const start = value.indexOf('['), [event, data] = JSON.parse(value.slice(start))
          if (event === 'resume') ws.send(value.slice(0, start) + JSON.stringify(['resumed', { session_id: data.session_id, messages: history, isWorking: true, queueLength: 0, events: [], workspace: '/srv', model: MODEL }]))
        })
      })
      await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
        const url = new URL(route.request().url())
        const path = url.pathname
        const body = (() => { try { return JSON.parse(route.request().postData() || '{}') } catch { return {} } })()
        const tab = () => panel.getTab(body.tab_id) || panel.getActiveTab()
        let json: unknown = {}
        if (path === '/api/studio/browser/status') json = { available: true }
        else if (path === '/api/studio/browser/state') json = await panel.getState()
        else if (path === '/api/studio/browser/screenshot') json = { data: await panel.captureScreenshot(tab()!.id, false, { broadcast: false }), mimeType: 'image/jpeg', tabId: tab()!.id }
        else if (path === '/api/studio/browser/viewport') json = await panel.getViewportInfo(tab()!.id)
        else if (path === '/api/studio/browser/screenshots') json = { screenshots: [] }
        else if (path === '/health') json = { status: 'ok' }
        else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
        else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
        else if (path === '/api/hermes/available-models') {
          const groups = [{ provider: 'openrouter', label: 'OpenRouter', base_url: BASE_URL, api_key: 'x', models: [MODEL] }]
          json = { groups, allProviders: groups, profiles: [], default: MODEL, default_provider: 'openrouter' }
        }
        else if (path === '/api/studio/projects') json = { projects: [] }
        else if (path.startsWith('/api/studio/projects/for-session/')) json = { project: null }
        else if (path === '/api/studio/sessions') json = { sessions: url.searchParams.get('source') === 'global_agent' ? [] : [session] }
        else if (path === '/api/studio/session-categories') json = { categories: [] }
        else if (path.endsWith('/messages/paginated')) json = { session, messages: history, total: history.length, offset: 0, limit: 150, hasMore: false, taskPlans: [], workspaceRunChanges: [] }
        else if (path.startsWith('/api/studio/sessions/')) json = { session: { ...session, messages: history } }
        await route.fulfill({ json })
      })
      await page.goto('/#/hermes/session/chat-1')
      await page.locator('.header-tool-toggle').click()
      await page.getByRole('tab', { name: 'Browser' }).click()
      await expect(page.locator('.browser-url-input')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('browser-task')).toHaveCount(0) // no second model, no task bar

      // The chat's model, with Studio's browser tools.
      mcp = spawn(process.execPath, [resolve('bin/ekko-studio-mcp.mjs'), 'browser'], {
        env: { ...process.env, HERMES_WEB_UI_HOME: home, HERMES_MCP_TOOLSET: 'browser' },
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      const client = new McpClient(mcp)
      await client.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chat', version: '1' } })
      client.notify('notifications/initialized')
      const { tools: catalog } = await client.call('tools/list')
      // Exactly what the chat agent is given: the compact browser toolset (list, describe, call).
      const functions = catalog.map((tool: any) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
      expect(catalog.map((tool: any) => tool.name)).toContain('ekko_studio_browser_toolset')

      const messages: any[] = [
        { role: 'system', content: 'You are Hermes, the chat agent in Hermes Studio. The browser tools drive the Browser panel the person is watching. Use them, then answer in one short sentence.' },
        { role: 'user', content: ASK },
      ]
      let answer = ''
      const calls: string[] = []
      for (let turn = 0; turn < 16 && !answer; turn++) {
        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LIVE_BROWSER_CHAT_KEY || 'none'}` },
          body: JSON.stringify({ model: MODEL, messages, tools: functions, max_tokens: 800 }),
        })
        expect(response.ok, await response.clone().text()).toBe(true)
        const message = (await response.json()).choices[0].message
        messages.push(message)
        if (!message.tool_calls?.length) { answer = String(message.content || ''); break }
        for (const call of message.tool_calls) {
          calls.push(`${call.function.name} ${call.function.arguments}`)
          const result = await client.call('tools/call', { name: call.function.name, arguments: JSON.parse(call.function.arguments || '{}') })
          const text = (result.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
          messages.push({ role: 'tool', tool_call_id: call.id, content: text.slice(0, 12_000) })
        }
        if (turn === 1) await shot(page, 'browser-chat-working.png')
      }
      console.log('[live] tool calls\n' + calls.join('\n'))
      console.log('[live] answer:', answer)
      expect(answer).toMatch(/Example Domains/i)

      // The panel shows where the chat's model went, with no second model involved.
      await expect(page.locator('.browser-url-input input')).toHaveValue(/iana\.org/, { timeout: 15_000 })
      await expect(page.locator('.browser-screenshot-image')).toBeVisible()
      await page.waitForTimeout(1500)
      await shot(page, 'browser-chat-done.png')
      expect(errors).toEqual([])
    } finally {
      mcp?.kill()
      await tools.stop()
      await panel.stop()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
