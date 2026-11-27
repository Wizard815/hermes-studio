import { expect, test } from '@playwright/test'

// A big Studio: a folder with hundreds of chats shows 50 at a time, the open
// chat always shows, and "Show N more" adds the rest. API mocked.
const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const sessions = Array.from({ length: 300 }, (_, i) => ({
  id: `chat-${i}`, title: `Homelab chat ${i}`, profile: 'default', source: 'web', agent: 'hermes', model: 'fixture-model',
  started_at: 100_000 - i, last_active: 100_000 - i, message_count: 2, category_id: 4,
}))

test('Chat sidebar: a big folder shows 50 chats, keeps the open one, and shows more on request', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.addInitScript(tok => {
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_active_profile_name', 'default')
    localStorage.setItem('hermes_api_key', tok)
  }, token)
  await page.routeWebSocket('**/socket.io/**', ws => {
    ws.send('0' + JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 60000, pingTimeout: 60000 }))
    ws.onMessage(raw => {
      const value = String(raw)
      if (value.startsWith('40')) ws.send(value.split(',')[0] + ',' + JSON.stringify({ sid: 'fixture' }))
      if (!value.startsWith('42')) return
      const start = value.indexOf('['), [event, data] = JSON.parse(value.slice(start))
      if (event === 'resume') ws.send(value.slice(0, start) + JSON.stringify(['resumed', { session_id: data.session_id, messages: [], isWorking: false, queueLength: 0, events: [], model: 'fixture-model' }]))
    })
  })
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json: unknown = {}
    if (path === '/health') json = { status: 'ok' }
    else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
    else if (path === '/api/hermes/available-models') {
      const groups = [{ provider: 'fixture', label: 'Fixture', base_url: '', api_key: 'fixture', models: ['fixture-model'] }]
      json = { groups, allProviders: groups, profiles: [], default: 'fixture-model', default_provider: 'fixture' }
    }
    else if (path === '/api/studio/projects') json = { projects: [] }
    else if (path === '/api/studio/sessions') json = { sessions: url.searchParams.get('source') === 'global_agent' ? [] : sessions }
    else if (path === '/api/studio/session-categories') json = { categories: [{ id: 4, name: 'Homelab' }] }
    else if (path.endsWith('/messages/paginated')) json = { session: sessions[0], messages: [], total: 0, offset: 0, limit: 150, hasMore: false, taskPlans: [], workspaceRunChanges: [] }
    else if (path.startsWith('/api/studio/sessions/')) json = { session: { ...sessions[0], messages: [] } }
    await route.fulfill({ json })
  })

  // Open a chat far down the folder: it shows although it is past the first 50.
  await page.goto('/#/hermes/session/chat-250')
  const folder = page.locator('.session-group-body').filter({ hasText: 'Homelab chat 0' }).last()
  await expect(folder.getByText('Homelab chat 49', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(folder.getByText('Homelab chat 50', { exact: true })).toHaveCount(0)
  await expect(folder.getByText('Homelab chat 250', { exact: true })).toHaveCount(1)
  const more = folder.getByRole('button', { name: 'Show 249 more' })
  await expect(more).toBeVisible()

  await more.click()
  await expect(folder.getByText('Homelab chat 249', { exact: true })).toHaveCount(1)
  // 250 shown plus the open chat: 49 left.
  await expect(folder.getByRole('button', { name: 'Show 49 more' })).toBeVisible()
  await folder.getByRole('button', { name: 'Show 49 more' }).click()
  await expect(folder.getByText('Homelab chat 299', { exact: true })).toHaveCount(1)
  await expect(folder.getByRole('button', { name: /^Show \d+ more$/ })).toHaveCount(0)
  expect(errors).toEqual([])
})
