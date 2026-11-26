import { expect, test } from '@playwright/test'

// Projects on a wide screen: a thread opens in a pane beside its coordinator chat,
// shows its latest messages, takes a message, and can open as the full chat. API mocked.
const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const s = (id: string, title: string, extra: object = {}) => ({ id, title, profile: 'default', source: 'web', agent: 'hermes', model: 'fixture-model', started_at: 1, last_active: 1, message_count: 2, ...extra })
const sessions = [
  s('coord-1', 'Homelab · coordinator', { category_id: 4 }),
  s('herdr-a', 'Fix Safari export button', { source: 'coding_agent', agent: 'claude-code', category_id: 4 }),
]
const thread = { id: 't1', title: 'Fix Safari export button', agent: 'claude-code', brief: 'Fix it', paneId: 'w1:p1', sessionId: 'herdr-a', status: 'working', liveStatus: 'working', resolved: false, createdAt: 1, updatedAt: 1 }
const waiting = { ...thread, id: 't2', title: 'Add Overseer Docker collector', agent: 'codex', sessionId: 'herdr-b', branch: 'studio/add-overseer-docker-collector-t2', status: 'blocked', liveStatus: 'blocked', updatedAt: 2 }
const finished = { ...thread, id: 't3', title: 'Write the Omi setup guide', agent: 'hermes', sessionId: 'herdr-c', status: 'done', liveStatus: 'done', updatedAt: 3 }
const project = { id: 'p1', name: 'Homelab', folder: '/srv/homelab', instructions: '', profile: 'default', categoryId: 4, coordinatorSessionId: 'coord-1', defaultAgent: 'claude-code', worktrees: true, wakeCoordinator: true, memory: [] as any[], threads: [thread, waiting, finished], counts: { needsYou: 1, working: 1, done: 1, resolved: 0 }, createdAt: 1, updatedAt: 1 }
const history: Record<string, any[]> = {
  'coord-1': [{ id: 1, role: 'assistant', content: 'Coordinator says the Safari thread is working.', timestamp: 1 }],
  'herdr-a': [{ id: 2, role: 'assistant', content: 'Full thread chat transcript.', timestamp: 1 }],
}

test('Projects: a thread opens beside its coordinator, takes a message and opens as the full chat', async ({ page }) => {
  const errors: string[] = []
  const sent: unknown[] = []
  const removed = new Set<string>()
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.addInitScript(tok => {
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_active_profile_name', 'default')
    localStorage.setItem('hermes_api_key', tok)
    localStorage.setItem('studio_projects_expanded', JSON.stringify(['p1']))
  }, token)
  await page.routeWebSocket('**/socket.io/**', ws => {
    ws.send('0' + JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 60000, pingTimeout: 60000 }))
    ws.onMessage(raw => {
      const value = String(raw)
      if (value.startsWith('40')) ws.send(value.split(',')[0] + ',' + JSON.stringify({ sid: 'fixture' }))
      if (!value.startsWith('42')) return
      const start = value.indexOf('['), [event, data] = JSON.parse(value.slice(start))
      if (event === 'resume') ws.send(value.slice(0, start) + JSON.stringify(['resumed', { session_id: data.session_id, messages: history[data.session_id] || [], isWorking: false, queueLength: 0, events: [], workspace: '/srv/homelab', model: 'fixture-model' }]))
    })
  })
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    let json: unknown = {}
    if (path === '/health') json = { status: 'ok' }
    else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
    else if (path === '/api/hermes/available-models') {
      const groups = [{ provider: 'fixture', label: 'Fixture', base_url: '', api_key: 'fixture', models: ['fixture-model'] }]
      json = { groups, allProviders: groups, profiles: [], default: 'fixture-model', default_provider: 'fixture' }
    }
    else if (path === '/api/studio/projects') json = { projects: [project] }
    else if (path === '/api/studio/projects/p1/memory') { const item = { id: 'm1', text: request.postDataJSON().text, by: 'person', createdAt: 1 }; project.memory.push(item); json = { memory: item } }
    else if (path === '/api/studio/projects/p1') json = { project: { ...project, threads: project.threads.filter(item => !removed.has(item.id)) } }
    else if (removed.has(path.split('/')[6] || '')) return route.fulfill({ status: 404, json: { error: 'Thread not found in this project' } })
    else if (path === '/api/studio/projects/p1/threads/t2') json = { thread: waiting, messages: [{ role: 'assistant', text: 'Waiting for approval to restart the overseer container.' }] }
    else if (path === '/api/studio/projects/p1/threads/t3') json = { thread: finished, messages: [{ role: 'assistant', text: 'The guide is in docs/omi-setup.md.' }] }
    else if (path === '/api/studio/projects/p1/threads/t1') json = { thread, messages: [{ role: 'user', text: 'Fix the Safari export button.' }, { role: 'assistant', text: 'Found it: Safari has no showSaveFilePicker.' }] }
    else if (path === '/api/studio/projects/p1/threads/t1/message') { sent.push(request.postDataJSON()); json = { ok: true } }
    else if (path.startsWith('/api/studio/projects/for-session/')) json = { project: null }
    else if (path === '/api/studio/sessions') json = { sessions: url.searchParams.get('source') === 'global_agent' ? [] : sessions }
    else if (path === '/api/studio/session-categories') json = { categories: [{ id: 4, name: 'Homelab' }] }
    else if (path.endsWith('/messages/paginated')) {
      const id = path.split('/').at(-3) || ''
      json = { session: sessions.find(x => x.id === id), messages: history[id] || [], total: (history[id] || []).length, offset: 0, limit: 150, hasMore: false, taskPlans: [], workspaceRunChanges: [] }
    }
    else if (path.startsWith('/api/studio/sessions/')) {
      const id = decodeURIComponent(path.split('/').at(-1) || '')
      json = { session: { ...(sessions.find(x => x.id === id) ?? sessions[0]), messages: history[id] || [] } }
    }
    await route.fulfill({ json })
  })

  await page.goto('/#/hermes/chat?view=projects')
  await expect(page.getByTestId('project-thread-t1')).toBeVisible({ timeout: 30_000 })
  // The Projects button counts threads that need the person and threads that are done.
  await expect(page.getByTestId('sidebar-projects').getByTestId('project-attention-needs')).toHaveText('1')
  await expect(page.getByTestId('sidebar-projects').getByTestId('project-attention-idle')).toHaveText('1')
  await page.getByTestId('project-thread-t1').getByRole('button', { name: /Fix Safari/ }).click()

  // The coordinator is the main chat and the thread sits beside it.
  const pane = page.getByTestId('thread-pane')
  await expect(pane).toContainText('Found it: Safari has no showSaveFilePicker.')
  await expect(page.getByTestId('chat-header')).toContainText('Homelab · coordinator')
  await expect(page.getByText('Coordinator says the Safari thread is working.')).toBeVisible()
  await expect(page.getByTestId('project-thread-t1').getByRole('button', { name: /Fix Safari/ })).toHaveAttribute('aria-current', 'page')

  await pane.getByTestId('thread-pane-input').locator('textarea').fill('Also check Firefox.')
  await pane.getByTestId('thread-pane-send').click()
  await expect.poll(() => sent).toEqual([{ text: 'Also check Firefox.' }])
  await expect(pane).toContainText('Also check Firefox.')

  // The switcher moves to all threads, and a card opens that thread.
  await pane.getByTestId('thread-pane-switcher').click()
  await page.locator('.n-base-select-option', { hasText: 'All threads (3 open)' }).click()
  const all = pane.getByTestId('thread-pane-all')
  await expect(all.getByTestId('thread-pane-card-t2')).toContainText('Waiting for approval to restart the overseer container.')
  await expect(all.getByTestId('thread-pane-card-t2')).toContainText('studio/add-overseer-docker-collector-t2')
  await expect(all.getByTestId('thread-pane-card-t3')).toContainText('The guide is in docs/omi-setup.md.')
  // Context shows the project's folder and settings.
  await pane.getByTestId('thread-pane-tab-context').click()
  await expect(pane.getByTestId('thread-pane-context')).toContainText('/srv/homelab')
  // Memory: facts every thread and the coordinator get.
  await pane.getByTestId('thread-pane-memory-input').locator('input').fill('Unraid is at 192.168.1.10')
  await pane.getByTestId('thread-pane-memory-add').click()
  await expect(pane.getByTestId('thread-pane-memory-m1')).toContainText('Unraid is at 192.168.1.10')
  await expect(pane.getByTestId('thread-pane-memory-m1')).toContainText('You')
  await pane.getByTestId('thread-pane-tab-threads').click()
  await all.getByTestId('thread-pane-card-t2').click()
  await expect(pane).toContainText('Waiting on you. Answer it in the full chat.')
  await pane.getByTestId('thread-pane-switcher').click()
  await page.locator('.n-base-select-option', { hasText: 'Fix Safari export button' }).click()
  await expect(pane).toContainText('Found it: Safari has no showSaveFilePicker.')

  // Opening the full chat replaces the coordinator and closes the pane.
  await pane.getByTestId('thread-pane-open').click()
  await expect(page.getByText('Full thread chat transcript.')).toBeVisible()
  await expect(pane).toHaveCount(0)

  // Back on the coordinator, the pane opens again and closes with its button.
  await page.getByTestId('project-coordinator').click()
  await page.getByTestId('project-all-threads').click()
  await expect(pane.getByTestId('thread-pane-all')).toBeVisible()

  // Back in the chat list, the project's folder carries the same counts.
  await page.getByTestId('projects-back').click()
  const folder = page.locator('.session-group-header', { hasText: 'Homelab' }).first()
  await expect(folder.getByTestId('project-attention-needs')).toHaveText('1')
  // Project folders and the chats in them carry the Projects mark.
  await expect(folder.getByTestId('session-group-project-icon')).toBeVisible()
  await expect(page.getByTestId('session-project-tag').first()).toBeVisible()
  await page.getByTestId('sidebar-projects').click()
  await expect(pane).toBeVisible()
  // A thread removed elsewhere while it is open falls back to all threads.
  await pane.getByTestId('thread-pane-switcher').click()
  await page.locator('.n-base-select-option', { hasText: 'Write the Omi setup guide' }).click()
  await expect(pane).toContainText('The guide is in docs/omi-setup.md.')
  removed.add('t3')
  await expect(pane.getByTestId('thread-pane-all')).toBeVisible({ timeout: 10_000 })
  await expect(pane.getByTestId('thread-pane-card-t3')).toHaveCount(0)
  await pane.getByTestId('thread-pane-close').click()
  await expect(pane).toHaveCount(0)
  expect(errors).toEqual([])
})
