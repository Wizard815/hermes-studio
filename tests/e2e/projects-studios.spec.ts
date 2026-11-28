import { expect, test } from '@playwright/test'

// Connected Studios: make a code, pair with another Studio, approve one waiting,
// share a project, and message a project another Studio shares. API mocked.
const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const s = (id: string, title: string, extra: object = {}) => ({ id, title, profile: 'default', source: 'web', agent: 'hermes', model: 'fixture-model', started_at: 1, last_active: 1, message_count: 2, ...extra })
const sessions = [s('coord-1', 'Homelab · coordinator', { category_id: 4 })]

test('Projects: pair Studios, approve and share a project, and message a shared one', async ({ page }) => {
  const errors: string[] = []
  const calls: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const project = { id: 'p1', name: 'Homelab', folder: '/srv/homelab', instructions: '', profile: 'default', categoryId: 4, coordinatorSessionId: 'coord-1', defaultAgent: 'claude-code', worktrees: true, wakeCoordinator: true, threads: [], tasks: [], memory: [], artifacts: [], counts: { needsYou: 0, working: 0, done: 0, resolved: 0 }, createdAt: 1, updatedAt: 1 }
  const peers: any[] = [
    { id: 'hwui_garage', url: 'http://garage.tailnet.ts.net:8648', label: 'Garage Studio', approved: false, projects: [], group: false, introducedBy: '', createdAt: 1, lastSeenAt: 1 },
    { id: 'hwui_attic', url: 'http://attic.tailnet.ts.net:8648', label: 'Attic Studio', approved: true, projects: [], group: true, introducedBy: 'Lab Studio', createdAt: 1, lastSeenAt: 1 },
  ]
  let groupShared: string[] = []
  const log = [
    { at: 1_700_000_000_000, peer: 'hwui_attic', label: 'Attic Studio', direction: 'in', kind: 'introduced', project: '', text: 'Introduced by Lab Studio', by: 'studio' },
    { at: 1_700_000_100_000, peer: 'hwui_attic', label: 'Attic Studio', direction: 'out', kind: 'message', project: 'q7', text: 'Run the ROCm eval', by: 'coordinator', from: { project: 'p1', name: 'Homelab' } },
  ]
  const shared = [{
    id: 'q1', name: 'Overseer', counts: { needsYou: 1, working: 1, done: 0, resolved: 0 },
    threads: [{ id: 't1', title: 'Add Docker collector', agent: 'codex', status: 'working', resolved: false, pr: 'https://github.com/Wizard815/overseer/pull/4' }, { id: 't2', title: 'Fix login', agent: 'claude-code', status: 'blocked', resolved: false, pr: '' }],
    tasks: [{ id: 'k1', title: 'Write the readiness doc', column: 'todo', pr: '' }],
    artifacts: [],
  }]

  await page.setViewportSize({ width: 1400, height: 1300 })
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
    })
  })
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const input = method === 'GET' ? {} : request.postDataJSON() || {}
    let json: unknown = {}
    if (path.startsWith('/api/studio/peers') && method !== 'GET') calls.push(`${method} ${path.slice('/api/studio/peers'.length)} ${JSON.stringify(input)}`)
    if (path === '/health') json = { status: 'ok' }
    else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
    else if (path === '/api/hermes/available-models') {
      const groups = [{ provider: 'fixture', label: 'Fixture', base_url: '', api_key: 'fixture', models: ['fixture-model'] }]
      json = { groups, allProviders: groups, profiles: [], default: 'fixture-model', default_provider: 'fixture' }
    }
    else if (path === '/api/studio/projects') json = { projects: [project] }
    else if (path === '/api/studio/peers') json = { self: { id: 'hwui_office', label: 'Office Studio' }, peers }
    else if (path === '/api/studio/peers/group') {
      if (method === 'PUT') groupShared = input.projects
      json = { projects: groupShared }
    }
    else if (path === '/api/studio/peers/log') json = { log }
    else if (path === '/api/studio/peers/code') json = { code: 'K7QM-4XRP', expiresAt: Date.now() + 300_000 }
    else if (path === '/api/studio/peers/pair') {
      const peer = { id: 'hwui_lab', url: input.url, label: 'Lab Studio', approved: true, projects: [], group: input.group, introducedBy: '', createdAt: 2, lastSeenAt: 2 }
      peers.push(peer)
      json = { peer }
    }
    else if (/^\/api\/studio\/peers\/\w+$/.test(path) && method === 'PUT') {
      const peer = peers.find(item => item.id === path.split('/')[4])
      Object.assign(peer, input)
      json = { peer }
    }
    else if (path === '/api/studio/peers/hwui_lab/projects') json = { projects: shared }
    else if (path.endsWith('/message')) json = { queued: true }
    else if (path.startsWith('/api/studio/projects/for-session/')) json = { project: null }
    else if (path === '/api/studio/sessions') json = { sessions: url.searchParams.get('source') === 'global_agent' ? [] : sessions }
    else if (path === '/api/studio/session-categories') json = { categories: [{ id: 4, name: 'Homelab' }] }
    else if (path.endsWith('/messages/paginated')) json = { session: sessions[0], messages: [], total: 0, offset: 0, limit: 150, hasMore: false, taskPlans: [], workspaceRunChanges: [] }
    else if (path.startsWith('/api/studio/sessions/')) json = { session: { ...sessions[0], messages: [] } }
    await route.fulfill({ json })
  })

  await page.goto('/#/hermes/chat?view=projects')
  await page.getByTestId('projects-studios').click({ timeout: 30_000 })
  const dialog = page.getByTestId('studios-dialog')
  await expect(dialog).toContainText('This Studio: Office Studio')

  // A code for the other Studio to type.
  await dialog.getByTestId('studios-make-code').click()
  await expect(dialog.getByTestId('studios-code')).toHaveText('K7QM-4XRP')

  // Pairing with another Studio by its address and code.
  await dialog.getByTestId('studios-url').locator('input').fill('http://lab.tailnet.ts.net:8648')
  await dialog.getByTestId('studios-code-input').locator('input').fill('ab12-cd34')
  await dialog.getByTestId('studios-join-group').click()
  await dialog.getByTestId('studios-pair').click()
  await expect(dialog.getByTestId('studios-status')).toContainText('Connected to Lab Studio')
  await expect(dialog.getByTestId('studios-peer-hwui_lab')).toContainText('Connected')

  // A Studio that typed this one's code waits for approval, then gets a project.
  const garage = dialog.getByTestId('studios-peer-hwui_garage')
  await expect(garage).toContainText('Waiting for your approval')
  await garage.getByTestId('studios-approve-hwui_garage').click()
  await expect(garage).toContainText('Connected')
  await garage.getByTestId('studios-share-hwui_garage').click()
  await page.locator('.n-base-select-option', { hasText: 'Homelab' }).click()
  await expect(garage.getByTestId('studios-share-hwui_garage')).toContainText('Homelab')
  await page.keyboard.press('Escape')

  // The group: an introduced member, a project shared with every member, and the log.
  const attic = dialog.getByTestId('studios-peer-hwui_attic')
  await expect(attic).toContainText('Introduced by Lab Studio')
  await expect(attic).toContainText('Group')
  await garage.getByTestId('studios-group-hwui_garage').click()
  // Close the earlier menu (a click outside it), so the pick lands in the new one.
  await dialog.getByText('Paired Studios', { exact: true }).click()
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await dialog.getByTestId('studios-group-share').click()
  await page.locator('.n-base-select-option:visible', { hasText: 'Homelab' }).click()
  await expect(dialog.getByTestId('studios-group-share')).toContainText('Homelab')
  const bridge = dialog.getByTestId('studios-log')
  await expect(bridge).toContainText('To Attic Studio · message · coordinator (Homelab)')
  await expect(bridge).toContainText('Run the ROCm eval')
  await expect(bridge).toContainText('From Attic Studio · joined · group')

  // A project the other Studio shares: its board, and a message to its coordinator.
  await page.keyboard.press('Escape')
  const lab = dialog.getByTestId('studios-peer-hwui_lab')
  await lab.getByTestId('studios-load-hwui_lab').click()
  const overseer = lab.getByTestId('studios-project-q1')
  await expect(overseer).toContainText('Add Docker collector')
  await expect(overseer).toContainText('Write the readiness doc')
  await expect(overseer).toContainText('2 open threads · 1 need someone · 1 tasks')
  await overseer.getByTestId('studios-message-q1').locator('input').fill('Can the collector skip paused containers?')
  await overseer.getByTestId('studios-send-q1').click()
  await expect(dialog.getByTestId('studios-status')).toHaveText('Sent to the coordinator of Overseer')
  await page.screenshot({ path: process.env.STUDIOS_SHOT || test.info().outputPath('studios.png') })

  expect(calls).toEqual([
    'POST /code {}',
    'POST /pair {"url":"http://lab.tailnet.ts.net:8648","code":"ab12-cd34","selfUrl":"http://127.0.0.1:' + new URL(page.url()).port + '","group":true}',
    'PUT /hwui_garage {"approved":true}',
    'PUT /hwui_garage {"projects":["p1"]}',
    'PUT /hwui_garage {"group":true}',
    'PUT /group {"projects":["p1"]}',
    'POST /hwui_lab/projects/q1/message {"text":"Can the collector skip paused containers?"}',
  ])
  expect(errors).toEqual([])
})
