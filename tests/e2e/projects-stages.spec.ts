import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

/** Thread stages in the chat list: review until opened, then done; failed threads need you; auto-resolve setting. API mocked. */
test('Projects: a finished thread is ready for review until opened, a failed one needs you, and auto-resolve is a setting', async ({ page }) => {
  const errors: string[] = []
  const posts: Array<{ path: string; body: any }> = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en') })
  const base = { agent: 'codex', brief: 'b', paneId: 'w1:p1', workspace: '', branch: '', pr: '', resolved: false, createdAt: 1 }
  const threads: any[] = [
    { ...base, id: 'r1', title: 'Finished job', sessionId: 'chat-r1', status: 'done', liveStatus: 'done', stage: 'review', updatedAt: 3 },
    { ...base, id: 'f1', title: 'Crashed job', sessionId: 'chat-f1', status: 'gone', liveStatus: 'gone', stage: 'needs_you', failed: true, updatedAt: 2 },
    { ...base, id: 'w1', title: 'Busy job', sessionId: 'chat-w1', status: 'working', liveStatus: 'working', stage: 'working', updatedAt: 1 },
  ]
  const project: any = { id: 'p1', name: 'Homelab', folder: '/srv', instructions: '', profile: 'default', categoryId: 4, coordinatorSessionId: 'coord-1', defaultAgent: 'codex', worktrees: true, wakeCoordinator: true, autoResolveDays: 3, threads, tasks: [], createdAt: 1, updatedAt: 1 }
  const counts = () => ({
    needsYou: threads.filter(t => t.stage === 'needs_you').length,
    working: threads.filter(t => t.stage === 'working').length,
    review: threads.filter(t => t.stage === 'review').length,
    done: threads.filter(t => t.stage === 'review' || t.stage === 'done').length,
    resolved: threads.filter(t => t.stage === 'resolved').length,
  })
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') posts.push({ path, body: request.postDataJSON() })
    if (path === '/api/studio/projects') return route.fulfill({ json: { projects: [{ ...project, counts: counts() }] } })
    if (path === '/api/studio/projects/p1/threads/r1/seen') {
      Object.assign(threads[0], { stage: 'done', seenAt: 5 })
      return route.fulfill({ json: { thread: threads[0] } })
    }
    if (path === '/api/studio/projects/p1' && request.method() === 'PUT') {
      Object.assign(project, request.postDataJSON())
      return route.fulfill({ json: { project: { ...project, counts: counts() } } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/projects-list.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__projects_list__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__projects_list__')

  const card = page.getByTestId('project-p1')
  await card.locator('.project-toggle').click()
  await expect(card.locator('.project-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(card).toContainText('1 need you')
  await expect(card).toContainText('1 to review')
  await expect(card).toContainText('Ready for review')
  // The crashed one says why it needs you, in words.
  await expect(page.getByTestId('project-thread-f1')).toContainText('Failed')
  await expect(page.getByTestId('project-thread-w1')).not.toContainText('Failed')
  if (process.env.PROJECT_SHOTS) await card.screenshot({ path: `${process.env.PROJECT_SHOTS}/25-thread-stages.png` })

  // Opening the finished thread reviews it: it moves to Done.
  await page.getByTestId('project-thread-r1').getByRole('button', { name: /Finished job/ }).click()
  await expect.poll(() => posts.some(p => p.path === '/api/studio/projects/p1/threads/r1/seen')).toBe(true)
  await expect(card).not.toContainText('to review')
  await expect(card).not.toContainText('Ready for review')
  // Opening a thread that is not in review does not mark it.
  await page.getByTestId('project-thread-w1').getByRole('button', { name: /Busy job/ }).click()
  await page.waitForTimeout(300)
  expect(posts.filter(p => p.path.endsWith('/seen')).map(p => p.path)).toEqual(['/api/studio/projects/p1/threads/r1/seen'])

  // Auto-resolve is part of the project's settings.
  await page.getByTestId('project-p1').getByRole('button', { name: /Edit/ }).first().click()
  const days = page.getByTestId('project-form-auto-resolve').locator('input')
  await expect(days).toHaveValue('3')
  await days.fill('0')
  await days.blur()
  await page.getByTestId('project-form-save').click()
  await expect.poll(() => posts.find(p => p.path === '/api/studio/projects/p1')?.body?.autoResolveDays).toBe(0)
  expect(errors).toEqual([])
})
