import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/** A JWT-shaped token whose payload says super_admin (the client only reads the role). */
const SUPER_ADMIN_TOKEN = `x.${Buffer.from(JSON.stringify({ role: 'super_admin' })).toString('base64url')}.y`

const RECOMMENDED = [{ name: 'markitdown', title: 'MarkItDown', url: 'https://github.com/microsoft/markitdown', description: 'Converts files to Markdown.', licence: 'MIT', config: { command: 'uvx', args: ['markitdown-mcp==0.0.1a8'] }, needs: 'uv on the Hermes host.' }]
const ENTRIES = [
  { name: 'tevonsb/homeassistant-mcp', url: 'https://github.com/tevonsb/homeassistant-mcp', category: 'Home Automation', description: 'Control Home Assistant devices.', official: false, languages: ['TypeScript'], scopes: ['local'], os: [] },
  { name: '77777R7/Octocrawl', url: 'https://github.com/77777R7/Octocrawl', category: 'Browser Automation', description: 'Web scraping into Markdown.', official: true, languages: ['TypeScript'], scopes: ['cloud', 'local'], os: [], install: 'npx -y @octocrawl/mcp', config: { command: 'npx', args: ['-y', '@octocrawl/mcp'] } },
]

async function openFixture(page: Page, view: 'directory' | 'repo-pack' | 'emoji') {
  const requests: Array<{ method: string; path: string; search: string; body: any }> = []
  const errors: string[] = []
  let servers: Array<{ name: string; raw_config: Record<string, unknown> }> = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(token => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', token); (window as any).__APP_VERSION__ = 'test' }, SUPER_ADMIN_TOKEN)
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    requests.push({ method: request.method(), path: url.pathname, search: url.search, body: request.method() === 'GET' ? null : request.postDataJSON() })
    if (url.pathname === '/api/hermes/mcp/directory') {
      const q = url.searchParams.get('q') || ''
      const entries = ENTRIES.filter(entry => !q || entry.description.toLowerCase().includes(q.toLowerCase()))
      return route.fulfill({ json: { source: { repo: 'https://github.com/punkpeye/awesome-mcp-servers', licence: 'MIT' }, fetchedAt: '2026-11-27T00:00:00Z', recommended: RECOMMENDED, categories: [{ name: 'Home Automation', count: 1 }, { name: 'Browser Automation', count: 1 }], total: entries.length, entries } })
    }
    if (url.pathname === '/api/hermes/mcp/servers') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON()
        servers = [...servers, { name: body.name, raw_config: body.config }]
        return route.fulfill({ json: { ok: true, name: body.name } })
      }
      return route.fulfill({ json: { servers } })
    }
    if (url.pathname === '/api/studio/repo-pack/repos') return route.fulfill({ json: { connected: true, repos: [{ fullName: 'Wizard815/argos', private: true, description: '', pushedAt: '', defaultBranch: 'main' }] } })
    if (url.pathname === '/api/studio/repo-pack') return route.fulfill({ json: { name: 'Wizard815_argos.repomix.md', content: '# Directory Structure\n', bytes: 22, repo: 'Wizard815/argos' } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/homelab-tools.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__homelab_tools__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto(`/__homelab_tools__?view=${view}`)
  return { requests, errors }
}

test('the MCP directory adds a recommended server after showing what it runs', async ({ page }) => {
  const { requests, errors } = await openFixture(page, 'directory')
  const card = page.getByTestId('mcp-recommended-markitdown')
  await expect(card).toContainText('uvx markitdown-mcp==0.0.1a8')
  await card.getByRole('button', { name: 'Add' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Add MarkItDown')
  await expect(dialog).not.toContainText('Nobody has reviewed this server')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect.poll(() => requests.find(r => r.method === 'POST' && r.path === '/api/hermes/mcp/servers')?.body).toEqual({ name: 'markitdown', config: { command: 'uvx', args: ['markitdown-mcp==0.0.1a8'] } })
  await expect(card).toContainText('Added')
  expect(errors).toEqual([])
})

test('the MCP directory searches the community list, warns before adding one, and hands others to Hermes', async ({ page }) => {
  const { requests, errors } = await openFixture(page, 'directory')
  await expect(page.getByRole('status')).toContainText('Showing 2 of 2')
  await page.getByRole('textbox', { name: 'Search MCP servers' }).fill('scraping')
  await expect.poll(() => requests.some(r => r.search.includes('q=scraping'))).toBe(true)
  await expect(page.getByTestId('mcp-directory-entry')).toHaveCount(1)
  const crawl = page.getByTestId('mcp-directory-entry').first()
  await expect(crawl).toContainText('Official')
  await crawl.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('dialog')).toContainText('Nobody has reviewed this server')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await crawl.getByRole('button', { name: 'Set up with Hermes' }).click()
  await expect(page.getByTestId('route')).toContainText('/hermes/chat?compose=')
  expect(errors).toEqual([])
})

test('Add a repo packs one of your GitHub repos and attaches the Markdown file', async ({ page }) => {
  const { requests, errors } = await openFixture(page, 'repo-pack')
  await page.getByRole('button', { name: 'Add a repo' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Your GitHub repos')
  await dialog.getByRole('textbox', { name: 'Repo', exact: true }).fill('Wizard815/argos')
  await dialog.getByRole('textbox', { name: 'Only these files (optional)' }).fill('cmd/**')
  await dialog.getByRole('button', { name: 'Pack and attach' }).click()
  await expect.poll(() => requests.find(r => r.path === '/api/studio/repo-pack')?.body).toEqual({ repo: 'Wizard815/argos', include: 'cmd/**', compress: true })
  await expect(page.getByTestId('attached')).toHaveText('Wizard815_argos.repomix.md text/markdown 22')
  expect(errors).toEqual([])
})

test('an emoji reply says what it means and offers Explain and Continue', async ({ page }) => {
  const { errors } = await openFixture(page, 'emoji')
  const card = page.getByTestId('emoji-reply')
  await expect(card).toContainText('Done, but there is a problem to know about')
  await card.getByRole('button', { name: 'Explain' }).click()
  await card.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByTestId('attached')).toHaveText('sent explain\nsent continue')
  expect(errors).toEqual([])
})
