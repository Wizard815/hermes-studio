import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function openFixture(page: Page, hash: string) {
  const posts: string[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); (window as any).__APP_VERSION__ = 'test' })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET') posts.push(url.pathname)
    let json: any = {}
    if (url.pathname === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (url.pathname === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true, model: '', alias: '' }] }
    else if (url.pathname === '/api/studio/session-categories') json = { categories: [] }
    else if (url.pathname === '/api/studio/workspace/directories') json = { directories: [] }
    else if (url.pathname === '/api/agents/availability') json = { revision: 1, updatedAt: '', agents: [] }
    else if (url.pathname === '/api/studio/sessions/context-length') json = { context_length: 0 }
    return route.fulfill({ json })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/compose-link.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__compose_link__*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__compose_link__' + hash)
  return { posts, errors }
}

const composer = (page: Page) => page.locator('.new-chat-compose textarea')

test('a compose link opens a new chat with the shared text, unsent, and drops it from the address', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const text = 'Omi: call Sam about the invoice & a+b #tag'
  const { posts, errors } = await openFixture(page, '#/hermes/chat?compose=' + encodeURIComponent(text))
  await expect(composer(page)).toHaveValue(text)
  await expect.poll(() => page.evaluate(() => (window as any).composeLinkFixture.route())).toBe('/hermes/chat')
  expect(await page.evaluate(() => (window as any).composeLinkFixture.sent)).toEqual([])
  expect(posts).toEqual([])
  expect(errors).toEqual([])
})

test('a second share while Studio is open replaces the new-chat text', async ({ page }) => {
  const { errors } = await openFixture(page, '#/hermes/chat?compose=first')
  await expect(composer(page)).toHaveValue('first')
  await page.evaluate(() => { location.hash = '#/hermes/chat?compose=' + encodeURIComponent('second share') })
  await expect(composer(page)).toHaveValue('second share')
  expect(errors).toEqual([])
})
