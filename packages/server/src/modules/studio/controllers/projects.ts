import type { Context } from 'koa'
import { projectService } from '../services/projects/service'

function fail(ctx: Context, error: unknown) {
  const status = Number((error as { status?: number })?.status)
  ctx.status = status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

export const PROJECT_ACTIONS = ['list', 'start_thread', 'message_thread', 'read_thread', 'resolve_thread', 'set_pr', 'add_task', 'update_task', 'start_task']

const body = (ctx: Context) => ((ctx.request as any).body || {}) as Record<string, any>
const param = (ctx: Context, name: string) => String((ctx.params as Record<string, string>)[name] || '')

export async function list(ctx: Context) {
  try { ctx.body = { projects: await projectService().list() } } catch (error) { fail(ctx, error) }
}

export async function get(ctx: Context) {
  try { ctx.body = { project: await projectService().get(param(ctx, 'id')) } } catch (error) { fail(ctx, error) }
}

export async function forSession(ctx: Context) {
  try { ctx.body = await projectService().forSession(param(ctx, 'sessionId')) ?? { project: null, role: null } } catch (error) { fail(ctx, error) }
}

export async function create(ctx: Context) {
  try {
    const input = body(ctx)
    ctx.status = 201
    ctx.body = { project: await projectService().create({ ...input, userId: ctx.state.user?.id ?? null }) }
  } catch (error) { fail(ctx, error) }
}

export async function update(ctx: Context) {
  try { ctx.body = { project: await projectService().update(param(ctx, 'id'), body(ctx)) } } catch (error) { fail(ctx, error) }
}

export async function remove(ctx: Context) {
  try { ctx.body = await projectService().remove(param(ctx, 'id')) } catch (error) { fail(ctx, error) }
}

export async function startThread(ctx: Context) {
  try {
    ctx.status = 201
    ctx.body = { thread: await projectService().startThread(param(ctx, 'id'), body(ctx)) }
  } catch (error) { fail(ctx, error) }
}

export async function messageThread(ctx: Context) {
  try { ctx.body = await projectService().messageThread(param(ctx, 'id'), param(ctx, 'threadId'), body(ctx).text) } catch (error) { fail(ctx, error) }
}

export async function readThread(ctx: Context) {
  try { ctx.body = await projectService().readThread(param(ctx, 'id'), param(ctx, 'threadId'), Number(ctx.query.limit) || 6) } catch (error) { fail(ctx, error) }
}

export async function resolveThread(ctx: Context) {
  try { ctx.body = { thread: await projectService().setResolved(param(ctx, 'id'), param(ctx, 'threadId'), body(ctx).resolved !== false) } } catch (error) { fail(ctx, error) }
}

export async function releaseThread(ctx: Context) {
  try { ctx.body = await projectService().releaseChat(param(ctx, 'id'), param(ctx, 'threadId')) } catch (error) { fail(ctx, error) }
}

export async function adoptChat(ctx: Context) {
  try {
    ctx.status = 201
    ctx.body = { thread: await projectService().adoptChat(param(ctx, 'id'), String(body(ctx).sessionId || '')) }
  } catch (error) { fail(ctx, error) }
}

export async function addTask(ctx: Context) {
  try {
    ctx.status = 201
    ctx.body = { task: await projectService().addTask(param(ctx, 'id'), body(ctx)) }
  } catch (error) { fail(ctx, error) }
}

export async function updateTask(ctx: Context) {
  try { ctx.body = { task: await projectService().updateTask(param(ctx, 'id'), param(ctx, 'taskId'), body(ctx)) } } catch (error) { fail(ctx, error) }
}

export async function removeTask(ctx: Context) {
  try { ctx.body = await projectService().removeTask(param(ctx, 'id'), param(ctx, 'taskId')) } catch (error) { fail(ctx, error) }
}

export async function startTask(ctx: Context) {
  try {
    ctx.status = 201
    ctx.body = await projectService().startTask(param(ctx, 'id'), param(ctx, 'taskId'), body(ctx))
  } catch (error) { fail(ctx, error) }
}

export async function setThreadPr(ctx: Context) {
  try { ctx.body = { thread: await projectService().setThreadPr(param(ctx, 'id'), param(ctx, 'threadId'), body(ctx).pr) } } catch (error) { fail(ctx, error) }
}

/**
 * One entry point for the coordinator's agent tool (ekko_studio_use_project).
 * The project is named, or found from the calling chat (HERMES_STUDIO_SESSION_ID).
 */
export async function tool(ctx: Context) {
  try {
    const input = body(ctx)
    const service = projectService()
    const sessionId = String(input.sessionId || '')
    const named = String(input.project || '')
    const project = named ? await service.get(named) : (await service.forSession(sessionId))?.project
    if (!project) throw Object.assign(new Error('Name the project (arguments.project): this chat is not in a project'), { status: 400 })
    const action = param(ctx, 'action')
    const threadId = String(input.thread || '')
    switch (action) {
      case 'list':
        ctx.body = { project }
        return
      case 'start_thread':
        ctx.body = { thread: await service.startThread(project.id, input) }
        return
      case 'message_thread':
        ctx.body = await service.messageThread(project.id, threadId, input.text)
        return
      case 'read_thread':
        ctx.body = await service.readThread(project.id, threadId, Number(input.limit) || 6)
        return
      case 'resolve_thread':
        ctx.body = { thread: await service.setResolved(project.id, threadId, input.resolved !== false) }
        return
      case 'set_pr':
        ctx.body = { thread: await service.setThreadPr(project.id, threadId, input.pr) }
        return
      case 'add_task':
        ctx.body = { task: await service.addTask(project.id, input) }
        return
      case 'update_task':
        ctx.body = { task: await service.updateTask(project.id, String(input.task || ''), input) }
        return
      case 'start_task':
        ctx.body = await service.startTask(project.id, String(input.task || ''), input)
        return
      default:
        throw Object.assign(new Error(`Unknown project action: ${action}. Use ${PROJECT_ACTIONS.join(', ')}.`), { status: 400 })
    }
  } catch (error) { fail(ctx, error) }
}
