import { expect, test } from '@playwright/test'

// A project's board: threads sit in columns by status, tasks can be added, moved
// and started as threads, and pull requests show on their cards. API mocked.
const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const s = (id: string, title: string, extra: object = {}) => ({ id, title, profile: 'default', source: 'web', agent: 'hermes', model: 'fixture-model', started_at: 1, last_active: 1, message_count: 2, ...extra })
const sessions = [s('coord-1', 'Homelab · coordinator', { category_id: 4 })]
const base = { brief: 'Do it', paneId: 'w1:p1', branch: '', workspace: '/srv/homelab', resolved: false, pr: '', createdAt: 1 }

test('Projects: the board shows threads by status, and tasks move, start as threads and carry PRs', async ({ page }) => {
  const errors: string[] = []
  const calls: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const threads: any[] = [
    { ...base, id: 't1', title: 'Fix Safari export button', agent: 'claude-code', sessionId: 'herdr-a', status: 'working', liveStatus: 'working', updatedAt: 3 },
    { ...base, id: 't2', title: 'Add Overseer Docker collector', agent: 'codex', sessionId: 'herdr-b', status: 'blocked', liveStatus: 'blocked', updatedAt: 2 },
    { ...base, id: 't3', title: 'Write the Omi setup guide', agent: 'hermes', sessionId: 'herdr-c', status: 'done', liveStatus: 'done', pr: 'https://github.com/Wizard815/omi-local/pull/41', updatedAt: 1 },
  ]
  const tasks: any[] = [
    { id: 'k1', title: 'Review the Argos upgrade PR', notes: 'Check the ROCm build.', column: 'todo', pr: 'https://github.com/Wizard815/argos/pull/12', threadId: '', createdAt: 1, updatedAt: 1 },
  ]
  const project = () => ({ id: 'p1', name: 'Homelab', folder: '/srv/homelab', instructions: '', profile: 'default', categoryId: 4, coordinatorSessionId: 'coord-1', defaultAgent: 'claude-code', worktrees: true, wakeCoordinator: true, threads, tasks, counts: { needsYou: 1, working: 1, done: 1, resolved: 0 }, createdAt: 1, updatedAt: 1 })

  await page.setViewportSize({ width: 1600, height: 900 })
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
      if (event === 'resume') ws.send(value.slice(0, start) + JSON.stringify(['resumed', { session_id: data.session_id, messages: [], isWorking: false, queueLength: 0, events: [], workspace: '/srv/homelab', model: 'fixture-model' }]))
    })
  })
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const input = method === 'GET' ? {} : request.postDataJSON() || {}
    let json: unknown = {}
    if (path.startsWith('/api/studio/projects/p1/') && method !== 'GET') calls.push(`${method} ${path.slice('/api/studio/projects/p1'.length)} ${JSON.stringify(input)}`)
    if (path === '/health') json = { status: 'ok' }
    else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
    else if (path === '/api/hermes/available-models') {
      const groups = [{ provider: 'fixture', label: 'Fixture', base_url: '', api_key: 'fixture', models: ['fixture-model'] }]
      json = { groups, allProviders: groups, profiles: [], default: 'fixture-model', default_provider: 'fixture' }
    }
    else if (path === '/api/studio/projects') json = { projects: [project()] }
    else if (path === '/api/studio/projects/p1') json = { project: project() }
    else if (path === '/api/studio/projects/p1/prs') json = { statuses: {
      'https://github.com/Wizard815/omi-local/pull/41': { state: 'merged', checks: 'passing', mergeable: 'clean', title: 'Omi guide', updatedAt: '' },
      'https://github.com/Wizard815/argos/pull/12': { state: 'open', checks: 'failing', mergeable: 'dirty', title: 'ROCm', updatedAt: '' },
    } }
    else if (path === '/api/studio/projects/p1/tasks' && method === 'POST') {
      const task = { id: `k${tasks.length + 1}`, title: input.title, notes: '', column: 'todo', pr: input.pr || '', threadId: '', createdAt: 9, updatedAt: 9 }
      tasks.push(task)
      json = { task }
    }
    else if (/^\/api\/studio\/projects\/p1\/tasks\/\w+\/start$/.test(path)) {
      const task = tasks.find(item => item.id === path.split('/')[6])
      const thread = { ...base, id: 't4', title: task.title, agent: input.agent, sessionId: '', status: 'starting', liveStatus: 'starting', pr: task.pr, updatedAt: 10 }
      threads.push(thread)
      Object.assign(task, { threadId: 't4', column: 'doing' })
      json = { task, thread }
    }
    else if (/^\/api\/studio\/projects\/p1\/tasks\/\w+$/.test(path) && method === 'PUT') {
      const task = tasks.find(item => item.id === path.split('/')[6])
      Object.assign(task, input, { updatedAt: 11 })
      json = { task }
    }
    else if (/^\/api\/studio\/projects\/p1\/threads\/\w+\/resolved$/.test(path)) {
      const thread = threads.find(item => item.id === path.split('/')[6])
      thread.resolved = input.resolved
      json = { thread }
    }
    else if (/^\/api\/studio\/projects\/p1\/threads\/\w+\/pr$/.test(path)) {
      const thread = threads.find(item => item.id === path.split('/')[6])
      thread.pr = input.pr
      json = { thread }
    }
    else if (/^\/api\/studio\/projects\/p1\/threads\/\w+$/.test(path)) {
      const thread = threads.find(item => item.id === path.split('/')[6])
      json = { thread, messages: [{ role: 'assistant', text: `Working on ${thread.title}.` }] }
    }
    else if (path.startsWith('/api/studio/projects/for-session/')) json = { project: null }
    else if (path === '/api/studio/sessions') json = { sessions: url.searchParams.get('source') === 'global_agent' ? [] : sessions }
    else if (path === '/api/studio/session-categories') json = { categories: [{ id: 4, name: 'Homelab' }] }
    else if (path.endsWith('/messages/paginated')) json = { session: sessions[0], messages: [], total: 0, offset: 0, limit: 150, hasMore: false, taskPlans: [], workspaceRunChanges: [] }
    else if (path.startsWith('/api/studio/sessions/')) json = { session: { ...sessions[0], messages: [] } }
    await route.fulfill({ json })
  })

  await page.goto('/#/hermes/chat?view=projects')
  await page.getByTestId('project-coordinator').click({ timeout: 30_000 })
  await page.getByTestId('project-all-threads').click()
  const pane = page.getByTestId('thread-pane')
  await pane.getByTestId('thread-pane-tab-board').click()
  const board = pane.getByTestId('project-board')
  const column = (name: string) => board.getByTestId(`project-board-column-${name}`)

  // Threads go where their status puts them; a task waits in To do with its PR.
  await expect(column('doing').getByTestId('project-board-card-t1')).toBeVisible()
  await expect(column('needsYou').getByTestId('project-board-card-t2')).toBeVisible()
  await expect(column('review').getByTestId('project-board-card-t3')).toContainText('#41')
  await expect(column('todo').getByTestId('project-board-card-k1')).toContainText('#12')
  // Live PR status from GitHub: state on the link, checks and conflicts beside it.
  await expect(column('review').getByTestId('project-board-card-t3')).toContainText('#41 · Merged')
  await expect(board.getByTestId('project-board-checks-t3')).toHaveText('Checks pass')
  await expect(board.getByTestId('project-board-checks-k1')).toHaveText('Checks fail')
  await expect(column('todo').getByTestId('project-board-card-k1')).toContainText('Conflicts')
  await expect(board.getByTestId('project-board-add-pr-k1')).toHaveCount(0)
  await expect(column('todo').getByTestId('project-board-pr-link')).toHaveAttribute('href', 'https://github.com/Wizard815/argos/pull/12')
  // A thread can only move in or out of Done.
  await expect(board.getByTestId('project-board-move-t1').locator('option')).toHaveText(['Move to…', 'Done'])
  await page.screenshot({ path: process.env.BOARD_SHOT || test.info().outputPath('board.png') })

  // A new task, then it moves to Review with the Move menu.
  await board.getByTestId('project-board-add').click()
  await board.getByTestId('project-board-title').locator('input').fill('Write the changelog')
  await board.getByTestId('project-board-save').click()
  await expect(column('todo').getByTestId('project-board-card-k2')).toContainText('Write the changelog')
  await board.getByTestId('project-board-move-k2').selectOption('review')
  await expect(column('review').getByTestId('project-board-card-k2')).toBeVisible()

  // Starting a task makes it a thread in In progress, keeping its PR.
  await board.getByTestId('project-board-start-k1').click()
  await expect(column('doing').getByTestId('project-board-card-t4')).toContainText('#12')
  await expect(board.getByTestId('project-board-card-k1')).toHaveCount(0)

  // Dragging a finished thread to Done resolves it; a PR link can be added to a thread.
  await board.getByTestId('project-board-card-t3').dragTo(column('done'))
  await expect(column('done').getByTestId('project-board-card-t3')).toBeVisible()
  await board.getByTestId('project-board-add-pr-t1').click()
  await board.getByTestId('project-board-pr-input-t1').locator('input').fill('https://github.com/Wizard815/hermes-studio/pull/3')
  await board.getByTestId('project-board-pr-input-t1').locator('input').press('Enter')
  await expect(column('doing').getByTestId('project-board-card-t1')).toContainText('#3')

  expect(calls).toEqual([
    'POST /tasks {"title":"Write the changelog"}',
    'PUT /tasks/k2 {"column":"review"}',
    'POST /tasks/k1/start {"agent":"claude-code"}',
    'PUT /threads/t3/resolved {"resolved":true}',
    'PUT /threads/t1/pr {"pr":"https://github.com/Wizard815/hermes-studio/pull/3"}',
  ])

  // A thread's title opens it in the pane.
  await board.getByTestId('project-board-card-t2').getByRole('button', { name: 'Add Overseer Docker collector' }).click()
  await expect(pane).toContainText('Working on Add Overseer Docker collector.')
  expect(errors).toEqual([])
})
