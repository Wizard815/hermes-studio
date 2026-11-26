import type { Context } from 'koa'
import { getOmi } from '../services/omi'

function fail(ctx: Context, error: unknown) {
  const status = Number((error as { status?: number })?.status)
  ctx.status = status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

const body = (ctx: Context) => ((ctx.request as { body?: unknown }).body || {}) as Record<string, unknown>

export async function status(ctx: Context) {
  try { ctx.body = await getOmi().status() } catch (error) { fail(ctx, error) }
}

export async function saveSettings(ctx: Context) {
  try { ctx.body = await getOmi().saveSettings(body(ctx)) } catch (error) { fail(ctx, error) }
}

export async function test(ctx: Context) {
  try { ctx.body = await getOmi().test() } catch (error) { fail(ctx, error) }
}

/** A new Studio key for Omi. The key is in this answer only. */
export async function createKey(ctx: Context) {
  try {
    ctx.status = 201
    ctx.body = await getOmi().createKey(Number(ctx.state.user?.id), body(ctx).name)
  } catch (error) { fail(ctx, error) }
}

export async function revokeKey(ctx: Context) {
  try { ctx.body = await getOmi().revokeKey(String(ctx.params.id)) } catch (error) { fail(ctx, error) }
}

/** Register (or replace) Omi's results webhook. The secret is in this answer only. */
export async function registerWebhook(ctx: Context) {
  try { ctx.body = await getOmi().registerWebhook() } catch (error) { fail(ctx, error) }
}

export async function removeWebhook(ctx: Context) {
  try { ctx.body = await getOmi().removeWebhook() } catch (error) { fail(ctx, error) }
}

export async function installSkill(ctx: Context) {
  try { ctx.body = await getOmi().installSkill(body(ctx).profile) } catch (error) { fail(ctx, error) }
}

/** Omi starts a work chat (with Omi's key, or an admin's login). */
export async function startWork(ctx: Context) {
  try {
    const b = body(ctx)
    ctx.body = {
      work: await getOmi().startWork({
        userId: Number(ctx.state.user?.id),
        profile: typeof b.profile === 'string' && b.profile ? ctx.state.profile?.name : undefined,
        body: b,
      }),
    }
  } catch (error) { fail(ctx, error) }
}

export async function listWork(ctx: Context) {
  try { ctx.body = { work: await getOmi().listWork() } } catch (error) { fail(ctx, error) }
}

export async function approvals(ctx: Context) {
  try { ctx.body = { approvals: await getOmi().approvals() } } catch (error) { fail(ctx, error) }
}
