import type { Context } from 'koa'
import { vscodeGateway, vscodeManager } from '../services/vscode'

function userToken(ctx: Context): string {
  return ctx.get('Authorization').replace(/^Bearer /, '')
}

export async function status(ctx: Context) {
  ctx.body = vscodeManager.status()
}

/** Installs code-server in the background; poll status to follow it. */
export async function install(ctx: Context) {
  const current = vscodeManager.status()
  if (current.problem && !current.available) {
    ctx.status = 409
    ctx.body = { error: current.problem }
    return
  }
  if (!current.available && !current.installing) void vscodeManager.install().catch(() => {})
  ctx.status = 202
  ctx.body = vscodeManager.status()
}

/** A link to VS Code for the signed-in super administrator; starts VS Code. */
export async function openSession(ctx: Context) {
  if (!vscodeManager.status().available) {
    ctx.status = 409
    ctx.body = { error: 'VS Code is not installed' }
    return
  }
  try {
    const ticket = await vscodeGateway.create(userToken(ctx))
    await vscodeManager.ensureRunning()
    ctx.body = ticket
  } catch (error: any) {
    ctx.status = error?.status || 503
    ctx.body = { error: error?.message || String(error) }
  }
}

export async function closeSession(ctx: Context) {
  vscodeGateway.remove(ctx.params.id, userToken(ctx))
  ctx.status = 204
}

export async function stop(ctx: Context) {
  vscodeManager.stop()
  ctx.body = vscodeManager.status()
}
