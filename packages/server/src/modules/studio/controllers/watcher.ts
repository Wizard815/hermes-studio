import type { Context } from 'koa'
import { getWatcher } from '../services/watcher'
import { getAgentWork } from '../services/agent-work'
import { TASK_APPROVAL_MODES, type TaskApprovalMode } from '../../../../../shared/watcher'

/** The Watcher (docs/watcher.md): the bell's feed, Settings → Watcher, trust rules and a task's approval mode. */
async function respond(ctx: Context, work: () => unknown | Promise<unknown>) {
  try {
    if (ctx.state.sessionShare) ctx.throw(403, 'Studio login required')
    ctx.body = await work()
  } catch (error: any) {
    ctx.status = error.status || 400
    ctx.body = { error: error.message }
  }
}

function ids(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, 1000)
}

export const listEvents = (ctx: Context) => respond(ctx, () => getWatcher().list({
  limit: Number(ctx.query.limit) || 50,
  unreadOnly: ctx.query.unread === '1' || ctx.query.unread === 'true',
  before: Number(ctx.query.before) || undefined,
}))

/** `{ ids: [1, 2] }` marks those read; `{ all: true }` marks every alert read. */
export const markRead = (ctx: Context) => respond(ctx, () => {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (body.all === true) return getWatcher().markAllRead()
  const list = ids(body.ids)
  if (!list?.length) throw Object.assign(new Error('Say which alerts (ids) or all: true'), { status: 400 })
  return getWatcher().markRead(list)
})

/** `{ ids: [1] }` removes those; `{}` clears the whole history. */
export const clearEvents = (ctx: Context) => respond(ctx, () => {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  return getWatcher().clear(ids(body.ids))
})

export const getSettings = (ctx: Context) => respond(ctx, async () => ({
  settings: getWatcher().settings(),
  extras: await getWatcher().extras(),
}))

export const saveSettings = (ctx: Context) => respond(ctx, async () => {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const settings = getWatcher().saveSettings(body.settings ?? body)
  return { settings, extras: await getWatcher().extras() }
})

export const listRules = (ctx: Context) => respond(ctx, () => ({ rules: getWatcher().rules() }))

export const addRule = (ctx: Context) => respond(ctx, () => {
  const rule = getWatcher().addRule(ctx.request.body, ctx.state.user?.username || '')
  return { rule, rules: getWatcher().rules() }
})

export const removeRule = (ctx: Context) => respond(ctx, () => {
  if (!getWatcher().removeRule(String(ctx.params.id || ''))) throw Object.assign(new Error('No such trust rule'), { status: 404 })
  return { rules: getWatcher().rules() }
})

/** An Agent work task's approval mode: its chat's own mode (the one `/yolo` sets); inherit follows the agent's. */
function taskChat(ctx: Context): string {
  const { work } = getAgentWork().get(String(ctx.params.id || ''))
  if (!work.sessionId) throw Object.assign(new Error('This task has no chat yet; its agent asks as Settings says'), { status: 409 })
  return work.sessionId
}

export const getTaskMode = (ctx: Context) => respond(ctx, () => {
  const sessionId = taskChat(ctx)
  return { sessionId, mode: (getWatcher().chatMode(sessionId) || 'inherit') as TaskApprovalMode }
})

export const setTaskMode = (ctx: Context) => respond(ctx, () => {
  const sessionId = taskChat(ctx)
  const mode = String((ctx.request.body as any)?.mode || '') as TaskApprovalMode
  if (!(TASK_APPROVAL_MODES as readonly string[]).includes(mode)) throw Object.assign(new Error('mode must be inherit, ask, guarded or auto'), { status: 400 })
  getWatcher().setChatMode(sessionId, mode === 'inherit' ? null : mode)
  return { sessionId, mode }
})
