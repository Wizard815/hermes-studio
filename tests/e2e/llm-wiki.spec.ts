import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/** A JWT-shaped token whose payload says super_admin (the client only reads the role). */
const SUPER_ADMIN_TOKEN = `x.${Buffer.from(JSON.stringify({ role: 'super_admin' })).toString('base64url')}.y`

type Profile = { profile: string; enabled: boolean; url: string; hasToken: boolean; recall: boolean; remember: boolean; provider: string; previousProvider: string; installed: boolean }

async function openFixture(page: Page, view: 'connections' | 'mcp') {
  const requests: Array<{ method: string; path: string; body: any }> = []
  const errors: string[] = []
  const profiles: Profile[] = [
    { profile: 'default', enabled: false, url: '', hasToken: false, recall: true, remember: true, provider: '', previousProvider: '', installed: false },
    { profile: 'sam', enabled: false, url: '', hasToken: false, recall: true, remember: true, provider: 'honcho', previousProvider: '', installed: false },
  ]
  let servers: Array<{ name: string; raw_config: Record<string, unknown> }> = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(token => { localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', token) }, SUPER_ADMIN_TOKEN)
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.method() === 'GET' ? null : request.postDataJSON()
    if (request.method() !== 'GET') requests.push({ method: request.method(), path: url.pathname, body })
    if (url.pathname === '/api/studio/llm-wiki') return route.fulfill({ json: { profiles, tokenEnv: 'LLM_WIKI_TOKEN' } })
    const match = /^\/api\/studio\/llm-wiki\/profiles\/([^/]+)(\/test)?$/.exec(url.pathname)
    if (match) {
      const item = profiles.find(row => row.profile === decodeURIComponent(match[1]))!
      if (match[2]) {
        return route.fulfill({ json: body.token === 'llmw_wrong' || (!body.token && !item.hasToken)
          ? { ok: false, identity: null, view: 'unknown', error: 'The wiki refused this token. Make a new one with family-setup.mjs token <id> and paste it again.' }
          : { ok: true, identity: { name: 'Sam', kind: 'member', id: 'sam' }, view: 'own', error: '' } })
      }
      if (body.url !== undefined) item.url = body.url
      if (body.token) item.hasToken = true
      if (body.clearToken) item.hasToken = false
      if (typeof body.recall === 'boolean') item.recall = body.recall
      if (typeof body.remember === 'boolean') item.remember = body.remember
      if (body.enabled === true) { item.previousProvider = item.provider; item.provider = 'llm_wiki'; item.enabled = true; item.installed = true }
      if (body.enabled === false) { item.provider = item.previousProvider; item.previousProvider = ''; item.enabled = false }
      return route.fulfill({ json: item })
    }
    if (url.pathname === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default', active: true }, { name: 'sam', active: false }] } })
    if (url.pathname === '/api/hermes/mcp/servers') {
      if (request.method() === 'POST') {
        servers = [...servers, { name: body.name, raw_config: body.config }]
        return route.fulfill({ json: { ok: true, name: body.name } })
      }
      return route.fulfill({ json: { servers } })
    }
    if (url.pathname === '/api/hermes/mcp/servers/llm-wiki/test') {
      return route.fulfill({ json: { ok: true, tools: ['whoami', 'context_for', 'notes_search', 'query_wiki', 'memory_log', 'memory_rollover'] } })
    }
    if (url.pathname.endsWith('/mcp/catalog')) return route.fulfill({ json: { entries: [], diagnostics: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/llm-wiki.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__llm_wiki__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto(`/__llm_wiki__?view=${view}`)
  return { requests, errors, profiles }
}

test('Connections → LLM wiki: token per profile never shown again, test, turn on, back off', async ({ page }) => {
  const { requests, errors, profiles } = await openFixture(page, 'connections')
  await expect(page.getByTestId('llm-wiki-profile-default')).toContainText('Not set up')
  await page.getByTestId('llm-wiki-profile-sam').click()
  await expect(page.getByTestId('llm-wiki-profile-sam')).toHaveAttribute('aria-current', 'true')
  await expect(page.getByTestId('llm-wiki-editor')).toContainText('Profile sam')
  await expect(page.getByTestId('llm-wiki-enabled')).toHaveClass(/n-switch--disabled/)

  await page.getByTestId('llm-wiki-url').locator('input').fill('http://wiki.lan:27123')
  await page.getByTestId('llm-wiki-token').locator('input').fill('llmw_wrong')
  await page.getByTestId('llm-wiki-test').click()
  await expect(page.getByTestId('llm-wiki-test-result')).toContainText('Not connected: The wiki refused this token')

  await page.getByTestId('llm-wiki-token').locator('input').fill('llmw_sam_token')
  await page.getByTestId('llm-wiki-test').click()
  await expect(page.getByTestId('llm-wiki-test-result')).toHaveText("Connected as Sam (member). Hermes sees this person's own notes and the household's.")
  await page.getByTestId('llm-wiki-save').click()
  await expect.poll(() => profiles[1].hasToken).toBe(true)
  // The token is gone from the form; the field now says it is kept in the profile's .env.
  await expect(page.getByTestId('llm-wiki-token').locator('input')).toHaveValue('')
  await expect(page.getByTestId('llm-wiki-token').locator('input')).toHaveAttribute('placeholder', 'Saved. Paste a new one to replace it')
  await expect(page.getByTestId('llm-wiki-editor')).toContainText('LLM_WIKI_TOKEN')
  expect(requests.find(r => r.path === '/api/studio/llm-wiki/profiles/sam' && r.method === 'PUT')?.body).toEqual({ url: 'http://wiki.lan:27123', token: 'llmw_sam_token' })

  await expect(page.getByTestId('llm-wiki-editor')).toContainText('This profile uses honcho now')
  await page.getByTestId('llm-wiki-enabled').click()
  await expect(page.getByTestId('llm-wiki-state')).toHaveText('On')
  await expect(page.getByTestId('llm-wiki-editor')).toContainText('Replaces honcho')
  await expect(page.getByTestId('llm-wiki-profile-sam')).toContainText('On')
  await page.getByTestId('llm-wiki-recall').click()
  await expect.poll(() => profiles[1].recall).toBe(false)
  await page.getByTestId('llm-wiki-enabled').click()
  await expect(page.getByTestId('llm-wiki-state')).toHaveText('Ready, off')
  expect(profiles[1].provider).toBe('honcho')
  expect(JSON.stringify(await page.content())).not.toContain('llmw_sam_token')

  await page.getByTestId('llm-wiki-open-mcp').click()
  await expect.poll(() => page.evaluate(() => (window as any).llmWikiFixture.route())).toBe('/hermes/mcp?tab=catalog')
  expect(errors).toEqual([])
})

test("MCP page: the LLM wiki card adds /family-mcp with the token in the profile's .env", async ({ page }) => {
  const { requests, errors } = await openFixture(page, 'mcp')
  const card = page.getByTestId('mcp-home-llm-wiki')
  await expect(card).toContainText('LLM wiki (Obsidian)')
  await expect(card).toContainText('Per-person token')
  await page.getByTestId('mcp-home-connect-llm-wiki').click()
  await page.getByTestId('llm-wiki-mcp-address').locator('input').fill('wiki.lan')
  await page.getByTestId('llm-wiki-mcp-token').locator('input').fill('two words')
  await page.getByTestId('mcp-home-submit').click()
  await expect(page.getByText('Paste a wiki token: one word, usually starting with llmw_.')).toBeVisible()
  await page.getByTestId('llm-wiki-mcp-token').locator('input').fill('llmw_sam_token')
  await page.getByTestId('mcp-home-submit').click()
  await expect(page.getByText("Studio leaves out memory_rollover, the admin's daily filing job.")).toBeVisible()
  expect(requests.find(r => r.path === '/api/hermes/mcp/servers')?.body).toEqual({
    name: 'llm-wiki',
    config: {
      url: 'http://wiki.lan:27123/family-mcp',
      headers: { Authorization: 'Bearer ${MCP_LLM_WIKI_API_KEY}' },
      timeout: 120,
      connect_timeout: 30,
      tools: { exclude: ['memory_rollover'], resources: false, prompts: false },
    },
    secrets: { MCP_LLM_WIKI_API_KEY: 'llmw_sam_token' },
  })
  await expect(page.getByTestId('llm-wiki-mcp-token').locator('input')).toHaveValue('')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(card).toContainText('Installed')
  expect(errors).toEqual([])
})
