import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

/** The chat page's sidebar in herdr mode (HerdrSpacesPanel): Studio folders 1:1 with herdr spaces. API mocked. */
test('herdr mode sidebar shows spaces in Studio\'s folders and opens the chat of the agent you pick', async ({ page }) => {
  const posts: string[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en') })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') posts.push(path)
    if (path === '/api/coding-agents/herdr') {
      return route.fulfill({ json: {
        settings: { enabled: true, autoStart: true, setupVersion: '0.9.5', binaryPath: '', session: '', autoImport: true, mirrorTranscripts: true, profile: 'default' },
        installed: true, binary: '/usr/local/bin/herdr', version: '0.9.5', error: '', home: '/home/me', integrations: [],
        server: { version: '0.9.5', running: true, socket: '/tmp/herdr.sock', session: 'default', compatible: true },
        bridge: { connected: true, error: '', version: '0.9.5', focusedPaneId: 'w1:p1',
          workspaces: [{ workspace_id: 'w1', label: 'Build the pricing page', agent_status: 'working' }, { workspace_id: 'w2', label: 'Fix flaky login test', agent_status: 'blocked' }],
          panes: [
            { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', label: 'Build the pricing page', cwd: '/home/me/code/site', studioAgent: 'claude-code', studioSessionId: 'herdr-aaa' },
            { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'blocked', label: 'Fix flaky login test', cwd: '/home/me/code/api', studioAgent: 'claude-code', studioSessionId: 'herdr-bbb' },
          ] },
      } })
    }
    if (path === '/api/studio/session-categories') return route.fulfill({ json: { categories: [{ id: 1, name: 'Clients', parent_id: null, created_at: 1, updated_at: 1 }, { id: 2, name: 'site', parent_id: 1, created_at: 1, updated_at: 1 }] } })
    if (path === '/api/coding-agents/herdr/folders') return route.fulfill({ json: { list: [{ id: 'c2', name: 'site', color: 'teal', folded: false, start: '~/code/site', rules: '' }], of: {}, at: 1 } })
    if (path === '/api/studio/sessions') return route.fulfill({ json: { sessions: [{ id: 'herdr-aaa', category_id: 2 }, { id: 'herdr-bbb', category_id: null }] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/herdr-spaces.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__herdr_spaces__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__herdr_spaces__')

  const rows = page.locator('[data-testid="mission-folder-row"], [data-testid="mission-space-row"]')
  await expect(rows).toHaveText([/Clients/, /site/, /Build the pricing page/, /Fix flaky login test/])
  // The open chat's space is selected; expand the other space and pick its agent.
  await expect(page.getByTestId('mission-space-row').filter({ hasText: 'Build the pricing page' })).toHaveClass(/active/)
  await page.getByTestId('mission-space-row').filter({ hasText: 'Fix flaky login test' }).click()
  await expect.poll(() => posts).toContain('/api/coding-agents/herdr/panes/w2%3Ap1/focus')
  await expect.poll(() => page.evaluate(() => (window as any).herdrSpacesFixture.opened)).toEqual(['herdr-bbb'])
  expect(errors).toEqual([])
})
