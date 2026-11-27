import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { join } from 'node:path'

// The chat's terminal panel against a stand-in terminal socket: the rail comes back
// from "restored", shell output that starts with "{" still shows, typed "{" goes as an
// input frame, a dropped socket reconnects quietly, and the context menu stays on
// screen. packages/server/src/modules/hermes/sockets/terminal.ts is the real server.
const shotDir = process.env.TERMINAL_SHOTS || ''
const token = `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture`
const session = { id: 'chat-1', title: 'Terminal', profile: 'default', source: 'web', agent: 'hermes', model: 'fixture-model', started_at: 1, last_active: 1, message_count: 1 }
const history = [{ id: 1, role: 'assistant', content: 'The terminal is in the tools panel.', timestamp: 1 }]
const PROMPT = '\x1b[32mwizard@hermes\x1b[0m:\x1b[34m~/studio\x1b[0m$ '

async function shot(page: Page, name: string) {
  await page.screenshot({ path: shotDir ? join(shotDir, name) : test.info().outputPath(name) })
}

async function standIn(page: Page) {
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
      const start = value.indexOf('['), [event, data] = JSON.parse(value.slice(start))
      if (event === 'resume') ws.send(value.slice(0, start) + JSON.stringify(['resumed', { session_id: data.session_id, messages: history, isWorking: false, queueLength: 0, events: [], workspace: '/srv', model: 'fixture-model' }]))
    })
  })
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
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
}

test('Terminal panel: restores, shows JSON output, sends typed "{" as input, and reconnects quietly', async ({ page }) => {
  const received: string[] = []
  let terminal: WebSocketRoute | null = null
  let connections = 0
  await page.routeWebSocket('**/api/hermes/terminal**', ws => {
    connections++
    terminal = ws
    let line = ''
    ws.onMessage(raw => {
      const value = String(raw)
      received.push(value)
      let typed = value
      if (value.startsWith('{')) {
        const frame = JSON.parse(value)
        if (frame.type !== 'input') return
        typed = frame.data
      }
      for (const ch of typed) {
        if (ch === '\r') {
          ws.send('\r\n')
          // Output that starts with "{": a JSON object, and text that is not JSON.
          if (line === 'cat status.json') ws.send('{"ok":true,"jobs":2}')
          if (line === 'cat package.json') ws.send('{\r\n  "name": "hermes-studio",\r\n  "private": true\r\n}')
          ws.send('\r\n' + PROMPT)
          line = ''
        } else {
          line += ch
          ws.send(ch)
        }
      }
    })
    ws.send(JSON.stringify({
      type: 'restored', activeSessionId: 'hermes_chat_2', sessions: [
        { id: 'hermes_chat_1', shell: 'bash', pid: 11, exited: false, scrollback: PROMPT },
        { id: 'hermes_chat_2', shell: 'bash', pid: 12, exited: false, scrollback: `${PROMPT}git status --short\r\n M packages/client/src/components/hermes/chat/TerminalPanel.vue\r\n${PROMPT}` },
      ],
    }))
  })
  await standIn(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1400, height: 860 })

  await page.goto('/#/hermes/session/chat-1')
  await page.locator('.header-tool-toggle').click()
  await page.getByRole('tab', { name: 'Terminal' }).click()

  const rail = page.locator('.terminal-session-rail')
  await expect(rail.locator('.terminal-session-number')).toHaveText(['1', '2'])
  await expect(rail.locator('.terminal-session-slot.active .terminal-session-number')).toHaveText('2')
  await expect(rail.getByRole('button', { name: /^Theme: / })).toBeVisible()
  const screen = page.locator('.terminal-xterm .xterm-rows')
  await expect(screen).toContainText('TerminalPanel.vue')

  await page.locator('.terminal-xterm').click()
  await page.keyboard.type('cat status.json')
  await page.keyboard.press('Enter')
  await page.keyboard.type('cat package.json')
  await page.keyboard.press('Enter')
  await page.keyboard.type('{}')
  await expect(screen).toContainText('{"ok":true,"jobs":2}')
  await expect(screen).toContainText('"name": "hermes-studio",')
  // "{" went as an input frame, never as raw text the server could take for a control.
  await expect(screen).toContainText('$ {}')
  expect(received).toContain(JSON.stringify({ type: 'input', data: '{' }))
  expect(received).not.toContain('{')
  expect(received.filter(frame => frame.startsWith('{')).every(frame => ['input', 'switch', 'resize'].includes(JSON.parse(frame).type))).toBe(true)
  await shot(page, 'terminal-panel.png')

  // The context menu stays on screen next to the right edge.
  const box = (await page.locator('.terminal-xterm').boundingBox())!
  await page.mouse.click(box.x + box.width - 3, box.y + box.height - 3, { button: 'right' })
  const menu = page.locator('.terminal-context-menu')
  await expect(menu).toBeVisible()
  const menuBox = (await menu.boundingBox())!
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1400)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(860)
  await shot(page, 'terminal-menu.png')
  await page.keyboard.press('Escape')

  // A dropped socket: a quiet "Reconnecting…" over the pane, then the same pane back.
  await terminal!.close({ code: 1011 })
  await expect(page.getByTestId('terminal-reconnecting')).toBeVisible()
  await shot(page, 'terminal-reconnecting.png')
  await expect.poll(() => connections, { timeout: 10_000 }).toBe(2)
  await expect(page.getByTestId('terminal-reconnecting')).toBeHidden()
  await expect(screen).toContainText('cat package.json')
  expect(errors).toEqual([])
})
