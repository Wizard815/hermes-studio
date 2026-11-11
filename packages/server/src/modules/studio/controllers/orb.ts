import type { Context } from 'koa'
import { getOrbClient, OrbError } from '../services/orb/client'
import { getOrbWork } from '../services/orb/work'

function fail(ctx: Context, error: unknown) {
  ctx.status = error instanceof OrbError ? error.status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

export async function status(ctx: Context) {
  try { ctx.body = await getOrbClient().status() } catch (error) { fail(ctx, error) }
}

export async function saveSettings(ctx: Context) {
  try { ctx.body = await getOrbClient().save((ctx.request.body || {}) as any) } catch (error) { fail(ctx, error) }
}

export async function data(ctx: Context) {
  try { ctx.body = { kind: ctx.params.kind, data: await getOrbClient().data(String(ctx.params.kind)) } } catch (error) { fail(ctx, error) }
}

export async function tool(ctx: Context) {
  try {
    const args = (ctx.request.body || {}) as Record<string, unknown>
    ctx.body = { result: await getOrbClient().tool(String(ctx.params.name), args && typeof args === 'object' ? args : {}) }
  } catch (error) { fail(ctx, error) }
}

function bearerToken(ctx: Context): string {
  return ctx.get('authorization').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
}

/** Orb sends a task or project to Studio: a new chat with that agent and the plan as its first message. */
export async function startWork(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const work = await getOrbWork().start({
      token: bearerToken(ctx),
      profile: typeof body.profile === 'string' ? body.profile : ctx.state.profile?.name,
      agentId: body.agentId,
      title: body.title,
      prompt: body.prompt,
      workspace: body.workspace,
      orb: body.orb,
    })
    ctx.body = { work }
  } catch (error) {
    const status = Number((error as { status?: number })?.status)
    ctx.status = status >= 400 && status < 600 ? status : 500
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}

/** The chats working on Orb tasks and projects, with their state. */
export async function listWork(ctx: Context) {
  try { ctx.body = { work: await getOrbWork().list() } } catch (error) { fail(ctx, error) }
}
