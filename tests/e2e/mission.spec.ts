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
      { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'codex', agent_status: 'done', label: 'docs', cwd: '/home/me/code/site', studioAgent: 'codex', studioSessionId: null },
    ],
  },
  integrations: ['claude', 'codex'],
}

async function openMission(page: Page) {
  const posts: Array<{ path: string; body: any }> = []
  const errors: string[] = []
  let folders: any = { list: [{ id: 'fclient', name: 'Clients', color: 'teal', folded: false, start: '', rules: 'client-*' }], of: {}, at: 1 }
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
    if (path === '/api/coding-agents') return route.fulfill({ json: { tools: [{ id: 'claude-code', name: 'Claude Code', installed: true }, { id: 'codex', name: 'Codex', installed: true }] } })
    if (path === '/api/coding-agents/herdr/agents') return route.fulfill({ json: { link: { paneId: 'w3:p2', workspaceId: 'w3', status: 'unknown' } } })
    if (path === '/api/studio/sessions') return route.fulfill({ json: { sessions: [{ id: 'herdr-aaa', title: 'auth refactor', source: 'coding_agent', agent: 'claude-code', messageCount: 4 }] } })
    if (path === '/api/studio/orb') return route.fulfill({ json: { connected: true, version: '0.1.0', error: '', settings: { url: 'http://orb', hasToken: true, fromEnv: false } } })
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
  return { posts, errors }
}

test('Mission groups herdr spaces into folders by rule', async ({ page }) => {
  const { errors } = await openMission(page)
  const folder = page.getByTestId('mission-folder-row').filter({ hasText: 'Clients' })
  await expect(folder.locator('.tree-count')).toHaveText('1')
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
