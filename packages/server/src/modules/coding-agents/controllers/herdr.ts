import type { Context } from 'koa'
import { herdrManager, HERDR_INTEGRATIONS } from '../services/herdr/manager'
import { herdrKindForStudioAgent } from '../services/herdr/protocol'
import { HERDR_PLUGIN_TOKEN_HEADER } from '../services/herdr/plugin'

function fail(ctx: Context, error: unknown, fallback: string) {
  const err = error as { status?: number; message?: string; code?: string }
  ctx.status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500
  ctx.body = { error: err?.message || fallback, ...(err?.code ? { code: err.code } : {}) }
}

export async function status(ctx: Context) {
  try {
    ctx.body = { ...(await herdrManager.status()), integrations: HERDR_INTEGRATIONS }
  } catch (error) { fail(ctx, error, 'Failed to read herdr status') }
}

export async function updateSettings(ctx: Context) {
  try {
    const settings = await herdrManager.updateSettings((ctx.request.body || {}) as any)
    ctx.body = { settings }
  } catch (error) { fail(ctx, error, 'Failed to save herdr settings') }
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

export async function launchAgent(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { agentId?: unknown; provider?: unknown; model?: unknown; workspace?: unknown; title?: unknown }
    const agentId = String(body.agentId || '')
    if (!herdrKindForStudioAgent(agentId)) throw Object.assign(new Error('This agent cannot run in herdr'), { status: 400 })
    ctx.body = {
      link: await herdrManager.requireBridge().launchAgent(agentId, {
        provider: body.provider ? String(body.provider) : undefined,
        model: body.model ? String(body.model) : undefined,
        workspace: body.workspace ? String(body.workspace) : undefined,
        title: body.title ? String(body.title) : undefined,
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
