import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/** herdr in Studio's chat center (components/coding-agents/herdr/HerdrCenter.vue), API mocked. */
const PANES = [
  { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', label: 'auth refactor', studioAgent: 'claude-code', studioSessionId: 'herdr-aaa' },
  { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'codex', agent_status: 'blocked', label: 'tests', studioAgent: 'codex', studioSessionId: null },
  { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'done', label: 'docs', studioAgent: 'claude-code', studioSessionId: 'herdr-ccc' },
]

async function openCenter(page: Page, session: string, options: { machines?: boolean } = {}) {
  const posts: string[] = []
  const errors: string[] = []
  let panes = [...PANES]
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') posts.push(path)
    if (path === '/api/coding-agents/herdr') {
      return route.fulfill({ json: {
        settings: { enabled: true, autoStart: true, setupVersion: '0.9.5', binaryPath: '', session: '', autoImport: true, mirrorTranscripts: true, profile: 'default' },
        installed: true, binary: '/usr/local/bin/herdr', version: '0.9.5', error: '', home: '/home/me', publicUrl: '',
        keys: { prefix: 'ctrl+a', search: 'prefix+g', workspaces: 'prefix+w', settings: 'prefix+s', help: 'cmd+?' },
        server: { version: '0.9.5', running: true, socket: '/tmp/herdr.sock', session: 'default', compatible: true },
        bridge: { connected: true, error: '', version: '0.9.5', focusedPaneId: 'w1:p1', workspaces: [{ workspace_id: 'w1', label: 'api' }, { workspace_id: 'w2', label: 'site' }, { workspace_id: 'w3', label: 'new' }], panes },
        integrations: ['claude', 'codex'],
      } })
    }
    if (path === '/api/coding-agents/herdr/machines') {
      return route.fulfill({ json: { machines: options.machines ? [{ id: 'm1', label: 'Build box', target: 'me@build', session: 'default', enabled: true, selected: false }] : [] } })
    }
    if (path === '/api/coding-agents/herdr/machines/m1/agents') {
      return route.fulfill({ json: { agents: [{ pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'working', label: 'Refactor deploy', cwd: '/srv', focused: false }] } })
    }
    if (path === '/api/studio/session-categories') return route.fulfill({ json: { categories: [] } })
    if (path === '/api/coding-agents/herdr/folders') return route.fulfill({ json: { list: [], of: {}, at: 1 } })
    if (path === '/api/studio/sessions') return route.fulfill({ json: { sessions: [] } })
    if (path.endsWith('/open')) {
      panes = [...panes, { pane_id: 'w3:p1', workspace_id: 'w3', agent: 'claude', agent_status: 'idle', label: 'fresh', studioAgent: 'claude-code', studioSessionId: 'chat-new' }]
      return route.fulfill({ json: { link: { paneId: 'w3:p1', workspaceId: 'w3', status: 'idle' } } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/herdr-center.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__herdr_center__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto(`/__herdr_center__?session=${session}`)
  return { posts, errors }
}

test('herdr\'s own UI opens on the chat\'s agent, with one-tap herdr keys', async ({ page }) => {
  const { posts, errors } = await openCenter(page, 'herdr-aaa')
  await expect(page.getByTestId('herdr-center-agent')).toContainText('auth refactor')
  // herdr shows the focused pane, so the chat's agent is focused first.
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/panes/w1%3Ap1/focus')
  await expect(page.locator('.herdr-terminal')).toBeVisible()
  await expect(page.getByTestId('herdr-center-key-search')).toHaveText('Search')
  await expect(page.getByTestId('herdr-center-key-workspaces')).toBeVisible()
  await expect(page.getByTestId('herdr-center-key-settings')).toHaveText('herdr settings')
  // A key the terminal cannot send (cmd+?) has no button.
  await expect(page.getByTestId('herdr-center-key-help')).toHaveCount(0)
  // herdr's own sidebar is the chat list here: one tap toggles it, and Studio adds no second list.
  await expect(page.getByTestId('herdr-center-key-sidebar')).toHaveText('herdr sidebar')
  await expect(page.locator('.herdr-center-rail')).toHaveCount(0)
  await page.getByTestId('herdr-center-key-settings').hover()
  await expect(page.getByText('ctrl+a then s')).toBeVisible()
  expect(errors).toEqual([])
})

test('in herdr mode a chat not running in herdr opens there by itself, once', async ({ page }) => {
  const { posts, errors } = await openCenter(page, 'chat-new')
  await expect(page.locator('.herdr-terminal')).toBeVisible()
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/sessions/chat-new/open')
  await expect(page.getByTestId('herdr-center-agent')).toContainText('fresh')
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/panes/w3%3Ap1/focus')
  expect(posts.filter(path => path.endsWith('/sessions/chat-new/open'))).toHaveLength(1)
  expect(page.url()).toContain('__herdr_center__')
  expect(errors).toEqual([])
})

test('the chat follows herdr: switching agents inside herdr opens that agent\'s chat', async ({ page }) => {
  const { posts, errors } = await openCenter(page, 'herdr-aaa')
  await expect(page.getByTestId('herdr-center-agent')).toContainText('auth refactor')
  // A focus report that disagrees with the focus Studio just asked for is stale.
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/panes/w1%3Ap1/focus')
  await page.evaluate(() => { (window as any).herdrCenterFixture.store.status.bridge.focusedPaneId = 'w2:p1' })
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => (window as any).herdrCenterFixture.opened)).toEqual([])
  await page.evaluate(() => { (window as any).herdrCenterFixture.store.status.bridge.focusedPaneId = 'w1:p1' })
  await page.waitForTimeout(2600)
  // herdr focuses another agent (its search or picker): Studio opens that agent's chat.
  await page.evaluate(() => { (window as any).herdrCenterFixture.store.status.bridge.focusedPaneId = 'w2:p1' })
  await expect.poll(() => page.evaluate(() => (window as any).herdrCenterFixture.opened)).toEqual(['herdr-ccc'])
  // A pane with no Studio chat (a plain shell) does not change the chat.
  await page.evaluate(() => { (window as any).herdrCenterFixture.store.status.bridge.focusedPaneId = 'w1:p2' })
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => (window as any).herdrCenterFixture.opened)).toEqual(['herdr-ccc'])
  // New chat without a connected herdr view falls back to Studio's new chat page.
  await page.getByTestId('herdr-center-new-chat').click()
  await expect.poll(() => page.evaluate(() => (window as any).herdrCenterFixture.newChats)).toBe(1)
  expect(errors).toEqual([])
})

test('with no herdr chat open, herdr mode lands on herdr, and picking an agent opens its chat', async ({ page }) => {
  const { posts, errors } = await openCenter(page, 'none')
  await expect(page.getByTestId('herdr-center-landing')).toBeVisible()
  await expect(page.getByTestId('herdr-center-open')).toHaveCount(0)
  await expect(page.locator('.herdr-terminal')).toBeVisible()
  // Nothing is opened or focused on its own.
  await page.waitForTimeout(500)
  expect(posts.filter(path => path.endsWith('/open') || path.endsWith('/focus'))).toEqual([])
  // Switching agents inside herdr opens that agent's Studio chat.
  await page.evaluate(() => { (window as any).herdrCenterFixture.store.status.bridge.focusedPaneId = 'w2:p1' })
  await expect.poll(() => page.evaluate(() => (window as any).herdrCenterFixture.opened)).toEqual(['herdr-ccc'])
  expect(errors).toEqual([])
})

test('herdr remote: picking a saved machine opens that machine\'s full herdr', async ({ page }) => {
  const { errors } = await openCenter(page, 'herdr-aaa', { machines: true })
  await expect(page.getByTestId('herdr-center-machines')).toBeVisible()
  await page.getByTestId('herdr-center-machine-m1').click()
  // A remote herdr has no Studio chats to start: New chat is for this machine.
  await expect(page.getByTestId('herdr-center-new-chat')).toHaveCount(0)
  await expect(page.getByTestId('herdr-center-remote')).toBeVisible()
  await expect(page.getByTestId('herdr-center-remote-chip')).toContainText('Build box')
  // Back to this machine: the local herdr view is still there.
  await page.getByTestId('herdr-center-machines').getByRole('radio', { name: 'Local' }).click()
  await expect(page.getByTestId('herdr-center-remote')).toHaveCount(0)
  await expect(page.getByTestId('herdr-center-agent')).toContainText('auth refactor')
  expect(errors).toEqual([])
})

test('in the page header herdr\'s bar is one row: the less-used keys fold into More when short', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { errors } = await openCenter(page, 'herdr-aaa&header=1')
  const header = page.getByTestId('fixture-header')
  const bar = header.getByTestId('herdr-center-bar')
  await expect(bar).toBeVisible()
  for (const id of ['herdr-center-open-studio', 'herdr-center-new-chat', 'herdr-center-reopen', 'herdr-center-dock-toggle']) {
    await expect(bar.getByTestId(id)).toBeVisible()
  }
  // Not enough room for everything at 1440: Search & co. are in the More menu.
  await expect(bar.getByTestId('herdr-center-key-search')).toHaveCount(0)
  await bar.locator('.header-overflow-trigger').click()
  await expect(page.getByTestId('herdr-center-key-search')).toBeVisible()
  await expect(page.getByTestId('herdr-center-key-workspaces')).toBeVisible()
  // One row.
  const box = (await bar.boundingBox())!
  const reopen = (await bar.getByTestId('herdr-center-reopen').boundingBox())!
  expect(box.height).toBeLessThan(reopen.height * 1.6)
  // With room to spare, every key is in the row.
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1900, height: 900 })
  await expect(bar.getByTestId('herdr-center-key-search')).toBeVisible()
  expect(errors).toEqual([])
})

test('on a phone the header keeps one row: Tools and More, and the page never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { errors } = await openCenter(page, 'herdr-aaa&header=1')
  const bar = page.getByTestId('fixture-header').getByTestId('herdr-center-bar')
  await expect(bar.getByTestId('herdr-center-dock-toggle')).toBeVisible()
  await expect(bar.getByTestId('herdr-center-reopen')).toHaveCount(0)
  await bar.locator('.header-overflow-trigger').click()
  await expect(page.getByTestId('herdr-center-reopen')).toBeVisible()
  await expect(page.getByTestId('herdr-center-new-chat')).toBeVisible()
  await expect(page.getByTestId('herdr-center-open-studio')).toBeVisible()
  const heights = await bar.evaluate(el => ({ bar: el.getBoundingClientRect().height, tools: el.querySelector('[data-testid="herdr-center-dock-toggle"]')!.getBoundingClientRect().height }))
  expect(heights.bar).toBeLessThan(heights.tools * 1.6)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})
