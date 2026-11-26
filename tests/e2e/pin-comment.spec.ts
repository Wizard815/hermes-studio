import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Pin comments: open a screenshot in the chat, click a spot, write a comment,
// and it is sent to the chat as "Comment on <file> (pinned at x% ..., y% ...): text".
const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const session = { id: 'chat-1', title: 'UI review', profile: 'default', source: 'web', agent: 'hermes', model: 'fixture-model', started_at: 1, last_active: 1, message_count: 1 }
const history = [{ id: 1, role: 'assistant', content: 'Here is the screen:\n\n![](/api/hermes/files/17-projects-marked-in-chats.png)', timestamp: 1 }]
const png = readFileSync(resolve('packages/client/public/logo-original.png'))

test('Pin comments: a spot on a chat screenshot becomes a comment in the chat', async ({ page }) => {
  const errors: string[] = []
  const frames: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.addInitScript(tok => {
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_active_profile_name', 'default')
    localStorage.setItem('hermes_api_key', tok)
  }, token)
  await page.routeWebSocket('**/socket.io/**', ws => {
    ws.send('0' + JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 60000, pingTimeout: 60000 }))
    ws.onMessage(raw => {
      const value = String(raw)
      if (value.startsWith('40')) ws.send(value.split(',')[0] + ',' + JSON.stringify({ sid: 'fixture' }))
      if (!value.startsWith('42')) return
      frames.push(value)
      const start = value.indexOf('['), [event, data] = JSON.parse(value.slice(start))
      if (event === 'resume') ws.send(value.slice(0, start) + JSON.stringify(['resumed', { session_id: data.session_id, messages: history, isWorking: false, queueLength: 0, events: [], workspace: '/srv', model: 'fixture-model' }]))
    })
  })
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/studio/files/download') return route.fulfill({ contentType: 'image/png', body: png })
    let json: unknown = {}
    if (path === '/health') json = { status: 'ok' }
    else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
    else if (path === '/api/hermes/available-models') {
      const groups = [{ provider: 'fixture', label: 'Fixture', base_url: '', api_key: 'fixture', models: ['fixture-model'] }]
      json = { groups, allProviders: groups, profiles: [], default: 'fixture-model', default_provider: 'fixture' }
    }
    else if (path === '/api/studio/projects') json = { projects: [] }
    else if (path.startsWith('/api/studio/projects/for-session/')) json = { project: null }
    else if (path === '/api/studio/sessions') json = { sessions: url.searchParams.get('source') === 'global_agent' ? [] : [session] }
    else if (path === '/api/studio/session-categories') json = { categories: [] }
    else if (path.endsWith('/messages/paginated')) json = { session, messages: history, total: 1, offset: 0, limit: 150, hasMore: false, taskPlans: [], workspaceRunChanges: [] }
    else if (path.startsWith('/api/studio/sessions/')) json = { session: { ...session, messages: history } }
    await route.fulfill({ json })
  })

  await page.goto('/#/hermes/session/chat-1')
  const shot = page.locator('.markdown-body img').first()
  await expect(shot).toBeVisible({ timeout: 30_000 })
  await shot.click()

  // Comment mode: a click pins a spot instead of closing the picture.
  await page.getByTestId('image-preview-comment').click()
  const picture = page.locator('.image-preview-img')
  const box = (await picture.boundingBox())!
  await page.mouse.click(box.x + box.width * 0.09, box.y + box.height * 0.25)
  const popover = page.getByTestId('pin-comment-popover')
  await expect(popover).toBeVisible()
  await popover.locator('textarea').fill('test')
  await page.screenshot({ path: process.env.PIN_SHOT || test.info().outputPath('pin.png') })
  await popover.getByTestId('pin-comment-send').click()

  await expect.poll(() => frames.some(frame => frame.includes('Comment on 17-projects-marked-in-chats.png (pinned at 9% from the left, 25% from the top): test'))).toBe(true)
  await expect(popover).toHaveCount(0)
  await expect(page.locator('.pin-comment-mark--sent')).toHaveText('1')
  await expect(page.locator('.image-preview-status')).toHaveText('Comment sent to the chat')
  // Escape closes the picture.
  await page.keyboard.press('Escape')
  await expect(picture).toHaveCount(0)
  expect(errors).toEqual([])
})
