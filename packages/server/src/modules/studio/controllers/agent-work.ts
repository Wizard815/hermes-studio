import type { Context } from 'koa'
import { getAgentWork } from '../services/agent-work'
import { logger } from '../public/logging'

function fail(ctx: Context, error: unknown) {
  const status = Number((error as { status?: number })?.status)
  ctx.status = status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

const body = (ctx: Context) => ((ctx.request as any).body || {}) as Record<string, any>
const actor = (ctx: Context) => String(ctx.state.user?.username || '')

export async function list(ctx: Context) {
  try {
    const status = String(ctx.query.status || '').split(',').map(s => s.trim()).filter(Boolean)
    const service = getAgentWork()
    ctx.body = { work: service.list({ status, limit: Number(ctx.query.limit) || undefined }), ...service.summary() }
  } catch (error) { fail(ctx, error) }
}

export async function summary(ctx: Context) {
  try { ctx.body = getAgentWork().summary() } catch (error) { fail(ctx, error) }
}

export async function get(ctx: Context) {
  try { ctx.body = getAgentWork().get(String(ctx.params.id)) } catch (error) { fail(ctx, error) }
}

export async function activity(ctx: Context) {
  try { ctx.body = { activity: getAgentWork().store.activity({ limit: Number(ctx.query.limit) || 100 }) } } catch (error) { fail(ctx, error) }
}

export async function create(ctx: Context) {
  // An agent's run credential names its chat: work it reports is linked to that chat.
  try { ctx.status = 201; ctx.body = { work: await getAgentWork().create(body(ctx), actor(ctx), ctx.state.runBinding || {}) } } catch (error) { fail(ctx, error) }
}

export async function remove(ctx: Context) {
  try { ctx.body = getAgentWork().remove(String(ctx.params.id)) } catch (error) { fail(ctx, error) }
}

export async function setStatus(ctx: Context) {
  try { ctx.body = { work: await getAgentWork().setStatus(String(ctx.params.id), body(ctx), actor(ctx)) } } catch (error) { fail(ctx, error) }
}

/**
 * Approve or reject from Studio, or from Pondering Orb (Orb signs in to Studio
 * and says via: "orb"). Deciding twice is not an error: the answer says it was
 * already decided and where.
 */
function decide(decision: 'approve' | 'reject') {
  return async (ctx: Context) => {
    try {
      const b = body(ctx)
      const via = b.via === 'orb' ? 'orb' : 'studio'
      const by = String(b.by || actor(ctx)).slice(0, 80)
      ctx.body = await getAgentWork().decide(String(ctx.params.id), decision, via, by)
    } catch (error) { fail(ctx, error) }
  }
}
export const approve = decide('approve')
export const reject = decide('reject')

export async function getSettings(ctx: Context) {
  try { ctx.body = await getAgentWork().publicSettings() } catch (error) { fail(ctx, error) }
}

export async function saveSettings(ctx: Context) {
  try { ctx.body = await getAgentWork().saveSettings(body(ctx)) } catch (error) { fail(ctx, error) }
}

export async function digest(ctx: Context) {
  try { ctx.body = { day: ctx.query.day || null, markdown: getAgentWork().digest(ctx.query.day ? String(ctx.query.day) : undefined) } } catch (error) { fail(ctx, error) }
}

export async function writeDigest(ctx: Context) {
  try { ctx.body = await getAgentWork().writeDigest(body(ctx).day ? String(body(ctx).day) : undefined) } catch (error) { fail(ctx, error) }
}

/** Mattermost's Approve / Reject buttons. No Studio sign-in: the post carries a per-item secret. */
export async function mattermostAction(ctx: Context) {
  try {
    ctx.body = await getAgentWork().mattermostAction(body(ctx))
  } catch (error) {
    logger.warn({ err: error }, '[agent-work] Mattermost action refused')
    // Mattermost shows ephemeral_text to the person who clicked.
    ctx.status = 200
    ctx.body = { ephemeral_text: error instanceof Error ? error.message : String(error) }
  }
}
