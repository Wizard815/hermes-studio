import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/** A JWT-shaped token whose payload says super_admin (the client only reads the role). */
const SUPER_ADMIN_TOKEN = `x.${Buffer.from(JSON.stringify({ role: 'super_admin' })).toString('base64url')}.y`

const SKILLS = ['better-interface', 'better-ui', 'interface-review']

function uiSkillsInfo(enabled = true) {
  return {
    enabled, disabledByEnv: false, env: 'STUDIO_UI_SKILLS',
    source: { repo: 'https://github.com/jakubkrehel/skills', author: 'Jakub Krehel', licence: 'MIT', commit: 'x' },
    skills: SKILLS.map(name => ({ name, description: `${name} guide` })),
    targets: [
      { kind: 'hermes', label: 'Hermes profile default', profile: 'default', dir: '/data/.hermes/skills/ui-skills', skills: { 'better-interface': 'installed', 'better-ui': 'removed', 'interface-review': 'installed' } },
      { kind: 'claude-code', label: 'Claude Code', profile: null, dir: '/home/me/.claude/skills', skills: Object.fromEntries(SKILLS.map(name => [name, 'installed'])) },
    ],
  }
}

async function openFixture(page: Page, view: 'skills' | 'mcp' | 'settings') {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const errors: string[] = []
  let info = uiSkillsInfo()
  let servers: Array<{ name: string; raw_config: Record<string, unknown> }> = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(token => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', token); (window as any).__APP_VERSION__ = 'test' }, SUPER_ADMIN_TOKEN)
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() })
    if (url.pathname === '/api/studio/ui-skills') {
      if (request.method() === 'PUT') info = { ...info, enabled: request.postDataJSON().enabled }
      return route.fulfill({ json: request.method() === 'PUT' ? { enabled: info.enabled, disabledByEnv: false } : info })
    }
    if (url.pathname === '/api/hermes/skills') {
      return route.fulfill({ json: { categories: [{ name: 'ui-skills', description: 'UI skills (bundled)', skills: SKILLS.filter(n => n !== 'better-ui').map(name => ({ name, description: `${name} guide`, source: 'local', enabled: true })) }], archived: [] } })
    }
    if (url.pathname === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default', active: true }] } })
    if (url.pathname === '/api/hermes/mcp/servers') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON()
        servers = [...servers, { name: body.name, raw_config: body.config }]
        return route.fulfill({ json: { ok: true, name: body.name } })
      }
      return route.fulfill({ json: { servers } })
    }
    if (url.pathname.endsWith('/mcp/catalog')) return route.fulfill({ json: { entries: [], diagnostics: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/ui-skills.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__ui_skills__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto(`/__ui_skills__?view=${view}`)
  return { requests, errors }
}

test('the Skills page shows the bundled UI skills, their credit and which ones this profile has', async ({ page }) => {
  const { errors } = await openFixture(page, 'skills')
  const card = page.getByTestId('ui-skills-card')
  await expect(card).toContainText('UI skills (bundled)')
  await expect(card.getByRole('status')).toHaveText('2 of 3 installed here.')
  // The Hermes category folder gets its readable name in the list.
  await expect(page.locator('.category-name').first()).toHaveText('UI skills (bundled)')
  await expect(page.getByText('better-interface').first()).toBeVisible()
  const toggle = card.getByRole('button', { name: 'Show skills' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(card.getByRole('button', { name: 'Hide skills' })).toHaveAttribute('aria-expanded', 'true')
  await expect(card).toContainText('By Jakub Krehel, MIT licence.')
  await expect(card.getByRole('link', { name: 'Source on GitHub' })).toHaveAttribute('href', 'https://github.com/jakubkrehel/skills')
  await expect(card.locator('li', { hasText: 'better-ui' })).toContainText('Removed by you')
  await expect(card).toContainText('Folder: /data/.hermes/skills/ui-skills')
  expect(errors).toEqual([])
})

test('Settings can turn the UI skills off', async ({ page }) => {
  const { requests, errors } = await openFixture(page, 'settings')
  const settings = page.getByTestId('ui-skills-settings')
  await expect(settings).toContainText('UI skills for every agent')
  const toggle = settings.getByRole('switch', { name: 'Install on startup' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/ui-skills')?.body).toEqual({ enabled: false })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(errors).toEqual([])
})

test('the MCP catalog offers Paper, adds it with OAuth and opens the sign-in', async ({ page }) => {
  const { requests, errors } = await openFixture(page, 'mcp')
  const card = page.getByTestId('mcp-paper-card')
  await expect(card).toContainText('Paper (paper.design)')
  await expect(card).toContainText('Your designs go to Paper\'s servers, and you need a Paper account.')
  await expect(card).toContainText('https://mcp.paper.design')
  await card.getByRole('button', { name: 'Add and sign in' }).click()
  await expect.poll(() => requests.find(r => r.path === '/api/hermes/mcp/servers')?.body).toEqual({ name: 'paper', config: { url: 'https://mcp.paper.design', auth: 'oauth' } })
  await expect(card).toContainText('Installed')
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(errors).toEqual([])
})
