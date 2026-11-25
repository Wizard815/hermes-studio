import type { Context } from 'koa'
import { getToolLoad } from '../services/tool-load'
import { controlledSession } from '../services/sessions/control'

/** Too many tools for a small model (docs/hermes-tool-load.md): the threshold, and a chat's notice. */
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

export const getSettings = (ctx: Context) => respond(ctx, () => ({ settings: getToolLoad().settings() }))

export const saveSettings = (ctx: Context) => respond(ctx, () => {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  return { settings: getToolLoad().saveSettings(body.settings ?? body) }
})

export const getChat = (ctx: Context) => respond(ctx, () => ({ notice: getToolLoad().notice(chat(ctx)) }))

export const dismissChat = (ctx: Context) => respond(ctx, () => ({ notice: getToolLoad().dismiss(chat(ctx)) }))
