import type { Context } from 'koa'
import { herdrManager, HERDR_INTEGRATIONS } from '../services/herdr/manager'
import { herdrKindForStudioAgent } from '../services/herdr/protocol'
import { HERDR_PLUGIN_TOKEN_HEADER } from '../services/herdr/plugin'
import type { HerdrWorkRef } from '../services/herdr/bridge'

function fail(ctx: Context, error: unknown, fallback: string) {
  const err = error as { status?: number; message?: string; code?: string }
  ctx.status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500
  ctx.body = { error: err?.message || fallback, ...(err?.code ? { code: err.code } : {}) }
}

/**
 * The address a browser used to reach Studio (its tunnel or LAN address), so
 * apps that link into Studio, like Pondering Orb, need no extra setup. Only
 * browser requests count (they carry Sec-Fetch headers); Orb's own server
 * calls Studio on an internal address.
 */
function browserOrigin(ctx: Context): string {
  if (!ctx.get('sec-fetch-mode')) return ''
  const host = (ctx.get('x-forwarded-host') || ctx.get('host')).split(',')[0].trim()
  const proto = (ctx.get('x-forwarded-proto') || ctx.protocol || 'http').split(',')[0].trim()
  if (!/^[A-Za-z0-9.-]+(:\d+)?$|^\[[0-9a-fA-F:]+\](:\d+)?$/.test(host) || !/^https?$/.test(proto)) return ''
  return `${proto}://${host}`
}

export async function status(ctx: Context) {
  try {
    herdrManager.noteBrowserOrigin(browserOrigin(ctx))
    herdrManager.noteUser(ctx.state.user)
    ctx.body = { ...(await herdrManager.status()), integrations: HERDR_INTEGRATIONS }
  } catch (error) { fail(ctx, error, 'Failed to read herdr status') }
}

export async function updateSettings(ctx: Context) {
  try {
    const settings = await herdrManager.updateSettings((ctx.request.body || {}) as any)
    ctx.body = { settings }
  } catch (error) { fail(ctx, error, 'Failed to save herdr settings') }
}

export async function updateWelcome(ctx: Context) {
  try {
    const show = (ctx.request.body as { show?: unknown } | undefined)?.show
    if (typeof show !== 'boolean') throw Object.assign(new Error('show must be true or false'), { status: 400 })
    ctx.body = { welcome: await herdrManager.setWelcome(show) }
  } catch (error) { fail(ctx, error, 'Failed to change herdr\'s welcome screen') }
}

export async function startServer(ctx: Context) {
  try {
    ctx.body = await herdrManager.startServer()
  } catch (error) { fail(ctx, error, 'Failed to start herdr') }
}

export async function installIntegrations(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { kinds?: unknown }
    const kinds = Array.isArray(body.kinds) ? body.kinds.map(String) : [...HERDR_INTEGRATIONS]
    ctx.body = { results: await herdrManager.installIntegrations(kinds) }
  } catch (error) { fail(ctx, error, 'Failed to install herdr integrations') }
}

export async function openSession(ctx: Context) {
  try {
    herdrManager.noteUser(ctx.state.user)
    ctx.body = { link: await herdrManager.requireBridge().openSession(String(ctx.params.sessionId || '')) }
  } catch (error) { fail(ctx, error, 'Failed to open chat in herdr') }
}

export async function promptSession(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { text?: unknown }
    ctx.body = await herdrManager.requireBridge().promptSession(String(ctx.params.sessionId || ''), String(body.text ?? ''))
  } catch (error) { fail(ctx, error, 'Failed to send message to herdr') }
}

export async function closeSessionPane(ctx: Context) {
  try {
    ctx.body = { closed: await herdrManager.requireBridge().closeSessionPane(String(ctx.params.sessionId || '')) }
  } catch (error) { fail(ctx, error, 'Failed to close herdr pane') }
}

export async function sessionLink(ctx: Context) {
  const link = herdrManager.getBridge()?.linkFor(String(ctx.params.sessionId || '')) ?? null
  ctx.body = { link }
}

/** The Pondering Orb task or project an agent is for, marked in progress once it works. */
function orbRef(input: any): HerdrWorkRef | undefined {
  const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max)
  if (input?.task?.title) return { orb: { task: { title: text(input.task.title, 300), list: text(input.task.list, 120) } } }
  if (input?.project) return { orb: { project: text(input.project, 120) } }
  return undefined
}

export async function launchAgent(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { agentId?: unknown; provider?: unknown; model?: unknown; workspace?: unknown; title?: unknown; prompt?: unknown; orb?: any }
    const agentId = String(body.agentId || '')
    if (!herdrKindForStudioAgent(agentId)) throw Object.assign(new Error('This agent cannot run in herdr'), { status: 400 })
    herdrManager.noteUser(ctx.state.user)
    ctx.body = {
      link: await herdrManager.requireBridge().launchAgent(agentId, {
        provider: body.provider ? String(body.provider) : undefined,
        model: body.model ? String(body.model) : undefined,
        workspace: body.workspace ? String(body.workspace) : undefined,
        title: body.title ? String(body.title) : undefined,
        prompt: body.prompt ? String(body.prompt).slice(0, 20000) : undefined,
        onWorking: orbRef(body.orb),
      }),
    }
  } catch (error) { fail(ctx, error, 'Failed to launch agent in herdr') }
}

export async function focusPane(ctx: Context) {
  try {
    await herdrManager.requireBridge().focusPane(String(ctx.params.paneId || ''))
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to focus herdr pane') }
}

export async function installPlugin(ctx: Context) {
  try {
    ctx.body = await herdrManager.installPlugin()
  } catch (error) { fail(ctx, error, 'Failed to install the Studio plugin into herdr') }
}

// --- Routes called by the Studio plugin running inside herdr (own token, loopback only) ---

function isLoopback(ctx: Context): boolean {
  const values = [ctx.ip, ctx.req.socket.remoteAddress].map(value => String(value || '').replace(/^::ffff:/, ''))
  return values.some(value => value === '::1' || value.startsWith('127.'))
}

export async function requirePluginToken(ctx: Context, next: () => Promise<unknown>) {
  const provided = String(ctx.get(HERDR_PLUGIN_TOKEN_HEADER) || '')
  if (!isLoopback(ctx) || !(await herdrManager.verifyPluginToken(provided))) {
    ctx.status = 401
    ctx.body = { error: 'Invalid Studio plugin token' }
    return
  }
  await next()
}

export async function pluginChats(ctx: Context) {
  try {
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 30, 1), 100)
    const bridge = herdrManager.getBridge()
    ctx.body = {
      chats: herdrManager.getPluginDeps().listChats(limit).map(chat => {
        const link = bridge?.linkFor(chat.id)
        return { ...chat, status: link?.status || 'idle', herdrPaneId: link?.paneId || null }
      }),
    }
  } catch (error) { fail(ctx, error, 'Failed to list chats') }
}

export async function pluginLink(ctx: Context) {
  const paneId = String(ctx.query.pane || '')
  const pane = herdrManager.getBridge()?.getState().panes.find(entry => entry.pane_id === paneId)
  ctx.body = { sessionId: pane?.studioSessionId ?? null }
}

export async function pluginAgents(ctx: Context) {
  try {
    const deps = herdrManager.getPluginDeps()
    const [agents, providers] = await Promise.all([
      deps.listAgents(),
      deps.listProviders(herdrManager.getSettings().profile || 'default').catch(() => []),
    ])
    ctx.body = { agents: agents.filter(agent => herdrKindForStudioAgent(agent.id)), providers }
  } catch (error) { fail(ctx, error, 'Failed to list agents') }
}

export async function pluginOpen(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { sessionId?: unknown }
    ctx.body = { link: await herdrManager.requireBridge().openSession(String(body.sessionId || '')) }
  } catch (error) { fail(ctx, error, 'Failed to open chat in herdr') }
}

export async function installHerdr(ctx: Context) {
  try {
    ctx.body = await herdrManager.installHerdr()
  } catch (error) { fail(ctx, error, 'Failed to install herdr') }
}

export async function setupHerdr(ctx: Context) {
  try {
    ctx.body = await herdrManager.setup()
  } catch (error) { fail(ctx, error, 'Failed to set up herdr') }
}

export async function profiles(ctx: Context) {
  try {
    ctx.body = { profiles: herdrManager.getPluginDeps().listProfiles() }
  } catch (error) { fail(ctx, error, 'Failed to list profiles') }
}

/** herdr-side settings: which Studio profile herdr chats belong to. */
export async function pluginSettings(ctx: Context) {
  try {
    const settings = herdrManager.getSettings()
    ctx.body = { profile: settings.profile, autoImport: settings.autoImport, profiles: herdrManager.getPluginDeps().listProfiles() }
  } catch (error) { fail(ctx, error, 'Failed to read settings') }
}

export async function updatePluginSettings(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { profile?: unknown; autoImport?: unknown }
    const patch: { profile?: string; autoImport?: boolean } = {}
    if (body.profile !== undefined) {
      const profile = String(body.profile)
      if (!herdrManager.getPluginDeps().listProfiles().includes(profile)) throw Object.assign(new Error(`Profile "${profile}" does not exist`), { status: 400 })
      patch.profile = profile
    }
    if (typeof body.autoImport === 'boolean') patch.autoImport = body.autoImport
    const settings = await herdrManager.updateSettings(patch)
    ctx.body = { profile: settings.profile, autoImport: settings.autoImport }
  } catch (error) { fail(ctx, error, 'Failed to save settings') }
}

export async function getFolders(ctx: Context) {
  try { ctx.body = await herdrManager.folders().load() } catch (error) { fail(ctx, error, 'Failed to read space folders') }
}

export async function saveFolders(ctx: Context) {
  try { ctx.body = await herdrManager.folders().save(ctx.request.body || {}) } catch (error) { fail(ctx, error, 'Failed to save space folders') }
}

export async function createWorkspace(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { cwd?: unknown; label?: unknown }
    const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
    if (cwd && !cwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(cwd)) throw Object.assign(new Error('Folder must be an absolute path'), { status: 400 })
    ctx.body = await herdrManager.requireBridge().createWorkspace({ cwd: cwd || undefined, label: typeof body.label === 'string' ? body.label.trim() : undefined })
  } catch (error) { fail(ctx, error, 'Failed to create space') }
}
