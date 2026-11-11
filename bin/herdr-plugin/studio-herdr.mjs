#!/usr/bin/env node
// Ekko Studio plugin for herdr. Installed and linked by Studio (herdr settings →
// "Install Studio plugin"); configuration lives in $HERDR_PLUGIN_CONFIG_DIR/studio.json.
//
//   open-in-studio  action: open the focused pane's chat in Studio's web UI
//   chats           popup:  list Studio coding-agent chats, open one as a herdr pane
//   launch          popup:  start an agent with Studio's providers/models (e.g. llama-swap)
//   settings        popup:  choose the Studio profile chats from herdr go to
//   resume <chat>   pane:   run a chat's agent here (agents herdr can run)
//   chat <chat>     pane:   talk to a chat herdr cannot run (Ekko, Hermes) through Studio's chat runs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { createRequire } from 'node:module'

const ICONS = { working: '◐', blocked: '×', done: '✓', idle: '○', unknown: '·' }

function loadConfig() {
  // Chat panes are not plugin commands; Studio gives them the plugin's config folder.
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR || process.env.STUDIO_PLUGIN_CONFIG_DIR || ''
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
    : `${config.browserUrl}/#/herdr${paneId ? `?pane=${encodeURIComponent(paneId)}` : ''}`
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

/** Show a pane: Studio focuses it through herdr's API (the CLI's `pane focus` only moves by direction). */
async function focusPane(config, paneId) {
  try { await api(config, '/focus', { method: 'POST', body: JSON.stringify({ paneId }) }) } catch { /* the chat still opened */ }
}

async function chats() {
  const config = loadConfig()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      // Fit the popup: header and footer take 6 rows.
      const limit = Math.max(5, Math.min(30, (process.stdout.rows || 30) - 6))
      const { chats: list } = await api(config, `/chats?limit=${limit}`)
      process.stdout.write('\x1b[2J\x1b[H')
      process.stdout.write('Studio chats   ◐ working  × blocked  ✓ done  ○ idle\n\n')
      if (!list.length) process.stdout.write('  No coding-agent chats yet.\n')
      list.forEach((chat, index) => {
        const live = chat.herdrPaneId ? `  [live ${chat.herdrPaneId}]` : ''
        const title = String(chat.title || chat.id).slice(0, 48).padEnd(48)
        process.stdout.write(`${String(index + 1).padStart(3)}  ${ICONS[chat.status] || '·'} ${title} ${String(chat.agent).padEnd(12)}${live}\n`)
      })
      process.stdout.write('\n  <n> open in herdr   o <n> link to Studio   l launch agent   s settings   r refresh   q quit\n')
      const answer = await ask(rl, '> ')
      if (!answer || answer === 'q') return
      if (answer === 'r') continue
      if (answer === 'l') { rl.close(); return launch() }
      if (answer === 's') { rl.close(); return settings() }
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
      await focusPane(config, link.paneId)
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
    await focusPane(config, link.paneId)
  } catch (error) {
    await pause(rl, `\nError: ${error.message}`)
  } finally {
    rl.close()
  }
}

async function settings() {
  const config = loadConfig()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const current = await api(config, '/settings')
    process.stdout.write('\x1b[2J\x1b[H')
    process.stdout.write('Studio settings for herdr  (q to close)\n')
    process.stdout.write(`\nChats started in herdr go to the Studio profile: ${current.profile}\n`)
    const profile = await choose(rl, 'Choose a profile:', current.profiles.map(name => ({ label: name === current.profile ? `${name}  (current)` : name, value: name })))
    if (profile === null || profile === current.profile) return
    const saved = await api(config, '/settings', { method: 'PUT', body: JSON.stringify({ profile }) })
    notify('Studio profile for herdr chats', saved.profile)
    await pause(rl, `\nNew chats from herdr will go to "${saved.profile}".`)
  } catch (error) {
    await pause(rl, `\nError: ${error.message}`)
  } finally {
    rl.close()
  }
}

const command = process.argv[2]
/**
 * A chat's waiting pane resumes the chat's agent right here: Studio prepares
 * the agent (its resume command, models, MCP and login), this runs it in the
 * pane and returns when it exits, so the chat waits here again.
 */
async function resume() {
  const config = loadConfig()
  const sessionId = process.argv[3] || ''
  const paneId = process.env.HERDR_PANE_ID || ''
  if (!sessionId || !paneId) throw new Error('resume needs a chat id and a herdr pane')
  process.stdout.write('\x1b[2J\x1b[H  Starting the chat\'s agent…\n')
  const { launch } = await api(config, '/resume', { method: 'POST', body: JSON.stringify({ sessionId, paneId }) })
  const child = spawn(launch.command, launch.args || [], { cwd: launch.cwd || process.cwd(), env: { ...process.env, ...(launch.env || {}) }, stdio: 'inherit' })
  // The terminal's Ctrl-C belongs to the agent, not to this launcher.
  process.on('SIGINT', () => {})
  // Exit 1 only when the agent could not start; however the agent itself ends, the chat waits again.
  const started = await new Promise(resolve => { child.on('exit', () => resolve(true)); child.on('error', error => { process.stderr.write(`${error.message}\n`); resolve(false) }) })
  process.exit(started ? 0 : 1)
}

/** The waiting pane's own command, so herdr brings the chat back after a restart. */
function waitingPaneCommand(sessionId) {
  const keys = ['STUDIO_CHAT_DIR', 'STUDIO_CHAT_KIND', 'STUDIO_CHAT_AGENT', 'STUDIO_CHAT_URL', 'STUDIO_NODE', 'STUDIO_PLUGIN', 'STUDIO_PLUGIN_CONFIG_DIR']
  const script = process.env.STUDIO_CHAT_SCRIPT || ''
  if (!script) return []
  return ['env', ...keys.map(key => `${key}=${process.env[key] || ''}`), 'sh', script, sessionId]
}

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/**
 * A chat herdr cannot run (Ekko, Hermes without its CLI) in a herdr pane:
 * each line is a turn of Studio's own chat run for that chat, so the reply
 * streams here and the chat in Studio shows the same turn. herdr lists the
 * pane as the chat's agent (working, blocked, idle). Ctrl-C stops a reply;
 * Ctrl-D goes back to the chat's card.
 */
async function chat() {
  const config = loadConfig()
  const sessionId = process.argv[3] || ''
  const paneId = process.env.HERDR_PANE_ID || ''
  if (!sessionId || !paneId) throw new Error('chat needs a chat id and a herdr pane')
  const access = await api(config, '/chat', { method: 'POST', body: JSON.stringify({ sessionId, paneId }) })
  const { io } = createRequire(import.meta.url)('socket.io-client')
  const restore = waitingPaneCommand(sessionId)
  const report = state => herdr(['pane', 'report-agent', paneId, '--source', 'studio:chat', '--agent', access.agent, '--state', state, ...(restore.length ? ['--', ...restore] : [])])
  const socket = io(`${config.url}/chat-run`, { auth: { token: access.token }, query: { profile: access.profile }, transports: ['websocket'], reconnection: true })

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  let busy = false
  /** An approval or question waiting for the next line. */
  let waiting = null
  const prompt = () => { rl.setPrompt(waiting ? `${BOLD}answer>${RESET} ` : `${BOLD}>${RESET} `); rl.prompt() }
  const say = text => { process.stdout.write(`\r\x1b[K${text}\n`) }
  const finish = () => { busy = false; report('idle'); prompt() }

  process.stdout.write(`${DIM}${access.agent} · Studio chat. Type a message. Ctrl-C stops a reply, Ctrl-D goes back.${RESET}\n`)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', error => reject(new Error(`Studio refused the chat: ${error.message}`)))
  })
  report('idle')
  socket.on('run.started', () => { busy = true; report('working') })
  socket.on('message.delta', event => { if (event?.delta) process.stdout.write(String(event.delta)) })
  socket.on('tool.started', event => { say(`${DIM}  ⚙ ${event?.tool || event?.name || 'tool'}${event?.preview ? ` ${String(event.preview).slice(0, 100)}` : ''}${RESET}`) })
  socket.on('approval.requested', event => {
    waiting = { kind: 'approval', id: event?.approval_id, choices: Array.isArray(event?.choices) && event.choices.length ? event.choices : ['once', 'deny'] }
    report('blocked')
    say(`\n${BOLD}Approve?${RESET} ${event?.description || event?.title || ''}${event?.command ? `\n  ${event.command}` : ''}\n  ${waiting.choices.join(' / ')}`)
    prompt()
  })
  socket.on('clarify.requested', event => {
    waiting = { kind: 'clarify', id: event?.clarify_id, choices: Array.isArray(event?.choices) ? event.choices : [] }
    report('blocked')
    say(`\n${BOLD}Question:${RESET} ${event?.question || ''}${waiting.choices.length ? `\n  ${waiting.choices.join(' / ')}` : ''}`)
    prompt()
  })
  socket.on('approval.resolved', () => { if (waiting?.kind === 'approval') waiting = null; if (busy) report('working') })
  socket.on('clarify.resolved', () => { if (waiting?.kind === 'clarify') waiting = null; if (busy) report('working') })
  socket.on('run.completed', () => { process.stdout.write('\n'); finish() })
  socket.on('run.failed', event => { say(`\n${BOLD}Failed:${RESET} ${event?.error || 'the run failed'}`); finish() })

  rl.on('SIGINT', () => {
    if (busy) { socket.emit('abort', { session_id: sessionId }); say(`${DIM}  stopping…${RESET}`) } else { rl.close() }
  })
  rl.on('line', line => {
    const text = line.trim()
    if (waiting) {
      const answer = waiting
      waiting = null
      if (answer.kind === 'approval') socket.emit('approval.respond', { session_id: sessionId, approval_id: answer.id, choice: answer.choices.includes(text) ? text : (text.toLowerCase().startsWith('y') ? answer.choices[0] : 'deny') })
      else socket.emit('clarify.respond', { session_id: sessionId, clarify_id: answer.id, response: text })
      return
    }
    if (!text) { prompt(); return }
    if (busy) { say(`${DIM}  still replying; wait for it or press Ctrl-C${RESET}`); return }
    busy = true
    report('working')
    socket.emit('run', { ...access.run, input: text, profile: access.profile })
  })
  prompt()
  await new Promise(resolve => rl.on('close', resolve))
  socket.disconnect()
  process.exit(0)
}

const run = command === 'open-in-studio' ? openInStudio : command === 'chats' ? chats : command === 'launch' ? launch : command === 'settings' ? settings : command === 'resume' ? resume : command === 'chat' ? chat : null
if (!run) {
  process.stderr.write('usage: studio-herdr.mjs open-in-studio|chats|launch|settings|resume <chat>|chat <chat>\n')
  process.exit(2)
}
run().catch(error => {
  process.stderr.write(`${error.message}\n`)
  notify('Studio plugin error', error.message)
  process.exit(1)
})
