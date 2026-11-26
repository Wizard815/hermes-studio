import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const templates = [
  { id: 'nginx', name: 'Static page (nginx)', description: 'nginx welcome page', image: 'nginx:1.29.8-alpine', build: null, needsBuildUrl: false, sizeMb: 25, port: 80, logins: [], source: 'builtin' },
  { id: 'vikunja', name: 'Vikunja', description: 'To-do lists', image: 'vikunja/vikunja:2.7.1', build: null, needsBuildUrl: false, sizeMb: 55, port: 3456, logins: [{ username: 'alice', password: 'lab-pass-123' }], source: 'builtin' },
  { id: 'allglance', name: 'ALLGlance', description: 'Give its git URL', image: null, build: '', needsBuildUrl: true, sizeMb: 300, port: 8080, logins: [], source: 'builtin' },
]

function run(status: string, extra: Record<string, unknown> = {}) {
  const finished = !['starting', 'running'].includes(status)
  return {
    id: '20261125-220000-abcd', createdAt: Date.now(), status, model: { id: 'openrouter/tencent/hy4-flash', provider: 'openrouter', model: 'tencent/hy4-flash', profile: 'default' },
    capUsd: 0.25, minutes: 20, instructions: 'Check private tasks', keepRunning: false, browser: true,
    steps: ['images', 'network', 'apps', 'health', 'seed', 'agent', 'report', 'cleanup'].map((key, i) => ({ key, state: finished ? 'done' : i < 3 ? 'done' : i === 3 ? 'running' : 'pending' })),
    apps: [{ id: 'vikunja', name: 'Vikunja', url: 'http://vikunja:3456', state: finished ? 'removed' : 'healthy', logins: [{ username: 'alice', password: 'lab-pass-123' }] }],
    transcript: [{ at: Date.now(), role: 'tool', tool: 'browser_open', text: '{"url":"http://vikunja:3456"}' }],
    screenshots: finished ? ['app-vikunja.png'] : [], logs: finished ? ['vikunja'] : [],
    cost: { gatewayUsd: 0.0123, tokens: 45678, unpricedCalls: 0, openrouterBefore: 7.5, openrouterAfter: 7.5131, openrouterUsd: 0.0131 },
    ...(finished ? { finishedAt: Date.now(), removed: true, report: { summary: 'Bob cannot see Alice’s task.', passed: 1, failed: 1, skipped: 0, checks: [
      { name: 'Private tasks stay private', result: 'pass', detail: 'bob sees no secret task' },
      { name: 'Settings menu', result: 'fail', detail: 'error page' },
    ] } } : {}),
    ...extra,
  }
}

async function openFixture(page: Page, options: { docker?: boolean } = {}) {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const errors: string[] = []
  let current: any = null
  let polls = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() })
    const path = url.pathname
    if (path === '/api/studio/test-lab') {
      return route.fulfill({ json: {
        docker: options.docker === false ? { available: false, error: 'connect ENOENT /var/run/docker.sock' } : { available: true, version: '29.9.2', socket: '/var/run/docker.sock' },
        settings: { registryMirror: 'mirror.gcr.io', runnerImage: 'node:24-bookworm-slim', browserImage: 'chromedp/headless-shell:157.0.8103.27', defaultCapUsd: 0.5, defaultMinutes: 20, maxSteps: 40 },
        templates, problems: [], models: options.docker === false ? [] : [{ id: 'openrouter/tencent/hy4-flash', provider: 'openrouter', model: 'tencent/hy4-flash', profile: 'default' }, { id: 'openrouter/openai/gpt-5', provider: 'openrouter', model: 'openai/gpt-5', profile: 'default' }],
        customTemplateDir: '/data/test-lab/templates',
      } })
    }
    if (path === '/api/studio/test-lab/runs' && request.method() === 'POST') { current = run('running'); return route.fulfill({ json: current }) }
    if (path === '/api/studio/test-lab/runs') return route.fulfill({ json: { runs: current ? [{ id: current.id, createdAt: current.createdAt, status: current.status, model: current.model, keepRunning: false, removed: current.removed, apps: ['Vikunja'], costUsd: 0.0131, passed: current.report?.passed, failed: current.report?.failed }] : [] } })
    if (path.endsWith('/screenshots/app-vikunja.png')) return route.fulfill({ contentType: 'image/png', body: PNG })
    if (path.endsWith('/logs/vikunja')) return route.fulfill({ contentType: 'text/plain', body: 'vikunja: started\n' })
    if (path.endsWith('/stop')) { current = run('stopped', { stopReason: 'user' }); return route.fulfill({ json: current }) }
    if (path.startsWith('/api/studio/test-lab/runs/')) {
      // The run finishes after a couple of polls.
      if (current?.status === 'running' && ++polls > 2) current = run('failed')
      return route.fulfill({ json: current })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/test-lab-view.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__test_lab_view__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  return { requests, errors }
}

test('shows what to mount, and nothing else, without Docker', async ({ page }) => {
  const { errors } = await openFixture(page, { docker: false })
  await page.goto('/__test_lab_view__')
  const requirements = page.getByTestId('test-lab-requirements')
  await expect(requirements).toContainText('Test Lab needs Docker')
  await expect(requirements).toContainText('/var/run/docker.sock:/var/run/docker.sock')
  await expect(requirements).toContainText('full control of Docker')
  await expect(requirements).toContainText('connect ENOENT')
  await expect(page.getByTestId('test-lab-form')).toHaveCount(0)
  await expect(page.getByTestId('test-lab-start')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('starts a pinned, capped run, follows it live and shows the report', async ({ page }) => {
  const { requests, errors } = await openFixture(page)
  await page.goto('/__test_lab_view__')
  await expect(page.getByTestId('test-lab-form')).toBeVisible()
  await expect(page.getByTestId('test-lab-model')).toContainText('openrouter/tencent/hy4-flash')
  await expect(page.getByTestId('test-lab-start')).toBeDisabled()
  const option = page.getByTestId('test-lab-app-option').filter({ hasText: 'Vikunja' })
  await option.getByRole('checkbox').click()
  // ALLGlance asks for a git address once ticked.
  await page.getByTestId('test-lab-app-option').filter({ hasText: 'ALLGlance' }).getByRole('checkbox').click()
  await page.getByRole('textbox', { name: 'Git address to build ALLGlance' }).fill('https://github.com/example/allglance.git#main')
  await page.getByTestId('test-lab-instructions').locator('textarea').fill('Check private tasks')
  await page.getByTestId('test-lab-cap').locator('input').fill('0.25')
  await page.getByTestId('test-lab-cap').locator('input').blur()
  await page.getByTestId('test-lab-start').click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/test-lab/runs')?.body).toEqual({
    model: 'openrouter/tencent/hy4-flash', apps: ['vikunja', 'allglance'], instructions: 'Check private tasks', capUsd: 0.25, minutes: 20,
    keepRunning: false, browser: true, builds: { allglance: 'https://github.com/example/allglance.git#main' },
  })
  const detail = page.getByTestId('test-lab-run')
  await expect(page.getByTestId('test-lab-run-status')).toHaveText('Running')
  await expect(page.getByTestId('test-lab-steps')).toContainText('Health checks')
  await expect(detail.getByTestId('test-lab-app')).toContainText('healthy')
  await expect(page.getByTestId('test-lab-stop')).toBeVisible()
  // It finishes on its own: report, cost, screenshots, logs.
  await expect(page.getByTestId('test-lab-run-status')).toHaveText('Failed', { timeout: 10_000 })
  await expect(page.getByTestId('test-lab-summary')).toHaveText('Bob cannot see Alice’s task.')
  await expect(page.getByTestId('test-lab-checks')).toContainText('PASS')
  await expect(page.getByTestId('test-lab-checks')).toContainText('FAIL')
  await expect(page.getByTestId('test-lab-cost')).toContainText('$7.50 before, $7.51 after: $0.0131')
  await expect(page.locator('.lab-shot img')).toHaveCount(1)
  await detail.getByRole('button', { name: 'Log' }).click()
  await expect(detail.locator('.lab-log')).toHaveText('vikunja: started\n')
  await expect(page.getByTestId('test-lab-download')).toBeVisible()
  await expect(page.getByTestId('test-lab-remove')).toHaveCount(0) // already removed
  await expect(page.getByTestId('test-lab-run-item')).toContainText('1 passed, 1 failed')
  expect(errors).toEqual([])
})

test('stops a running run', async ({ page }) => {
  const { requests } = await openFixture(page)
  await page.goto('/__test_lab_view__')
  await page.getByTestId('test-lab-app-option').filter({ hasText: 'nginx' }).getByRole('checkbox').click()
  await page.getByTestId('test-lab-start').click()
  await page.getByTestId('test-lab-stop').click()
  await expect.poll(() => requests.some(r => r.path === '/api/studio/test-lab/runs/20261125-220000-abcd/stop')).toBe(true)
  await expect(page.getByTestId('test-lab-run-status')).toHaveText('Stopped by you')
})
