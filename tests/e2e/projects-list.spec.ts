import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

/** The chat menu's Projects view: make a project, open its coordinator, start a thread in herdr. API mocked. */
test('Projects: a new project opens its coordinator, a thread starts in herdr and shows when it needs you', async ({ page }) => {
  const errors: string[] = []
  const posts: Array<{ path: string; body: any }> = []
  const projects: any[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en') })
  const counts = (threads: any[]) => ({
    needsYou: threads.filter(t => !t.resolved && t.liveStatus === 'blocked').length,
    working: threads.filter(t => !t.resolved && (t.liveStatus === 'working' || t.liveStatus === 'starting')).length,
    done: threads.filter(t => !t.resolved && t.liveStatus === 'done').length,
    resolved: threads.filter(t => t.resolved).length,
  })
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') posts.push({ path, body: request.postDataJSON() })
    if (path === '/api/studio/projects' && request.method() === 'POST') {
      const body = request.postDataJSON()
      const project = { id: 'p1', name: body.name, folder: body.folder, instructions: body.instructions, profile: 'default', categoryId: 4, coordinatorSessionId: 'coord-1', defaultAgent: body.defaultAgent, threads: [] as any[], counts: counts([]), createdAt: 1, updatedAt: 1 }
      projects.push(project)
      return route.fulfill({ status: 201, json: { project } })
    }
    if (path === '/api/studio/projects') return route.fulfill({ json: { projects: projects.map(p => ({ ...p, counts: counts(p.threads) })) } })
    if (path === '/api/studio/projects/p1/threads') {
      const body = request.postDataJSON()
      const thread = { id: 't1', title: body.title || 'Fix the login test', agent: body.agent, brief: body.brief, paneId: 'w2:p1', sessionId: '', status: 'starting', liveStatus: 'starting', resolved: false, createdAt: 2, updatedAt: 2 }
      projects[0].threads.push(thread)
      return route.fulfill({ status: 201, json: { thread } })
    }
    if (path === '/api/studio/projects/p1/threads/t1/resolved') {
      projects[0].threads[0].resolved = request.postDataJSON().resolved
      return route.fulfill({ json: { thread: projects[0].threads[0] } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/projects-list.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__projects_list__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__projects_list__')

  await expect(page.getByTestId('projects-empty')).toBeVisible()
  await page.getByTestId('projects-new').click()
  await page.getByTestId('project-form-name').locator('input').fill('Homelab')
  await page.getByTestId('project-form-save').click()
  await expect.poll(() => posts.find(p => p.path === '/api/studio/projects')?.body).toMatchObject({ name: 'Homelab', defaultAgent: 'claude-code', worktrees: true, wakeCoordinator: true })
  // A new project opens its coordinator chat and stays expanded.
  await expect.poll(() => page.evaluate(() => (window as any).projectsFixture.opened())).toEqual(['coord-1'])
  await expect(page.getByTestId('project-coordinator')).toHaveAttribute('aria-current', 'page')

  await page.getByTestId('project-new-thread').click()
  await page.getByTestId('thread-form-brief').locator('textarea').fill('Fix the login test\nIt fails one run in five.')
  await page.getByTestId('thread-form-start').click()
  await expect.poll(() => posts.find(p => p.path === '/api/studio/projects/p1/threads')?.body).toMatchObject({ brief: 'Fix the login test\nIt fails one run in five.', agent: 'claude-code' })
  const thread = page.getByTestId('project-thread-t1')
  await expect(thread).toContainText('starting…')
  // Its chat is not there until herdr reports the agent's session.
  await expect(thread.getByRole('button', { name: /Fix the login test/ })).toBeDisabled()

  // herdr reports the agent blocked on an approval, with its chat linked.
  Object.assign(projects[0].threads[0], { liveStatus: 'blocked', status: 'blocked', sessionId: 'herdr-abc' })
  await expect(page.getByTestId('project-p1')).toContainText('1 need you', { timeout: 10_000 })
  await expect(page.getByTestId('project-p1')).toContainText('Needs you')
  await thread.getByRole('button', { name: /Fix the login test/ }).click()
  await expect.poll(() => page.evaluate(() => (window as any).projectsFixture.opened())).toEqual(['coord-1', 'herdr-abc'])

  await thread.getByRole('button', { name: 'Mark resolved' }).click()
  await expect.poll(() => posts.find(p => p.path === '/api/studio/projects/p1/threads/t1/resolved')?.body).toEqual({ resolved: true })
  await expect(page.getByTestId('project-p1')).toContainText('Resolved')
  expect(errors).toEqual([])
})
