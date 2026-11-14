import type { Context } from 'koa'
import { ScreenGateway } from '../services/screen/gateway'
import { screenGateway, screenManager } from '../services/screen'
import { viewerHash } from '../services/screen/manager'

function fail(ctx: Context, error: any) {
  ctx.status = Number(error?.status) >= 400 ? Number(error.status) : 500
  ctx.body = { error: error?.message || String(error) }
}

function userToken(ctx: Context): string {
  return ctx.get('Authorization').replace(/^Bearer /, '')
}

function viewerOf(ctx: Context): string {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const clientId = String(body.clientId || ctx.query.clientId || '')
  return ScreenGateway.viewerId(ctx.state.user?.id ?? 'user', clientId)
}

/** Status, plus whether this viewer holds control. */
export async function status(ctx: Context) {
  try {
    const current = await screenManager.status()
    const hash = viewerHash(viewerOf(ctx))
    ctx.body = { ...current, youHaveControl: current.lease?.holder === 'human' && current.lease?.viewer_hash === hash }
  } catch (error) { fail(ctx, error) }
}

export async function install(ctx: Context) {
  void screenManager.install().catch(() => undefined)
  ctx.status = 202
  ctx.body = await screenManager.status()
}

export async function start(ctx: Context) {
  try { await screenManager.start(); ctx.body = await screenManager.status() } catch (error) { fail(ctx, error) }
}

export async function stop(ctx: Context) {
  try { await screenManager.stop((ctx.request.body as any)?.force === true); ctx.body = await screenManager.status() } catch (error) { fail(ctx, error) }
}

/** A single-use ticket for the live view (noVNC's websocket cannot send headers). */
export async function ticket(ctx: Context) {
  ctx.body = { ticket: screenGateway.createTicket(viewerOf(ctx), userToken(ctx)) }
}

/** take | release | force: take control, hand it back, or clear a stuck hold. */
export async function control(ctx: Context) {
  try {
    const action = String((ctx.request.body as any)?.action || '')
    if (!['take', 'release', 'force'].includes(action)) { ctx.status = 400; ctx.body = { error: 'action must be take, release or force' }; return }
    const viewer = viewerOf(ctx)
    const lease = await screenManager.lease(action as 'take' | 'release' | 'force', viewer, String((ctx.request.body as any)?.reason || ''))
    ctx.body = { lease, youHaveControl: lease.holder === 'human' && lease.viewer_hash === viewerHash(viewer) }
  } catch (error) { fail(ctx, error) }
}

/** An agent's browser action (sent by Studio's browser tools). */
export async function recordActivity(ctx: Context) {
  const { browserActivity, cleanActivity } = await import('../services/screen/activity')
  const entry = cleanActivity((ctx.request.body || {}) as Record<string, unknown>, ctx.state.runBinding || {})
  if (!entry) { ctx.status = 400; ctx.body = { error: 'kind and summary are required' }; return }
  browserActivity.add(entry)
  ctx.status = 204
}

/** Recent browser activity, optionally for one chat. */
export async function listActivity(ctx: Context) {
  const { browserActivity } = await import('../services/screen/activity')
  const sessionId = typeof ctx.query.sessionId === 'string' && ctx.query.sessionId ? ctx.query.sessionId : undefined
  ctx.body = { activity: browserActivity.list({ limit: Number(ctx.query.limit) || 100, sessionId }) }
}
