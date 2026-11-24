import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * Mission's tools docked on Studio's herdr page (HerdrCenter + HerdrMissionDock)
 * against mocked Studio + Orb APIs, and Mission's old address sending you there.
 */
const STATUS = {
  settings: { enabled: true, autoStart: true, setupVersion: '0.9.5', binaryPath: '', session: '', autoImport: true, mirrorTranscripts: true, profile: 'default' },
  installed: true, binary: '/usr/local/bin/herdr', version: '0.9.5', home: '/home/me', error: '',
  server: { version: '0.9.5', running: true, socket: '/tmp/herdr.sock', session: 'default', compatible: true },
  bridge: {
    connected: true, error: '', version: '0.9.5', focusedPaneId: 'w1:p1',
    workspaces: [
      { workspace_id: 'w1', label: 'api', agent_status: 'blocked', cwd: '/home/me/code/client-acme/api' },
      { workspace_id: 'w2', label: 'site', agent_status: 'done', cwd: '/home/me/code/site' },
    ],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'blocked', label: 'auth refactor', cwd: '/home/me/code/client-acme/api', studioAgent: 'claude-code', studioSessionId: 'herdr-aaa' },
      { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'done', label: 'docs', cwd: '/home/me/code/site', studioAgent: 'claude-code', studioSessionId: 'herdr-ccc' },
    ],
  },
  integrations: ['claude', 'codex'],
}

async function openMission(page: Page, options: { orbUrl?: string } = {}) {
  const posts: Array<{ path: string; body: any }> = []
  const errors: string[] = []
  const orbCalls: string[] = []
  let folders: any = { list: [], of: {}, at: 1 }
  const categories: any[] = [{ id: 5, name: 'Docs', parent_id: null, created_at: 1, updated_at: 1 }, { id: 6, name: 'site', parent_id: 5, created_at: 1, updated_at: 1 }]
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', 'test-key'); localStorage.setItem('studio_herdr_view', 'tui') })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') posts.push({ path, body: request.postDataJSON() })
    if (path === '/api/coding-agents/herdr') return route.fulfill({ json: STATUS })
    if (path === '/api/coding-agents/herdr/folders') {
      if (request.method() === 'PUT') folders = request.postDataJSON()
      return route.fulfill({ json: folders })
    }
    if (path === '/api/studio/session-categories') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON()
        const category = { id: 10 + categories.length, name: body.name, parent_id: body.parentId ?? body.parent_id ?? null, created_at: 2, updated_at: 2 }
        categories.push(category)
        return route.fulfill({ json: { category } })
      }
      return route.fulfill({ json: { categories } })
    }
    if (path === '/api/coding-agents') return route.fulfill({ json: { tools: [{ id: 'claude-code', name: 'Claude Code', installed: true }, { id: 'codex', name: 'Codex', installed: true }] } })
    if (path === '/api/coding-agents/herdr/agents') return route.fulfill({ json: { link: { paneId: 'w3:p2', workspaceId: 'w3', status: 'unknown' } } })
    if (path === '/api/studio/sessions') return route.fulfill({ json: { sessions: [{ id: 'herdr-aaa', title: 'auth refactor', source: 'coding_agent', agent: 'claude-code', messageCount: 4, category_id: null }, { id: 'herdr-ccc', title: 'docs', source: 'coding_agent', agent: 'claude-code', category_id: 6 }] } })
    if (path === '/api/studio/orb') {
      const url = options.orbUrl ?? 'http://orb'
      return route.fulfill({ json: { connected: !!url, version: url ? '0.1.0' : '', error: '', settings: { url, hasToken: !!url, fromEnv: false } } })
    }
    if (path.startsWith('/api/studio/orb/') && options.orbUrl === '') {
      orbCalls.push(path)
      return route.fulfill({ status: 409, json: { error: 'Pondering Orb is not connected.' } })
    }
    if (path === '/api/studio/orb/tools/orb_list_tasks') return route.fulfill({ json: { result: [
      { title: 'Fix flaky login test', list: 'api', due: '', done: false, priority: 'high' },
      { title: 'Old thing', list: 'api', due: '', done: true, priority: '' },
    ] } })
    if (path.startsWith('/api/studio/orb/tools/')) return route.fulfill({ json: { result: [] } })
    if (path.startsWith('/api/studio/orb/data/')) return route.fulfill({ json: { kind: path.split('/').pop(), data: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/herdr-center.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__herdr_center__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__herdr_center__?session=herdr-aaa')
  await expect(page.getByTestId('herdr-center')).toBeVisible()
  return { posts, errors, orbCalls }
}

test('Mission\'s old address opens Studio\'s herdr page on the same pane', async ({ page }) => {
  await page.route(url => url.pathname === '/index.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>studio</title>' }))
  await page.goto('/mission.html?pane=w2:p1')
  await page.waitForURL(url => url.pathname === '/index.html')
  expect(new URL(page.url()).hash).toBe('#/hermes/chat?center=herdr&pane=w2%3Ap1')
})

test('the herdr page docks Mission: herdr on the left, its tools on the right', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { errors } = await openMission(page)
  await expect(page.locator('.herdr-terminal')).toBeVisible()
  const dock = page.getByTestId('herdr-dock')
  await expect(dock).toBeVisible()
  const terminalBox = (await page.locator('.herdr-terminal').boundingBox())!
  const dockBox = (await dock.boundingBox())!
  expect(dockBox.x).toBeGreaterThan(terminalBox.x + terminalBox.width - 1)
  await expect(page.getByRole('tab')).toHaveText(['Studio chats', 'Tasks & plans', 'Projects', 'Ideas', 'Upkeep', 'Control'])
  // Every chat is listed, with Open in herdr and Open in Studio.
  await expect(page.getByTestId('mission-source-chats').locator('article')).toHaveCount(2)
  // The dock remembers being hidden.
  await page.getByTestId('herdr-center-dock-toggle').click()
  await expect(dock).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('herdr-center')).toBeVisible()
  await expect(page.getByTestId('herdr-dock')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Mission starts an agent from an Orb task with the task as its prompt', async ({ page }) => {
  const { posts, errors } = await openMission(page)
  await page.getByTestId('herdr-dock-tab-tasks').click()
  const card = page.getByTestId('mission-task').filter({ hasText: 'Fix flaky login test' })
  await expect(card).toBeVisible()
  await expect(page.getByTestId('mission-task').filter({ hasText: 'Old thing' })).toHaveCount(0)
  await card.getByTestId('mission-launch').first().click()
  await expect.poll(() => posts.find(p => p.path === '/api/coding-agents/herdr/agents')?.body).toMatchObject({
    agentId: 'claude-code',
    title: 'Fix flaky login test',
    prompt: expect.stringContaining('Fix flaky login test'),
  })
  await page.waitForTimeout(300)
  expect(errors).toEqual([])
})

test('on a phone the tools are a drawer and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openMission(page)
  await expect(page.locator('.herdr-terminal')).toBeVisible()
  await expect(page.getByTestId('herdr-dock')).toHaveCount(0)
  await page.getByTestId('herdr-center-dock-toggle').click()
  await expect(page.getByTestId('herdr-dock')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.getByTestId('herdr-dock-backdrop').click({ position: { x: 10, y: 200 } })
  await expect(page.getByTestId('herdr-dock')).toHaveCount(0)
})

test('without Pondering Orb, its sources show one note and make no Orb requests', async ({ page }) => {
  const { errors, orbCalls } = await openMission(page, { orbUrl: '' })
  for (const tab of ['tasks', 'projects', 'ideas', 'upkeep']) {
    await page.getByTestId(`herdr-dock-tab-${tab}`).click()
    await expect(page.getByTestId('mission-orb-not-connected')).toHaveCount(1)
  }
  // Chats do not need Orb and keep working.
  await page.getByTestId('herdr-dock-tab-chats').click()
  await expect(page.getByTestId('mission-orb-not-connected')).toHaveCount(0)
  // No error toasts and no Orb data requests.
  await page.waitForTimeout(300)
  await expect(page.locator('.n-message--error-type')).toHaveCount(0)
  expect(orbCalls).toEqual([])
  // The note leads to the place to set Orb up.
  await page.getByTestId('herdr-dock-tab-tasks').click()
  await page.getByTestId('mission-orb-open-control').click()
  await expect(page.getByTestId('herdr-dock-tab-control')).toHaveAttribute('aria-selected', 'true')
  expect(errors).toEqual([])
})

test('Mission Control points to Studio\'s Connections for Pondering Orb', async ({ page }) => {
  const { errors } = await openMission(page, { orbUrl: '' })
  await page.getByTestId('herdr-dock-tab-control').click()
  await expect(page.getByTestId('mission-control-panel')).toContainText('Connections → Pondering Orb')
  expect(errors).toEqual([])
})
