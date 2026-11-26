import type { Context } from 'koa'
import { projectService } from '../services/projects/service'
import { peerService, type PeerService } from '../services/projects/peers'

/** Studio-to-Studio federation for projects (docs/projects.md#federation). */
const peers = () => peerService(projectService)

function fail(ctx: Context, error: unknown) {
  const status = Number((error as { status?: number })?.status)
  ctx.status = status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

const body = (ctx: Context) => ((ctx.request as any).body || {}) as Record<string, any>
const param = (ctx: Context, name: string) => String((ctx.params as Record<string, string>)[name] || '')

export async function list(ctx: Context) {
  try { ctx.body = { self: await peers().self(), peers: await peers().list() } } catch (error) { fail(ctx, error) }
}

export async function createCode(ctx: Context) {
  try { ctx.status = 201; ctx.body = await peers().createCode() } catch (error) { fail(ctx, error) }
}

export async function pair(ctx: Context) {
  try { ctx.status = 201; ctx.body = { peer: await peers().pair(body(ctx)) } } catch (error) { fail(ctx, error) }
}

export async function update(ctx: Context) {
  try { ctx.body = { peer: await peers().update(param(ctx, 'peerId'), body(ctx)) } } catch (error) { fail(ctx, error) }
}

export async function remove(ctx: Context) {
  try { ctx.body = await peers().remove(param(ctx, 'peerId')) } catch (error) { fail(ctx, error) }
}

export async function remoteProjects(ctx: Context) {
  try { ctx.body = { projects: await peers().remoteProjects(param(ctx, 'peerId')) } } catch (error) { fail(ctx, error) }
}

export async function remoteMessage(ctx: Context) {
  try { ctx.body = await peers().remoteMessage(param(ctx, 'peerId'), param(ctx, 'projectId'), body(ctx).text) } catch (error) { fail(ctx, error) }
}

export async function remoteTask(ctx: Context) {
  try { ctx.status = 201; ctx.body = await peers().remoteTask(param(ctx, 'peerId'), param(ctx, 'projectId'), body(ctx)) } catch (error) { fail(ctx, error) }
}

/** Requests from other Studios: no login, the sender's device signature is checked instead. */
export function federationHandler(service: () => Pick<PeerService, 'handle'>) {
  return async (ctx: Context) => {
    const raw = (ctx.request as any).rawBody
    const reply = await service().handle({
      method: ctx.method,
      path: ctx.path,
      headers: ctx.headers,
      rawBody: typeof raw === 'string' ? raw : '',
    })
    ctx.status = reply.status
    ctx.body = reply.body
  }
}

export const federation = federationHandler(peers)
