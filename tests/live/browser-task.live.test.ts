import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTaskRunner } from '../../packages/server/src/modules/studio/services/browser-task/service'
import { HeadlessBrowserService } from '../../packages/server/src/modules/studio/services/headless-browser-service'

// Live check of browser tasks (docs/browser-tasks.md): real browser-use on the panel's own
// browser, with a real model. Run with:
//   LIVE_BROWSER_TASK=1 BROWSER_USE_PYTHON=/path/to/venv/bin/python \
//   LIVE_BROWSER_TASK_BASE_URL=https://openrouter.ai/api/v1 LIVE_BROWSER_TASK_MODEL=anthropic/claude-haiku-5.5 \
//   LIVE_BROWSER_TASK_KEY=... npx vitest run tests/live/browser-task.live.test.ts
// For Argos (llama.cpp): LIVE_BROWSER_TASK_BASE_URL=http://argos:8080/v1 and an Argos model name.
const live = process.env.LIVE_BROWSER_TASK === '1'
const BASE_URL = process.env.LIVE_BROWSER_TASK_BASE_URL || 'https://openrouter.ai/api/v1'
const MODEL = process.env.LIVE_BROWSER_TASK_MODEL || 'anthropic/claude-haiku-5.5'
const BUDGET_USD = Number(process.env.LIVE_BUDGET_USD || '0.25')

let dir = ''
let service: HeadlessBrowserService | null = null
afterAll(async () => {
  await service?.stop().catch(() => {})
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!live)('TestBrowserTask_live', () => {
  it('does a task in the panel browser, the panel follows it, and pin comments read the page it left', async () => {
    dir = await mkdtemp(join(tmpdir(), 'browser-task-live-'))
    service = new HeadlessBrowserService({ brokerRoot: dir })
    await service.start()
    const updates: string[] = []
    const runner = new BrowserTaskRunner({
      cdpUrl: () => service!.cdpUrl(),
      setFollowTabs: on => { service!.followNewTabs = on },
      resolveModel: async id => ({ id, model: MODEL, baseUrl: BASE_URL, apiKey: process.env.LIVE_BROWSER_TASK_KEY || '' }),
      onUpdate: state => updates.push(`${state.status}:${state.steps.length}`),
    })
    await runner.start({
      task: 'Open https://example.com, click its "Learn more" link, and answer with the title of the page you land on.',
      model: `live/${MODEL}`,
      maxSteps: 12,
      timeout: 300,
    })
    const end = Date.now() + 320_000
    while (runner.running() && Date.now() < end) await new Promise(r => setTimeout(r, 500))
    const state = runner.state()!
    console.log('[live] browser task', JSON.stringify({ ...state, steps: state.steps.map(s => s.text) }, null, 1))
    expect(state.status).toBe('completed')
    expect(state.steps.length).toBeGreaterThan(0)
    expect(state.result || '').toMatch(/IANA|Example Domains|Reserved/i)
    if (typeof state.costUsd === 'number') expect(state.costUsd).toBeLessThan(BUDGET_USD)
    // The panel shows the page the task left, in a tab it knows.
    const urls = service.getAllTabs().map(tab => tab.page.url())
    console.log('[live] panel tabs', urls, 'active', service.getActiveTab()?.page.url())
    expect(urls.some(url => /iana\.org/.test(url))).toBe(true)
    const tab = service.getAllTabs().find(t => /iana\.org/.test(t.page.url()))!
    // A pin comment on it names an element there.
    const element = await service.elementAt(tab.id, 0.5, 0.3)
    console.log('[live] element under the pin', element)
    expect(element?.tag).toBeTruthy()
    expect(updates.length).toBeGreaterThan(1)
  }, 360_000)
})
