import { test, expect, type Page } from '@playwright/test'
import { WATCHER_KINDS } from '../../packages/shared/watcher'
import { resolve } from 'node:path'

/** A JWT-shaped token whose payload says super_admin (the client only reads the role). */
const SUPER_ADMIN_TOKEN = `x.${Buffer.from(JSON.stringify({ role: 'super_admin' })).toString('base64url')}.y`

const KINDS = [...WATCHER_KINDS]

async function openFixture(page: Page, extra: any[] = []) {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const errors: string[] = []
  const now = Date.now()
  let events = [
    ...extra,
    { id: 3, time: now - 30_000, kind: 'approval_denied', severity: 'block', sessionId: 'chat-1', taskId: '', agent: 'claude-code', folder: '/srv/app', text: 'Denied: rm /srv/shared/cache.db', link: '/hermes/session/chat-1', action: { kind: 'command', value: 'rm /srv/shared/cache.db' }, read: false },
    { id: 2, time: now - 60_000, kind: 'cleanroom_blocked', severity: 'block', sessionId: 'chat-2', taskId: '', agent: 'codex', folder: '/srv/app', text: 'Clean room blocked a connection to example.com:443 (not an allowed host)', link: '/hermes/session/chat-2', read: false },
    { id: 1, time: now - 120_000, kind: 'run_limit', severity: 'block', sessionId: 'chat-1', taskId: '', agent: 'claude-code', folder: '/srv/app', text: 'Run stopped by Studio: cost limit reached', link: '/hermes/session/chat-1', read: true },
  ]
  const kinds = Object.fromEntries(KINDS.map(kind => [kind, { alert: !['approval_approved', 'approval_trusted', 'work_decided'].includes(kind), mattermost: kind === 'run_limit' || kind === 'loop' }]))
  let settings: any = { kinds, historySize: 500, maxAgeDays: 30, extras: { pipelock: { enabled: false, proxyUrl: 'http://127.0.0.1:8888' }, innerwarden: { enabled: false }, langfuse: { enabled: false } } }
  const extras = [
    { id: 'pipelock', enabled: false, available: false, detail: 'Not available here: nothing answers at http://127.0.0.1:8888.' },
    { id: 'innerwarden', enabled: false, available: false, detail: 'Not available here: the innerwarden program is not installed on this host.' },
    { id: 'langfuse', enabled: false, available: false, detail: 'Not available here: the profile has no HERMES_LANGFUSE_PUBLIC_KEY.' },
  ]
  let rules: any[] = []
  let cleanroom: any = { image: 'node:24-bookworm-slim', network: 'allowlist', allowHosts: ['registry.npmjs.org'], cpus: 2, memory: '4g', pids: 1024, readOnlyRoot: true, dropAllCaps: true, capAdd: [], user: 'auto', selfCheck: true, leakCheck: true, egressLog: true, auditChain: true, allowWebTools: false }
  const unread = () => events.filter(event => !event.read).length
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(token => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', token); (window as any).__APP_VERSION__ = 'test' }, SUPER_ADMIN_TOKEN)
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.method() === 'GET' || request.method() === 'DELETE' ? null : request.postDataJSON()
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body })
    switch (url.pathname) {
      case '/api/studio/watcher/events':
        return route.fulfill({ json: { events, unread: unread(), total: events.length } })
      case '/api/studio/watcher/events/read':
        events = events.map(event => body.all || body.ids?.includes(event.id) ? { ...event, read: true } : event)
        return route.fulfill({ json: { unread: unread() } })
      case '/api/studio/watcher/events/clear':
        events = body.ids ? events.filter(event => !body.ids.includes(event.id)) : []
        return route.fulfill({ json: { unread: unread() } })
      case '/api/studio/watcher/settings':
        if (request.method() === 'PUT') {
          const next = body.settings
          for (const [kind, value] of Object.entries(next.kinds || {})) settings.kinds[kind] = { ...settings.kinds[kind], ...(value as object) }
          if (next.historySize) settings.historySize = next.historySize
        }
        return route.fulfill({ json: { settings, extras } })
      case '/api/studio/watcher/trust':
        if (request.method() === 'POST') {
          const rule = { id: `trust-${rules.length + 1}`, createdAt: Date.now(), createdBy: 'admin', note: '', expiresAt: 0, ...body }
          rules = [...rules, rule]
          return route.fulfill({ json: { rule, rules } })
        }
        return route.fulfill({ json: { rules } })
      case '/api/hermes/jobs/approval-mode':
        return route.fulfill({ json: { mode: request.method() === 'PUT' ? body.mode : 'deny' } })
      case '/api/studio/agent-work/settings':
        return route.fulfill({ json: { shareToOrb: false, mattermost: { channel: 'agent-work', channelId: 'c', teamId: 't', mention: [], mentionOnApproval: true, actionUrl: '' }, allglance: { url: '', hasToken: false, fromEnv: false }, wiki: { url: '', hasToken: false, folder: 'daily', section: 'Studio' } } })
      case '/api/coding-agents/cleanroom/settings':
        if (request.method() === 'PUT') cleanroom = { ...cleanroom, ...body }
        return route.fulfill({ json: cleanroom })
    }
    if (url.pathname.startsWith('/api/studio/watcher/trust/') && request.method() === 'DELETE') {
      rules = rules.filter(rule => !url.pathname.endsWith(rule.id))
      return route.fulfill({ json: { rules } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/watcher.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__watcher__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  return { requests, errors, rules: () => rules }
}

test('the bell shows the unread count, lists alerts newest first and marks them read', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__watcher__')
  const bell = page.getByTestId('watcher-bell')
  await expect(bell).toHaveAttribute('aria-label', 'Alerts, 2 unread')
  await expect(bell.getByTestId('watcher-bell-count')).toHaveText('2')
  await bell.click()
  const items = page.getByTestId('watcher-list').first().getByTestId('watcher-item')
  await expect(items).toHaveCount(3)
  await expect(items.first()).toContainText('Blocked')
  await expect(items.first()).toContainText('Denied: rm /srv/shared/cache.db')
  await expect(items.first()).toContainText('New')
  await expect(page.getByTestId('watcher-unread-text').first()).toHaveText('2 unread')
  await items.nth(1).getByTestId('watcher-mark-read').click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/watcher/events/read')?.body).toEqual({ ids: [2] })
  await expect(bell).toHaveAttribute('aria-label', 'Alerts, 1 unread')
  await page.getByTestId('watcher-mark-all').first().click()
  await expect.poll(() => requests.some(r => r.path === '/api/studio/watcher/events/read' && r.body.all === true)).toBe(true)
  await expect(page.getByTestId('watcher-unread-text').first()).toHaveText('All read')
  await expect(bell.getByTestId('watcher-bell-count')).toHaveCount(0)
  // Open chat follows the alert's link.
  await items.first().getByTestId('watcher-open').click()
  await expect.poll(() => page.evaluate(() => (window as any).__route())).toBe('/hermes/session/chat-1')
  expect(errors).toEqual([])
})

test('a phone question opens the Android page to answer it, and Open chat opens the chat that asked', async ({ page }) => {
  const phoneQuestion = { id: 4, time: Date.now() - 5_000, kind: 'approval_asked', severity: 'warn', sessionId: 'chat-3', taskId: '', agent: 'ekko', folder: '', text: 'ekko wants to tap e4 "Send" on Pixel 8. Allow or deny it on the Android page.', link: '/android', action: { kind: 'tool', value: 'android:emulator-5554:com.example.chat:tap:danger' }, read: false }
  const { errors } = await openFixture(page, [phoneQuestion])
  await page.goto('/__watcher__')
  await page.getByTestId('watcher-bell').click()
  const items = page.getByTestId('watcher-list').first().getByTestId('watcher-item')
  await expect(items).toHaveCount(4)
  // Alerts that already link to their chat get no second button.
  await expect(items.nth(1).getByTestId('watcher-open-chat')).toHaveCount(0)
  await expect(items.first().getByTestId('watcher-open')).toHaveText('Open')
  await items.first().getByTestId('watcher-open-chat').click()
  await expect.poll(() => page.evaluate(() => (window as any).__route())).toBe('/hermes/session/chat-3')
  await page.getByTestId('watcher-bell').click()
  await page.getByTestId('watcher-list').first().getByTestId('watcher-item').first().getByTestId('watcher-open').click()
  await expect.poll(() => page.evaluate(() => (window as any).__route())).toBe('/android')
  expect(errors).toEqual([])
})

test('Trust this makes a rule for the chat from the alert, and Settings lists and removes it', async ({ page }) => {
  const { requests, errors, rules } = await openFixture(page)
  await page.goto('/__watcher__')
  await page.getByTestId('watcher-bell').click()
  await page.getByTestId('watcher-list').first().getByTestId('watcher-trust').first().click()
  const dialog = page.getByTestId('watcher-trust-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('watcher-trust-pattern').locator('input')).toHaveValue('rm /srv/shared/cache.db')
  await dialog.getByTestId('watcher-trust-pattern').locator('input').fill('rm /srv/shared/*')
  await dialog.getByTestId('watcher-trust-save').click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/watcher/trust')?.body).toMatchObject({ kind: 'command', scope: 'chat', target: 'chat-1', pattern: 'rm /srv/shared/*', expiresAt: 0 })
  await expect(dialog).toHaveCount(0)
  expect(rules()).toHaveLength(1)
  // Settings → Watcher shows it after a reload, with Remove.
  await page.reload()
  const rule = page.getByTestId('watcher-rule')
  await expect(rule).toContainText('rm /srv/shared/*')
  await expect(rule).toContainText('Chat: chat-1')
  await rule.getByTestId('watcher-rule-remove').click()
  await expect(page.getByTestId('watcher-rule')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Settings → Watcher turns kinds on for the bell and Mattermost and says why an extra is not available', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__watcher__')
  const settings = page.getByTestId('watcher-settings')
  await expect(settings).toContainText('Mattermost posts go to ~agent-work')
  await expect(page.getByTestId('watcher-kind-run_limit-mattermost')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('watcher-kind-approval_approved-alert')).toHaveAttribute('aria-checked', 'false')
  await page.getByTestId('watcher-kind-approval_approved-alert').click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/watcher/settings')?.body).toEqual({ settings: { kinds: { approval_approved: { alert: true } } } })
  await expect(page.getByTestId('watcher-extra-innerwarden')).toContainText('Not available here')
  await expect(page.getByTestId('watcher-extra-innerwarden-detail')).toContainText('innerwarden program is not installed')
  await page.getByTestId('watcher-cron-mode').click()
  await page.getByText('Let them run').click()
  await expect.poll(() => requests.find(r => r.path === '/api/hermes/jobs/approval-mode')?.body).toEqual({ mode: 'approve' })
  expect(errors).toEqual([])
})

test('Settings → Clean rooms saves a changed wall and the allowed hosts', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__watcher__')
  const section = page.getByTestId('clean-room-settings')
  await expect(page.getByTestId('clean-room-readOnlyRoot')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('clean-room-save')).toBeDisabled()
  await page.getByTestId('clean-room-allowWebTools').click()
  await page.getByTestId('clean-room-hosts').locator('textarea').fill('registry.npmjs.org\npypi.org')
  await expect(section).toContainText('Not saved yet')
  await page.getByTestId('clean-room-save').click()
  await expect.poll(() => requests.find(r => r.path === '/api/coding-agents/cleanroom/settings')?.body).toMatchObject({ allowWebTools: true, allowHosts: ['registry.npmjs.org', 'pypi.org'], readOnlyRoot: true })
  await expect(page.getByTestId('clean-room-save')).toBeDisabled()
  expect(errors).toEqual([])
})

test('on a phone the bell is a menu row with its count that opens the list as a dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { errors } = await openFixture(page)
  await page.goto('/__watcher__')
  const row = page.getByTestId('watcher-menu-row')
  await expect(row).toContainText('Alerts')
  await expect(row.getByTestId('watcher-bell-count')).toHaveText('2')
  await row.click()
  const modal = page.getByTestId('watcher-modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByTestId('watcher-item')).toHaveCount(3)
  expect(errors).toEqual([])
})
