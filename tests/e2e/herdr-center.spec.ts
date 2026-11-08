import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/** herdr in Studio's chat center (components/coding-agents/herdr/HerdrCenter.vue), API mocked. */
const PANES = [
  { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', label: 'auth refactor', studioAgent: 'claude-code', studioSessionId: 'herdr-aaa' },
  { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'codex', agent_status: 'blocked', label: 'tests', studioAgent: 'codex', studioSessionId: null },
  { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'done', label: 'docs', studioAgent: 'claude-code', studioSessionId: 'herdr-ccc' },
]

async function openCenter(page: Page, session: string) {
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
  // Studio's spaces and agents stand in for herdr's sidebar, inside the center.
  await expect(page.getByTestId('herdr-center-rail').getByTestId('mission-space-row')).toHaveCount(3)
  await expect(page.getByTestId('herdr-spaces-agents')).toContainText('auth refactor')
  await page.getByTestId('herdr-center-key-settings').hover()
  await expect(page.getByText('ctrl+a then s')).toBeVisible()
  expect(errors).toEqual([])
})

test('a chat not running in herdr can be opened there without leaving the page', async ({ page }) => {
  const { posts, errors } = await openCenter(page, 'chat-new')
  await expect(page.locator('.herdr-terminal')).toBeVisible()
  await page.getByTestId('herdr-center-open').click()
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/sessions/chat-new/open')
  await expect(page.getByTestId('herdr-center-agent')).toContainText('fresh')
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/panes/w3%3Ap1/focus')
  expect(page.url()).toContain('__herdr_center__')
  expect(errors).toEqual([])
})
