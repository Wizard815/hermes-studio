#!/usr/bin/env node
// Ekko Studio plugin for herdr. Installed and linked by Studio (herdr settings →
// "Install Studio plugin"); configuration lives in $HERDR_PLUGIN_CONFIG_DIR/studio.json.
//
//   open-in-studio  action: open the focused pane's chat in Studio's web UI
//   chats           popup:  list Studio coding-agent chats, open one as a herdr pane
//   launch          popup:  start an agent with Studio's providers/models (e.g. llama-swap)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const ICONS = { working: '◐', blocked: '×', done: '✓', idle: '○', unknown: '·' }

function loadConfig() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR || ''
  try {
    const config = JSON.parse(readFileSync(join(dir, 'studio.json'), 'utf8'))
    if (!config.url || !config.token) throw new Error('incomplete')
    return { url: String(config.url).replace(/\/+$/, ''), browserUrl: String(config.browserUrl || config.url).replace(/\/+$/, ''), token: String(config.token) }
  } catch {
    throw new Error('Studio plugin is not configured. In Studio open herdr → Settings → "Install Studio plugin".')
  }
}

async function api(config, path, init = {}) {
  const response = await fetch(`${config.url}/api/coding-agents/herdr/plugin${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-studio-herdr-token': config.token, ...(init.headers || {}) },
  })
  const text = await response.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { error: text } }
  if (!response.ok) throw new Error(body.error || `Studio returned ${response.status}`)
  return body
}

function context() {
  try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}') } catch { return {} }
}

function currentPaneId() {
  const ctx = context()
  return ctx.focused_pane_id || process.env.HERDR_PANE_ID || ''
}

function herdr(args) {
  const bin = process.env.HERDR_BIN_PATH || 'herdr'
  return spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function notify(title, body) {
  herdr(['notification', 'show', title, ...(body ? ['--body', body] : [])])
}

/** Opens on this machine when it has a desktop; over SSH the link is shown instead. */
function openUrl(url) {
  const local = process.platform === 'darwin' || process.platform === 'win32' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY
  if (!local || process.env.SSH_CONNECTION) return false
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

async function openInStudio() {
  const config = loadConfig()
  const paneId = currentPaneId()
  const { sessionId } = paneId ? await api(config, `/link?pane=${encodeURIComponent(paneId)}`) : { sessionId: null }
  const url = sessionId
    ? `${config.browserUrl}/#/hermes/session/${encodeURIComponent(sessionId)}`
    : `${config.browserUrl}/#/herdr?tab=agents${paneId ? `&pane=${encodeURIComponent(paneId)}` : ''}`
  const opened = openUrl(url)
  notify(opened ? 'Opened in Studio' : 'Studio link', url)
  process.stdout.write(`${url}\n`)
}

/** Closed input (Esc closing the popup, EOF) reads as "q". */
async function ask(rl, prompt) {
  try {
    return (await rl.question(prompt)).trim()
  } catch {
    return 'q'
  }
}

async function pause(rl, message) {
  process.stdout.write(`${message}\n`)
  await ask(rl, 'Press Enter to close.')
}

async function chats() {
  const config = loadConfig()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const { chats: list } = await api(config, '/chats?limit=30')
      process.stdout.write('\x1b[2J\x1b[H')
      process.stdout.write('Studio chats   ◐ working  × blocked  ✓ done  ○ idle\n\n')
      if (!list.length) process.stdout.write('  No coding-agent chats yet.\n')
      list.forEach((chat, index) => {
        const live = chat.herdrPaneId ? `  [live ${chat.herdrPaneId}]` : ''
        const title = String(chat.title || chat.id).slice(0, 48).padEnd(48)
        process.stdout.write(`${String(index + 1).padStart(3)}  ${ICONS[chat.status] || '·'} ${title} ${String(chat.agent).padEnd(12)}${live}\n`)
      })
      process.stdout.write('\n  <n> open in herdr   o <n> link to Studio   l launch agent   r refresh   q quit\n')
      const answer = await ask(rl, '> ')
      if (!answer || answer === 'q') return
      if (answer === 'r') continue
      if (answer === 'l') { rl.close(); return launch() }
      const browser = answer.startsWith('o ')
      const index = Number.parseInt(browser ? answer.slice(2) : answer, 10) - 1
      const chat = list[index]
      if (!chat) continue
      if (browser) {
        const url = `${config.browserUrl}/#/hermes/session/${encodeURIComponent(chat.id)}`
        openUrl(url)
        await pause(rl, `\n${url}\n(Ctrl-click the link to open it in your browser.)`)
        return
      }
      const { link } = await api(config, '/open', { method: 'POST', body: JSON.stringify({ sessionId: chat.id }) })
      herdr(['pane', 'focus', link.paneId])
      return
    }
  } catch (error) {
    await pause(rl, `\nError: ${error.message}`)
  } finally {
    rl.close()
  }
}

async function choose(rl, title, options) {
  process.stdout.write(`\n${title}\n`)
  options.forEach((option, index) => process.stdout.write(`${String(index + 1).padStart(3)}  ${option.label}\n`))
  for (;;) {
    const answer = await ask(rl, '> ')
    if (answer === 'q') return null
    const option = options[Number.parseInt(answer || '1', 10) - 1]
    if (option) return option.value
  }
}

async function launch() {
  const config = loadConfig()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const { agents, providers } = await api(config, '/agents')
    process.stdout.write('\x1b[2J\x1b[H')
    process.stdout.write('Start an agent with Studio\'s MCP servers, skills and models.  q to cancel\n')
    if (!agents.length) return void await pause(rl, '\nNo herdr-compatible agents are installed in Studio.')
    const agentId = await choose(rl, 'Agent:', agents.map(agent => ({ label: agent.name, value: agent.id })))
    if (!agentId) return
    const provider = await choose(rl, 'Provider:', [
      { label: 'Agent\'s own configuration', value: '' },
      ...providers.map(group => ({ label: `${group.label} (${group.models.length} models)`, value: group.provider })),
    ])
    if (provider === null) return
    let model
    if (provider) {
      const models = providers.find(group => group.provider === provider)?.models || []
      model = await choose(rl, 'Model:', models.map(id => ({ label: id, value: id })))
      if (model === null) return
    }
    const ctx = context()
    const defaultCwd = ctx.focused_pane_cwd || ctx.workspace_cwd || ''
    const workspace = await ask(rl, `\nFolder [${defaultCwd || 'Studio default'}]: `) || defaultCwd
    const { link } = await api(config, '/launch', {
      method: 'POST',
      body: JSON.stringify({ agentId, provider: provider || undefined, model, workspace: workspace || undefined }),
    })
    herdr(['pane', 'focus', link.paneId])
  } catch (error) {
    await pause(rl, `\nError: ${error.message}`)
  } finally {
    rl.close()
  }
}

const command = process.argv[2]
const run = command === 'open-in-studio' ? openInStudio : command === 'chats' ? chats : command === 'launch' ? launch : null
if (!run) {
  process.stderr.write('usage: studio-herdr.mjs open-in-studio|chats|launch\n')
  process.exit(2)
}
run().catch(error => {
  process.stderr.write(`${error.message}\n`)
  notify('Studio plugin error', error.message)
  process.exit(1)
})
