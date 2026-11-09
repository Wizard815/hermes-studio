import { test, expect, type Page } from '@playwright/test'

/** herdr Mission (packages/client/mission.html) against mocked Studio + Orb APIs. */
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
  // A folder from before Mission shared Studio's folders: it becomes Studio folder "Clients".
  let folders: any = { list: [{ id: 'fclient', name: 'Clients', color: 'teal', folded: false, start: '', rules: 'client-*' }], of: {}, at: 1 }
  const categories: any[] = [{ id: 5, name: 'Docs', parent_id: null, created_at: 1, updated_at: 1 }, { id: 6, name: 'site', parent_id: 5, created_at: 1, updated_at: 1 }]
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', 'test-key') })
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
  await page.goto('/mission.html')
  await expect(page.getByTestId('mission-app')).toBeVisible()
  return { posts, errors, orbCalls }
}

test('Mission folders are Studio chat folders, and spaces follow their chats', async ({ page }) => {
  const { errors, posts } = await openMission(page)
  // The old Mission folder became a Studio folder, keeping its rule.
  await expect.poll(() => posts.find(p => p.path === '/api/studio/session-categories')?.body).toMatchObject({ name: 'Clients' })
  const clients = page.getByTestId('mission-folder-row').filter({ hasText: 'Clients' })
  await expect(clients.locator('.tree-count')).toHaveText('1')
  // Studio's nesting (Docs › site), and the space whose chat is filed in "site" sits there.
  const rows = page.locator('[data-testid="mission-folder-row"], [data-testid="mission-space-row"]')
  await expect(rows).toHaveText([/Clients/, /api/, /Docs/, /site/, /site/])
  await expect(page.getByTestId('mission-folder-row').filter({ hasText: 'Docs' }).locator('.tree-count')).toHaveText('1')
  await expect(page.getByTestId('mission-space-row')).toHaveCount(2)
  await expect(page.getByTestId('mission-agents')).toContainText('auth refactor')
  expect(errors).toEqual([])
})

test('Mission starts an agent from an Orb task with the task as its prompt', async ({ page }) => {
  const { posts, errors } = await openMission(page)
  await page.getByTestId('mission-source-tasks-tab').click()
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

test('Mission fits a phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openMission(page)
  await expect(page.getByTestId('mission-space-tree')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
})

test('without Pondering Orb, its sources show one note and make no Orb requests', async ({ page }) => {
  const { errors, orbCalls } = await openMission(page, { orbUrl: '' })
  for (const tab of ['tasks', 'projects', 'ideas', 'upkeep']) {
    await page.getByTestId(`mission-source-${tab}-tab`).click()
    await expect(page.getByTestId('mission-orb-not-connected')).toHaveCount(1)
  }
  // Chats do not need Orb and keep working.
  await page.getByTestId('mission-source-chats-tab').click()
  await expect(page.getByTestId('mission-orb-not-connected')).toHaveCount(0)
  // No error toasts and no Orb data requests.
  await page.waitForTimeout(300)
  await expect(page.locator('.n-message--error-type')).toHaveCount(0)
  expect(orbCalls).toEqual([])
  // The note leads to the place to set Orb up.
  await page.getByTestId('mission-source-tasks-tab').click()
  await page.getByTestId('mission-orb-open-control').click()
  await expect(page.getByTestId('mission-source-control-tab')).toHaveAttribute('aria-selected', 'true')
  expect(errors).toEqual([])
})
