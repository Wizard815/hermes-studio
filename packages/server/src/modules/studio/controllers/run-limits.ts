import type { Context } from 'koa'
import { getRunLimits } from '../services/run-limits'
import { controlledSession } from '../services/sessions/control'
import { LIMIT_FIELDS, type RunLimits } from '../../../../../shared/run-limits'

/** Run limits (docs/agent-limits.md): Settings' limits and each chat's own. */
async function respond(ctx: Context, work: () => unknown | Promise<unknown>) {
  try {
    if (ctx.state.sessionShare) ctx.throw(403, 'Studio login required')
    ctx.body = await work()
  } catch (error: any) { ctx.status = error.status || 400; ctx.body = { error: error.message } }
}

function chat(ctx: Context): string {
  const id = String(ctx.params.id || '')
  controlledSession(ctx.state.user, ctx.state.profile?.name || 'default', id)
  return id
}

const FIELDS = new Set<string>(Object.values(LIMIT_FIELDS))

export const getDefaults = (ctx: Context) => respond(ctx, () => ({ defaults: getRunLimits().defaults() }))

export const saveDefaults = (ctx: Context) => respond(ctx, () => {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  return { defaults: getRunLimits().saveDefaults(body.defaults ?? body) }
})

export const getChat = (ctx: Context) => respond(ctx, () => getRunLimits().describe(chat(ctx)))

/** `{ limits: { costUsd: 2, tokens: null }, clear: ['minutes'], reset: false }`: null turns a limit off for the chat, clear follows Settings again. */
export const saveChat = (ctx: Context) => respond(ctx, () => {
  const id = chat(ctx)
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const clear = Array.isArray(body.clear) ? body.clear.filter(field => FIELDS.has(String(field))) as Array<keyof RunLimits> : []
  getRunLimits().saveChatLimits(id, body.limits ?? {}, { reset: body.reset === true, clear })
  return getRunLimits().describe(id)
})

export const continueChat = (ctx: Context) => respond(ctx, () => {
  const id = chat(ctx)
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const result = getRunLimits().continueWithHigherLimit(id, body.value)
  return { ...getRunLimits().describe(id), raised: result.raised || null }
})

export const stopChat = (ctx: Context) => respond(ctx, () => {
  const id = chat(ctx)
  getRunLimits().dismiss(id)
  return getRunLimits().describe(id)
})
