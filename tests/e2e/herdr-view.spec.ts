import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const PANES = [
  { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'blocked', label: 'auth refactor', studioAgent: 'claude-code', studioSessionId: 'herdr-aaa', nativeSessionId: 'aaa' },
  { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'codex', agent_status: 'working', label: 'tests', studioAgent: 'codex', studioSessionId: null, nativeSessionId: null },
  { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'done', label: 'docs', studioAgent: 'claude-code', studioSessionId: 'herdr-ccc', nativeSessionId: 'ccc' },
]

async function openFixture(page: Page, options: { enabled: boolean }) {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const errors: string[] = []
  let enabled = options.enabled
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() })
    if (url.pathname === '/api/coding-agents/herdr/settings') {
      enabled = request.postDataJSON().enabled ?? enabled
      return route.fulfill({ json: { settings: { enabled, binaryPath: '', session: '', autoImport: true, mirrorTranscripts: true, profile: 'default' } } })
    }
    if (url.pathname === '/api/coding-agents/herdr') {
      return route.fulfill({ json: {
        settings: { enabled, binaryPath: '', session: '', autoImport: true, mirrorTranscripts: true, profile: 'default' },
        installed: true, binary: '/usr/local/bin/herdr', version: '0.9.5',
        server: { version: '0.9.5', running: true, socket: '/tmp/herdr.sock', session: 'default', compatible: true },
        error: '',
        bridge: enabled ? { connected: true, error: '', version: '0.9.5', focusedPaneId: 'w1:p1', workspaces: [{ workspace_id: 'w1', label: 'api', agent_status: 'blocked' }, { workspace_id: 'w2', label: 'site', agent_status: 'done' }], panes: PANES } : null,
        integrations: ['claude', 'codex'],
      } })
    }
    if (url.pathname === '/api/coding-agents') {
      return route.fulfill({ json: { tools: [
        { id: 'claude-code', name: 'Claude Code', installed: true },
        { id: 'codex', name: 'Codex', installed: true },
        { id: 'dsh', name: 'DSH', installed: true },
      ] } })
    }
    if (url.pathname === '/api/coding-agents/herdr/agents') return route.fulfill({ json: { link: { paneId: 'w3:p1', workspaceId: 'w3', status: 'unknown' } } })
    if (url.pathname.startsWith('/api/coding-agents/herdr/panes/')) return route.fulfill({ json: { ok: true } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/herdr-view.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__herdr_view__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  return { requests, errors }
}

test('turning herdr on from settings', async ({ page }) => {
  const { requests, errors } = await openFixture(page, { enabled: false })
  await page.goto('/__herdr_view__')
  await expect(page.getByTestId('herdr-settings')).toBeVisible()
  await expect(page.getByTestId('herdr-tab-agents')).toBeDisabled()
  await page.getByTestId('herdr-enable').click()
  await expect.poll(() => requests.find(r => r.path === '/api/coding-agents/herdr/settings')?.body).toEqual({ enabled: true })
  await expect(page.getByTestId('herdr-tab-agents')).toBeEnabled()
  expect(errors).toEqual([])
})

test('agents grouped by workspace with herdr status icons and chat links', async ({ page }) => {
  const { errors } = await openFixture(page, { enabled: true })
  await page.goto('/__herdr_view__?tab=agents')
  const rows = page.getByTestId('herdr-pane-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0).locator('.agent-status-icon')).toHaveText('×')
  await expect(rows.nth(1).locator('.agent-status-icon')).toHaveText('◐')
  await expect(rows.nth(2).locator('.agent-status-icon')).toHaveText('✓')
  // The blocked agent is selected first because it needs attention.
  await expect(rows.nth(0)).toHaveClass(/active/)
  await expect(page.locator('.herdr-view-pane-bar')).toContainText('auth refactor')
  // Only panes linked to a Studio chat offer the chat link.
  await expect(page.locator('.herdr-view-pane-chat')).toHaveCount(2)
  await rows.nth(2).locator('.herdr-view-pane-chat').click()
  await expect.poll(() => page.evaluate(() => (window as any).herdrFixture.route())).toBe('/hermes/session/herdr-ccc')
  expect(errors).toEqual([])
})

test('starting an agent only offers agents herdr can host', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { requests, errors } = await openFixture(page, { enabled: true })
  await page.goto('/__herdr_view__?tab=agents')
  await page.getByTestId('herdr-new-agent').click()
  await page.getByTestId('herdr-launch-agent').click()
  await expect(page.locator('.n-base-select-option')).toHaveText(['Claude Code', 'Codex'])
  await page.locator('.n-base-select-option', { hasText: 'Codex' }).click()
  await page.getByTestId('herdr-launch-submit').click()
  await expect.poll(() => requests.find(r => r.path === '/api/coding-agents/herdr/agents')?.body).toEqual({ agentId: 'codex' })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  expect(overflow).toBe(false)
  expect(errors).toEqual([])
})
