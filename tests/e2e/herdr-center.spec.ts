import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/** herdr in Studio's chat center (components/coding-agents/herdr/HerdrCenter.vue), API mocked. */
const PANES = [
  { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', label: 'auth refactor', studioAgent: 'claude-code', studioSessionId: 'herdr-aaa' },
  { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'codex', agent_status: 'blocked', label: 'tests', studioAgent: 'codex', studioSessionId: null },
  { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'done', label: 'docs', studioAgent: 'claude-code', studioSessionId: 'herdr-ccc' },
]

/** Studio's Spaces sidebar: two folders (one folded, with a blocked agent inside), one nested, chats awake and asleep. */
const SPACE_VIEW = {
  home: '/home/me',
  file: { path: '/home/me/.config/herdr-space-folders.json', at: 1 },
  spaces: {},
  folders: [
    { id: 'c1', name: 'Work', color: 'blue', folded: false, start: '~/code', rules: '', categoryId: 1, parentId: '', depth: 0 },
    { id: 'c3', name: 'Acme', color: 'pink', folded: false, start: '', rules: 'acme-*', categoryId: 3, parentId: 'c1', depth: 1 },
    { id: 'c2', name: 'Docs', color: 'green', folded: true, start: '', rules: '', categoryId: 2, parentId: '', depth: 0 },
  ],
  chats: [
    { id: 'herdr-aaa', title: 'auth refactor', agent: 'claude-code', folderId: 'c1', out: false, workspace: '/home/me/code/api', workspaceId: 'w1', lastActive: 3 },
    { id: 'herdr-ccc', title: 'docs', agent: 'claude-code', folderId: 'c2', out: false, workspace: null, workspaceId: 'w2', lastActive: 2 },
    { id: 'chat-sleepy', title: 'old idea', agent: 'codex', folderId: '', out: false, workspace: '/home/me/code/acme-site', workspaceId: null, lastActive: 1 },
    { id: 'chat-new', title: 'fresh', agent: 'claude-code', folderId: '', out: false, workspace: '/srv', workspaceId: null, lastActive: 0 },
  ],
}

async function openCenter(page: Page, session: string, options: { machines?: boolean; view?: 'app' | 'tui'; nothing?: boolean; query?: string } = {}) {
  const posts: string[] = []
  const bodies: Array<{ path: string; body: any }> = []
  const spaceView = structuredClone(SPACE_VIEW)
  const errors: string[] = []
  let panes = options.nothing ? [] : [...PANES]
  // Elevated chats: the two running in herdr and one waiting for its agent. chat-new is Studio-only.
  let elevated = options.nothing ? [] : ['herdr-aaa', 'herdr-ccc', 'chat-sleepy']
  const workspaces = options.nothing ? [] : [{ workspace_id: 'w1', label: 'api' }, { workspace_id: 'w2', label: 'site' }, { workspace_id: 'w3', label: 'new' }]
  page.on('pageerror', error => errors.push(error.message))
  // Most tests here are herdr's own terminal UI; the Herdr App layout tests ask for 'app'.
  await page.addInitScript(view => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('studio_herdr_view', view); (window as any).__APP_VERSION__ = 'test' }, options.view || 'tui')
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') posts.push(path)
    if (request.method() !== 'GET') {
      let body: any = null
      try { body = request.postDataJSON() } catch { /* not JSON */ }
      bodies.push({ path, body })
    }
    if (path === '/api/coding-agents/herdr') {
      return route.fulfill({ json: {
        settings: { enabled: true, autoStart: true, setupVersion: '0.9.5', binaryPath: '', session: '', autoImport: true, mirrorTranscripts: true, profile: 'default' },
        installed: true, binary: '/usr/local/bin/herdr', version: '0.9.5', error: '', home: '/home/me', publicUrl: '',
        keys: { prefix: 'ctrl+a', search: 'prefix+g', workspaces: 'prefix+w', settings: 'prefix+s', help: 'cmd+?' },
        server: { version: '0.9.5', running: true, socket: '/tmp/herdr.sock', session: 'default', compatible: true },
        bridge: { connected: true, error: '', version: '0.9.5', focusedPaneId: options.nothing ? null : 'w1:p1', workspaces, panes, chatSpaces: ['herdr-aaa', 'herdr-ccc'], elevatedChats: elevated },
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
    if (path === '/api/coding-agents/herdr/space-folders') return route.fulfill({ json: spaceView })
    const folderChange = /^\/api\/coding-agents\/herdr\/space-folders\/folders\/(c\d+)$/.exec(path)
    if (folderChange && request.method() === 'PUT') {
      const folder = spaceView.folders.find(item => item.id === folderChange[1])
      if (folder) Object.assign(folder, request.postDataJSON())
      return route.fulfill({ json: { ok: true } })
    }
    if (path === '/api/coding-agents/herdr/space-repos') return route.fulfill({ json: { repos: { '/home/me/code/api': { repo: 'api', branch: 'auth', ahead: 2, behind: 0, linked: false } } } })
    if (path === '/api/studio/sessions') return route.fulfill({ json: { sessions: [] } })
    if (path === '/api/coding-agents/herdr/spaces/w1/view') {
      return route.fulfill({ json: {
        workspaceId: 'w1', activeTabId: 'w1:t1', focusedPaneId: 'w1:p1', zoomed: false,
        tabs: [{ tab_id: 'w1:t1', label: '1', number: 1, focused: true, agent_status: 'working', pane_count: 2 }, { tab_id: 'w1:t2', label: 'logs', number: 2, focused: false, agent_status: 'idle', pane_count: 1 }],
        panes: [
          { pane_id: 'w1:p1', focused: true, rect: { x: 0, y: 0, width: 0.5, height: 1 }, process: 'claude' },
          { pane_id: 'w1:p2', focused: false, rect: { x: 0.5, y: 0, width: 0.5, height: 1 }, process: 'bash' },
        ],
      } })
    }
    if (path === '/api/coding-agents/herdr/panes/w1:p1/changes' || path === '/api/coding-agents/herdr/panes/w1%3Ap1/changes') {
      return route.fulfill({ json: { root: '/home/me/code/api', branch: 'auth', changes: [{ path: 'src/a.ts', status: 'M', added: 3, removed: 1 }] } })
    }
    if (path.endsWith('/open')) {
      elevated = [...elevated, 'chat-new']
      panes = [...panes, { pane_id: 'w3:p1', workspace_id: 'w3', agent: 'claude', agent_status: 'idle', label: 'fresh', studioAgent: 'claude-code', studioSessionId: 'chat-new' }]
      return route.fulfill({ json: { link: { paneId: 'w3:p1', workspaceId: 'w3', status: 'idle' } } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/herdr-center.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__herdr_center__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto(`/__herdr_center__?session=${session}${options.query || ''}`)
  return { posts, errors, bodies }
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

test('herdr mode never elevates a Studio-only chat by itself; Elevate this chat does', async ({ page }) => {
  const { posts, errors } = await openCenter(page, 'chat-new')
  await expect(page.locator('.herdr-terminal')).toBeVisible()
  await page.waitForTimeout(800)
  expect(posts.filter(path => path.endsWith('/open'))).toEqual([])
  await expect(page.getByTestId('herdr-center-open')).toHaveText('Elevate this chat')
  await page.getByTestId('herdr-center-open').click()
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

test('on a phone in Studio\'s header there is one menu: herdr\'s actions join the page\'s own', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { errors, posts } = await openCenter(page, 'herdr-aaa&header=1&hostmenu=1')
  const header = page.getByTestId('fixture-header')
  const bar = header.getByTestId('herdr-center-bar')
  await expect(bar.getByTestId('herdr-center-dock-toggle')).toBeVisible()
  // A single "more" button in the row: the page's.
  await expect(header.locator('.header-overflow-trigger, [data-testid="herdr-center-more"], [data-testid="fixture-host-more"]')).toHaveCount(1)
  await expect(bar.getByTestId('herdr-center-reopen')).toHaveCount(0)
  await header.getByTestId('fixture-host-more').click()
  const menu = page.getByTestId('fixture-host-menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Show the Herdr App layout', 'Use herdr’s own sidebar', 'Open in Studio', '+ New Chat', 'Reopen closed chat', 'herdr sidebar', 'Search', 'Workspaces', 'herdr settings'])
  await menu.getByTestId('fixture-host-item-reopen').click()
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/closed-chats/reopen')
  const heights = await bar.evaluate(el => ({ bar: el.getBoundingClientRect().height, tools: el.querySelector('[data-testid="herdr-center-dock-toggle"]')!.getBoundingClientRect().height }))
  expect(heights.bar).toBeLessThan(heights.tools * 1.6)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})

test('Studio\'s Spaces sidebar: every chat in its colored folder, fold, color, edit, drag and the keys', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { errors, posts, bodies } = await openCenter(page, 'herdr-aaa')
  const sidebar = page.getByTestId('space-sidebar')
  await expect(sidebar).toBeVisible()
  // Folders in order, the nested one under its parent; a rule collects the asleep acme chat.
  await expect(sidebar.locator('[data-kind="folder"]')).toHaveCount(3)
  await expect(sidebar.getByTestId('space-folder-c1')).toContainText('Work')
  await expect(sidebar.getByTestId('space-folder-c3')).toContainText('Acme')
  await expect(sidebar.getByTestId('space-chat-chat-sleepy')).toBeVisible()
  // Only chats in herdr are listed (chat-new is Studio-only); the open chat is marked; repo and ahead/behind only when unusual.
  await expect(sidebar.getByTestId('space-chat-chat-new')).toHaveCount(0)
  await expect(sidebar.getByTestId('space-chat-herdr-aaa')).toHaveAttribute('aria-current', 'true')
  await expect(sidebar.getByTestId('space-chat-herdr-aaa')).toContainText('api ↑2')
  // A folded folder hides its chats but still shows that an agent in it is done.
  await expect(sidebar.getByTestId('space-chat-herdr-ccc')).toHaveCount(0)
  await expect(sidebar.getByTestId('space-folder-c2').getByTestId('space-folder-status')).toBeVisible()
  await sidebar.getByTestId('space-folder-c2').click()
  await expect(sidebar.getByTestId('space-chat-herdr-ccc')).toBeVisible()
  await expect.poll(() => bodies.find(item => item.path.endsWith('/space-folders/folders/c2'))?.body).toEqual({ folded: false })
  // Right-click: colors and the folder's actions.
  await sidebar.getByTestId('space-folder-c1').click({ button: 'right' })
  await expect(page.getByText('New space here')).toBeVisible()
  await page.getByTestId('space-folder-menu-color-orange').click()
  await expect.poll(() => bodies.find(item => item.path.endsWith('/space-folders/folders/c1'))?.body).toEqual({ color: 'orange' })
  await sidebar.getByTestId('space-folder-c1').click({ button: 'right' })
  await page.getByText('Edit folder…').click()
  await expect(page.getByTestId('space-folder-name').locator('input')).toHaveValue('Work')
  await expect(page.getByTestId('space-folder-start').locator('input')).toHaveValue('~/code')
  await page.getByTestId('space-folder-cancel').click()
  // Drag a chat onto a folder: it goes in that folder.
  await sidebar.getByTestId('space-chat-chat-sleepy').dragTo(sidebar.getByTestId('space-folder-c2'))
  await expect.poll(() => bodies.find(item => item.path.endsWith('/space-folders/chats/chat-sleepy'))?.body).toEqual({ folderId: 'c2' })
  // alt+down follows the list as it shows: the next chat down (now in the unfolded Docs) is shown in herdr and opens.
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/panes/w2%3Ap1/focus')
  await expect.poll(() => page.evaluate(() => (window as any).herdrCenterFixture.opened)).toContain('herdr-ccc')
  // Clicking an elevated chat whose agent is not running opens it in herdr.
  await sidebar.getByTestId('space-chat-chat-sleepy').click()
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/sessions/chat-sleepy/open')
  expect(errors).toEqual([])
})

test('herdr\'s own sidebar instead of Studio\'s Spaces, and back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { errors } = await openCenter(page, 'herdr-aaa')
  await expect(page.getByTestId('space-sidebar')).toBeVisible()
  await page.getByTestId('space-sidebar-use-herdr').click()
  await expect(page.getByTestId('space-sidebar')).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('studio_herdr_spaces') || '{}').mode)).toBe('herdr')
  await page.getByTestId('herdr-center-spaces-toggle').click()
  await expect(page.getByTestId('space-sidebar')).toBeVisible()
  expect(errors).toEqual([])
})

test('on a phone the Spaces sidebar slides over and closes after a pick', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { errors } = await openCenter(page, 'herdr-aaa&header=1')
  await expect(page.getByTestId('space-sidebar')).toBeHidden()
  await page.getByTestId('herdr-center-spaces-toggle').click()
  await expect(page.getByTestId('space-sidebar')).toBeVisible()
  await expect(page.getByTestId('herdr-spaces-backdrop')).toBeVisible()
  await page.getByTestId('space-chat-herdr-aaa').click()
  await expect(page.getByTestId('space-sidebar')).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})

test('the Herdr App layout: sidebar with Spaces and Agents, the space\'s tabs, its panes as herdr lays them out, a status bar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { posts, errors } = await openCenter(page, 'herdr-aaa', { view: 'app' })
  await expect(page.getByTestId('herdr-app')).toBeVisible()
  const sidebar = page.getByTestId('herdr-app-sidebar')
  await expect(sidebar).toHaveCSS('width', '268px')
  await expect(sidebar.getByTestId('space-sidebar')).toBeVisible()
  await expect(page.getByTestId('herdr-app-agents')).toContainText('Working')
  await expect(page.getByTestId('herdr-app-agents')).toContainText('Blocked')
  await expect(page.getByTestId('herdr-app-tabs').getByRole('tab')).toHaveText(['1×', 'logs×'])
  // Two panes side by side, 8px apart, the focused one framed in the accent.
  const left = await page.getByTestId('herdr-app-pane-w1:p1').boundingBox()
  const right = await page.getByTestId('herdr-app-pane-w1:p2').boundingBox()
  expect(Math.round(right!.x - (left!.x + left!.width))).toBe(8)
  expect(Math.abs(left!.height - right!.height)).toBeLessThan(1)
  await expect(page.getByTestId('herdr-app-pane-w1:p1')).toHaveClass(/focused/)
  // An agent's pane shows the agent and its name (no trailing separator without a folder).
  await expect(page.getByTestId('herdr-app-pane-w1:p2').locator('.hap-pane-head')).toHaveText(/^codex\s*tests$/)
  await expect(page.getByTestId('herdr-app-pane-w1:p2').locator('.hap-pane-head')).toHaveCSS('height', '30px')
  await expect(page.getByTestId('herdr-app-pane-w1:p1')).toHaveCSS('border-radius', '10px')
  await expect(page.getByTestId('herdr-app-status')).toContainText('This computer')
  await expect(page.getByTestId('herdr-app-status')).toContainText('Ctrl Shift P')
  // herdr's terminal UI is not running here: one stream per pane instead (no client stream).
  await expect(page.locator('.herdr-terminal-host[data-mode="client"]')).toHaveCount(0)
  await expect(page.locator('.herdr-terminal-host[data-mode="control"]')).toHaveCount(2)
  // A tab click, a pane click and + go to herdr.
  await page.getByTestId('herdr-app-tab-w1:t2').click()
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/tabs/w1%3At2/focus')
  await page.getByTestId('herdr-app-pane-w1:p2').locator('.hap-pane-head').click()
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/panes/w1%3Ap2/focus')
  await page.getByTestId('herdr-app-new-tab').click()
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/spaces/w1/tabs')
  expect(errors).toEqual([])
})

test('the Herdr App layout: Changes, Files and Issues panels, the command palette, and the switch to herdr\'s own UI', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { errors } = await openCenter(page, 'herdr-aaa', { view: 'app' })
  await page.getByTestId('herdr-app-changes-button').click()
  await expect(page.getByTestId('herdr-app-changes')).toContainText('src/a.ts')
  await expect(page.getByTestId('herdr-app-panel')).toHaveCSS('width', '368px')
  await page.getByTestId('herdr-app-issues').click()
  await expect(page.getByTestId('herdr-dock-tab-inbox')).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('herdr-app-issues').click()
  await expect(page.getByTestId('herdr-app-panel')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+P')
  await expect(page.getByTestId('herdr-app-palette')).toBeVisible()
  await page.getByTestId('herdr-app-palette-input').fill('files')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('herdr-dock-tab-files')).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('herdr-center-view-toggle').click()
  await expect(page.getByTestId('herdr-app')).toHaveCount(0)
  await expect(page.locator('.herdr-terminal-host[data-mode="client"]')).toHaveCount(1)
  await page.getByTestId('herdr-center-view-toggle').click()
  await expect(page.getByTestId('herdr-app')).toBeVisible()
  expect(errors).toEqual([])
})

test('the Herdr App layout on a phone: one-row header, sidebar drawer, one pane at a time', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { errors } = await openCenter(page, 'herdr-aaa', { view: 'app' })
  await expect(page.getByTestId('herdr-app')).toBeVisible()
  await expect(page.getByTestId('herdr-app-sidebar')).toBeHidden()
  await expect(page.locator('.hap-pane')).toHaveCount(1)
  await expect(page.getByTestId('herdr-app-pane-w1:p1')).toBeVisible()
  await page.getByTestId('herdr-app-pane-next').click()
  await expect(page.getByTestId('herdr-app-pane-w1:p2')).toBeVisible()
  await page.getByTestId('herdr-app-expand').click()
  await expect(page.getByTestId('herdr-app-sidebar')).toBeVisible()
  await page.getByTestId('herdr-app-backdrop').click({ position: { x: 370, y: 400 } })
  await expect(page.getByTestId('herdr-app-sidebar')).toBeHidden()
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(scroll).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})

test('nothing in herdr: the page explains how chats get there and elevates this chat', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { posts, errors } = await openCenter(page, 'chat-new', { nothing: true, view: 'app' })
  const nothing = page.getByTestId('herdr-center-nothing')
  await expect(nothing).toBeVisible()
  await expect(nothing).toContainText('Nothing in herdr yet')
  await expect(page.getByTestId('herdr-app')).toHaveCount(0)
  await page.getByTestId('herdr-center-elevate').click()
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/sessions/chat-new/open')
  expect(errors).toEqual([])
})

test('nothing in herdr and no chat at all (a fresh install): the page still opens', async ({ page }) => {
  const { errors } = await openCenter(page, 'none', { nothing: true, view: 'app' })
  await expect(page.getByTestId('herdr-center-nothing')).toBeVisible()
  await expect(page.getByTestId('herdr-center-elevate')).toHaveCount(0)
  await page.getByTestId('herdr-center-back').click()
  await expect.poll(() => page.evaluate(() => (window as any).herdrCenterFixture.backs)).toBe(1)
  expect(errors).toEqual([])
})

test('Studio\'s top bar hidden: the Herdr App tab bar has Chat and Show top bar; Esc outside a pane shows it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { errors } = await openCenter(page, 'herdr-aaa', { view: 'app', query: '&topbar=hidden&header=1' })
  await expect(page.getByTestId('herdr-app')).toBeVisible()
  const tabs = page.getByTestId('herdr-app-tabs')
  await expect(tabs.getByTestId('herdr-center-show-topbar')).toHaveAttribute('aria-label', "Show Studio's top bar")
  await expect(tabs.getByTestId('herdr-center-back-chat')).toHaveText('Chat')
  await page.getByTestId('herdr-app-sidebar').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as any).herdrCenterFixture.topbar)).toEqual([true])
  await expect(tabs.getByTestId('herdr-center-show-topbar')).toHaveCount(0)
  // The bar is shown again: its own button hides it.
  await page.getByTestId('herdr-center-hide-topbar').click()
  await expect.poll(() => page.evaluate(() => (window as any).herdrCenterFixture.topbar)).toEqual([true, false])
  await expect(tabs.getByTestId('herdr-center-show-topbar')).toBeVisible()
  expect(errors).toEqual([])
})
