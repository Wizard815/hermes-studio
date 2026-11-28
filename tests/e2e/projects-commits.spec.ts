import { expect, test } from '@playwright/test'

// A project's board lists the commits each thread and PR is working on; hovering
// or focusing a commit shows its caveman summary, asked for once. API mocked.
const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const s = (id: string, title: string, extra: object = {}) => ({ id, title, profile: 'default', source: 'web', agent: 'hermes', model: 'fixture-model', started_at: 1, last_active: 1, message_count: 2, ...extra })
const sessions = [s('coord-1', 'Homelab · coordinator', { category_id: 4 })]
const base = { brief: 'Do it', paneId: 'w1:p1', branch: '', workspace: '/srv/homelab', resolved: false, pr: '', createdAt: 1 }

test('Projects: board cards list their commits, and a hover shows a caveman summary', async ({ page }) => {
  const errors: string[] = []
  const asked: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const threads: any[] = [
    { ...base, id: 't1', title: 'Show commits on the board', agent: 'claude-code', sessionId: 'herdr-a', status: 'working', liveStatus: 'working', branch: 'studio/show-commits-t1', workspace: '/srv/homelab/.worktrees/t1', updatedAt: 3 },
    { ...base, id: 't3', title: 'Write the Omi setup guide', agent: 'hermes', sessionId: 'herdr-c', status: 'done', liveStatus: 'done', pr: 'https://github.com/Wizard815/omi-local/pull/41', updatedAt: 1 },
  ]
  const tasks: any[] = []
  const project = () => ({ id: 'p1', name: 'Homelab', folder: '/srv/homelab', instructions: '', profile: 'default', categoryId: 4, coordinatorSessionId: 'coord-1', defaultAgent: 'claude-code', worktrees: true, wakeCoordinator: true, threads, tasks, counts: { needsYou: 0, working: 1, done: 1, resolved: 0 }, createdAt: 1, updatedAt: 1 })
  const c = (n: number, subject: string, extra: object = {}) => ({ sha: String(n).repeat(40), short: String(n).repeat(7), subject, author: 'Wizard', date: '2026-11-27T18:0' + n + ':00Z', url: '', summary: '', ...extra })
  const branch = [c(4, 'Hover a commit for its summary'), c(3, 'Cache summaries per commit SHA', { summary: 'Summary saved per commit. Model asked once, never again.' }), c(2, 'List PR commits from GitHub'), c(1, 'List branch commits in the board')]
  const pr = [c(6, 'Omi guide: pairing steps', { url: 'https://github.com/Wizard815/omi-local/commit/' + '6'.repeat(40) }), c(5, 'Omi guide: first draft', { url: 'https://github.com/Wizard815/omi-local/commit/' + '5'.repeat(40) })]

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
    else if (path === '/api/studio/projects/p1/prs') json = { statuses: { 'https://github.com/Wizard815/omi-local/pull/41': { state: 'merged', checks: 'passing', mergeable: 'clean', title: 'Omi guide', updatedAt: '' } } }
    else if (path === '/api/studio/projects/p1/commits') json = { threads: { t1: { commits: branch, more: false } }, prs: { 'https://github.com/Wizard815/omi-local/pull/41': { commits: pr, more: false } } }
    else if (/^\/api\/studio\/projects\/p1\/commits\/\w+\/summary$/.test(path)) {
      const sha = path.split('/')[6]
      asked.push(`${sha.slice(0, 7)} ${url.searchParams.get('thread') || url.searchParams.get('pr')}`)
      json = { summary: sha.startsWith('4') ? 'Hover commit, get short caveman words. Board say what code do.' : 'Guide tell how pair Omi with phone.' }
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

  // The thread's branch: newest three, then all four on request.
  const mine = board.getByTestId('project-commits-t1')
  await expect(mine).toContainText('4 commits')
  await expect(mine.locator('li')).toHaveCount(3)
  await mine.getByTestId('project-commits-more-t1').press('Enter')
  await expect(mine.getByTestId('project-commits-more-t1')).toHaveAttribute('aria-expanded', 'true')
  await expect(mine.locator('li')).toHaveCount(4)

  // Hover asks once for a summary; a saved one shows without asking.
  await mine.getByTestId('project-commit-4444444').hover()
  await expect(page.getByTestId('project-commit-tip-4444444')).toContainText('Hover commit, get short caveman words.')
  await page.waitForTimeout(400) // the tooltip fades in
  await pane.screenshot({ path: process.env.COMMITS_SHOT || test.info().outputPath('commits.png') })
  await mine.getByTestId('project-commit-3333333').hover()
  await expect(page.getByTestId('project-commit-tip-3333333')).toContainText('Model asked once')
  await mine.getByTestId('project-commit-4444444').hover()
  await expect(page.getByTestId('project-commit-tip-4444444')).toContainText('caveman words')

  // The PR card's commits come from the PR, link to GitHub, and open by keyboard focus too.
  const theirs = board.getByTestId('project-commits-t3')
  await expect(theirs).toContainText('2 commits')
  await expect(theirs.getByTestId('project-commit-6666666')).toHaveAttribute('href', /omi-local\/commit\/6{40}$/)
  await theirs.getByTestId('project-commit-6666666').focus()
  await expect(page.getByTestId('project-commit-tip-6666666')).toContainText('Guide tell how pair Omi with phone.')

  expect(asked).toEqual(['4444444 t1', '6666666 https://github.com/Wizard815/omi-local/pull/41'])
  expect(errors).toEqual([])
})
