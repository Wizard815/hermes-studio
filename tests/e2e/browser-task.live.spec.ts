import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadlessBrowserService } from '../../packages/server/src/modules/studio/services/headless-browser-service'
import { BrowserTaskRunner } from '../../packages/server/src/modules/studio/services/browser-task/service'

// Live: the browser panel's task bar runs a real browser-use task with a real model, on a
// real panel browser, and a pin comment on the page it leaves goes to the chat. The
// /api/studio/browser/* answers come from that browser (HeadlessBrowserService) and the
// runner; the rest of the app is stood in. docs/browser-tasks.md
//   LIVE_BROWSER_TASK=1 BROWSER_USE_PYTHON=... LIVE_BROWSER_TASK_KEY=... npx playwright test tests/e2e/browser-task.live.spec.ts
const live = process.env.LIVE_BROWSER_TASK === '1'
const BASE_URL = process.env.LIVE_BROWSER_TASK_BASE_URL || 'https://openrouter.ai/api/v1'
const MODEL = process.env.LIVE_BROWSER_TASK_MODEL || 'anthropic/claude-haiku-5.5'
const MODEL_ID = `${process.env.LIVE_BROWSER_TASK_PROVIDER || 'openrouter'}/${MODEL}`
const shotDir = process.env.BROWSER_TASK_SHOTS || ''
const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const session = { id: 'chat-1', title: 'Browser tasks', profile: 'default', source: 'web', agent: 'hermes', model: 'fixture-model', started_at: 1, last_active: 1, message_count: 1 }
const history = [{ id: 1, role: 'assistant', content: 'The browser panel is on the right.', timestamp: 1 }]

// BROWSER_TASK_VIDEO=1 records the whole run (Playwright's video, in the test's output folder).
test.use({ video: process.env.BROWSER_TASK_VIDEO === '1' ? { mode: 'on', size: { width: 1500, height: 940 } } : 'retain-on-failure' })

async function shot(page: Page, name: string) {
  await page.screenshot({ path: shotDir ? join(shotDir, name) : test.info().outputPath(name) })
}

test.describe(() => {
  test.skip(!live, 'set LIVE_BROWSER_TASK=1')
  test('Browser tasks: run a task in the panel browser, watch it, and pin a comment on the result', async ({ page }) => {
    test.setTimeout(420_000)
    const service = new HeadlessBrowserService({ brokerRoot: mkdtempSync(join(tmpdir(), 'browser-task-ui-')) })
    await service.start()
    const sockets: Array<(event: string, data: unknown) => void> = []
    const runner = new BrowserTaskRunner({
      cdpUrl: () => service.cdpUrl(),
      setFollowTabs: on => { service.followNewTabs = on },
      resolveModel: async id => ({ id, model: MODEL, baseUrl: BASE_URL, apiKey: process.env.LIVE_BROWSER_TASK_KEY || '' }),
      onUpdate: task => {
        if (process.env.BROWSER_TASK_DEBUG === '1') console.log('[update]', task.status, task.steps.length, task.error || '', sockets.length)
        sockets.forEach(send => send('browser.task', { id: task.id, status: task.status, steps: task.steps.length }))
      },
    })
    const frames: string[] = []
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
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
          frames.push(value)
          const start = value.indexOf('['), [event, data] = JSON.parse(value.slice(start))
          if (event === 'resume') ws.send(value.slice(0, start) + JSON.stringify(['resumed', { session_id: data.session_id, messages: history, isWorking: false, queueLength: 0, events: [], workspace: '/srv', model: 'fixture-model' }]))
        })
      })
      await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
        const url = new URL(route.request().url())
        const path = url.pathname
        const body = (() => { try { return JSON.parse(route.request().postData() || '{}') } catch { return {} } })()
        const tab = () => service.getTab(body.tab_id) || service.getActiveTab()
        let json: unknown = {}
        // The panel browser and the task runner, for real.
        if (path === '/api/studio/browser/status') json = { available: true }
        else if (path === '/api/studio/browser/state') json = await service.getState()
        else if (path === '/api/studio/browser/screenshot') json = { data: await service.captureScreenshot(tab()!.id), mimeType: 'image/jpeg', tabId: tab()!.id }
        else if (path === '/api/studio/browser/viewport') json = await service.getViewportInfo(tab()!.id)
        else if (path === '/api/studio/browser/element-at') json = { element: await service.elementAt(tab()!.id, body.x, body.y) }
        else if (path === '/api/studio/browser/screenshots') json = { screenshots: [] }
        else if (path === '/api/studio/browser/task' && route.request().method() === 'GET') json = { available: true, version: '1.0.4', task: runner.state() }
        else if (path === '/api/studio/browser/task') json = await runner.start({ task: body.task, model: body.model, maxSteps: 12, timeout: 300 })
        else if (path === '/api/studio/browser/task/stop') json = { task: runner.stop() }
        else if (path === '/api/studio/browser/task/models') json = { models: [{ id: MODEL_ID, provider: 'openrouter', model: MODEL }, { id: 'argos/gemma-4-31b', provider: 'argos', model: 'gemma-4-31b' }], default: MODEL_ID }
        // The rest of Studio, stood in.
        else if (path === '/health') json = { status: 'ok' }
        else if (path === '/api/studio/uploads') {
          const names = [...(route.request().postData() || '').matchAll(/filename="([^"]+)"/g)].map(match => match[1])
          json = { files: names.map(name => ({ name, path: `/srv/uploads/${name}` })) }
        }
        else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
        else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
        else if (path === '/api/hermes/available-models') {
          const groups = [{ provider: 'fixture', label: 'Fixture', base_url: '', api_key: 'fixture', models: ['fixture-model'] }]
          json = { groups, allProviders: groups, profiles: [], default: 'fixture-model', default_provider: 'fixture' }
        }
        else if (path === '/api/studio/projects') json = { projects: [] }
        else if (path.startsWith('/api/studio/projects/for-session/')) json = { project: null }
        else if (path === '/api/studio/sessions') json = { sessions: url.searchParams.get('source') === 'global_agent' ? [] : [session] }
        else if (path === '/api/studio/session-categories') json = { categories: [] }
        else if (path.endsWith('/messages/paginated')) json = { session, messages: history, total: 1, offset: 0, limit: 150, hasMore: false, taskPlans: [], workspaceRunChanges: [] }
        else if (path.startsWith('/api/studio/sessions/')) json = { session: { ...session, messages: history } }
        await route.fulfill({ json })
      })

      await page.goto('/#/hermes/session/chat-1')
      await page.locator('.header-tool-toggle').click()
      await page.getByRole('tab', { name: 'Browser' }).click()
      const bar = page.getByTestId('browser-task')
      await expect(bar).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('browser-task-model')).toContainText(MODEL)

      await page.getByTestId('browser-task-input').locator('input').fill('Open https://example.com, click its "Learn more" link, and answer with the title of the page you land on.')
      await page.getByTestId('browser-task-run').click()
      await expect(page.getByTestId('browser-task-stop')).toBeVisible()
      await expect(page.locator('.browser-task-steps li').first()).toBeVisible({ timeout: 60_000 })
      await shot(page, 'browser-task-running.png')

      const result = page.getByTestId('browser-task-result')
      await expect(result).toBeVisible({ timeout: 320_000 })
      await expect(result).toContainText(/Example Domains/i)
      await expect(page.locator('.browser-task-badge')).toHaveText('Done')
      // The panel followed the task to the page it left.
      await expect(page.locator('.browser-url-input input')).toHaveValue(/iana\.org/, { timeout: 15_000 })
      await expect(page.locator('.browser-screenshot-image')).toBeVisible()
      await shot(page, 'browser-task-done.png')

      // A pin comment on that page goes to the chat, naming the element under the pin.
      await page.getByTestId('browser-pin-comment').click()
      const view = (await page.locator('.browser-screenshot-image').boundingBox())!
      await page.mouse.click(view.x + view.width * 0.3, view.y + view.height * 0.3)
      const popover = page.getByTestId('pin-comment-popover')
      await expect(popover).toBeVisible()
      await popover.locator('textarea').fill('What does this section say?')
      await shot(page, 'browser-task-pin.png')
      await popover.getByTestId('pin-comment-send').click()
      await expect.poll(() => frames.some(frame => frame.includes('Comment on https://www.iana.org/help/example-domains') && frame.includes('What does this section say?')), { timeout: 15_000 }).toBe(true)
      const sent = frames.find(frame => frame.includes('Comment on https://www.iana.org'))!
      expect(sent).toMatch(/element under the pin|<(main|div|p|h1|article)/i)
      console.log('[live] task', JSON.stringify({ ...runner.state(), steps: runner.state()?.steps.map(s => s.text) }))
      // A finished task's card clears.
      await page.getByTestId('browser-task-clear').click()
      await expect(page.getByTestId('browser-task-log')).toBeHidden()
      expect(errors).toEqual([])
    } finally {
      runner.stop()
      await service.stop()
    }
  })
})
