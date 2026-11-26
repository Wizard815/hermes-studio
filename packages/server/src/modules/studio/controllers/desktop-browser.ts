import { createHash } from 'node:crypto'
import type { Context } from 'koa'
import { desktopBrowserRelays } from '../services/browser/desktop-relay'
import { screenBrowser } from '../services/screen-browser'

export async function requestDesktopBrowser(ctx: Context): Promise<void> {
  const user = ctx.state.user
  // Server-token and anonymous requests cannot inherit another user's desktop.
  if (!user) { ctx.status = 403; ctx.body = { error: 'Desktop browser requires an identified Studio user' }; return }
  try {
    if (!ctx.request.body || typeof ctx.request.body !== 'object' || Array.isArray(ctx.request.body)) throw new Error('Browser request body must be an object')
    const input = ctx.request.body as Record<string, unknown>
    if (typeof input.client_id !== 'string' || !input.client_id || input.client_id.length > 200) throw new Error('Browser MCP client_id is required')
    // A per-turn token/context pins a run; legacy profile JWTs conservatively pin
    // the MCP process for its lifetime. Never trust a raw client id across users.
    const binding = createHash('sha256').update(JSON.stringify([ctx.get('authorization'), ctx.get('x-studio-run-context'), input.client_id])).digest('hex')
    const profile = ctx.state.profile?.name || 'default'
    // Without a Desktop app for this user, the agents' screen browser serves the run
    // (it holds the shared logins, so only super administrators, like the screen itself).
    if (!desktopBrowserRelays.hasTarget(user.id, profile, binding) && user.role === 'super_admin') {
      ctx.body = await screenBrowser.request(binding, input)
      return
    }
    ctx.body = await desktopBrowserRelays.request(user.id, profile, input, binding)
  } catch (error) {
    ctx.status = 409
    ctx.body = { error: error instanceof Error ? error.message : 'Desktop browser request failed' }
  }
}
