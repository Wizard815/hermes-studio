import type { Context } from 'koa'
import { ScreenGateway } from '../services/screen/gateway'
import { screenGateway, screenManager } from '../services/screen'
import { viewerHash } from '../services/screen/manager'

function fail(ctx: Context, error: any) {
  ctx.status = Number(error?.status) >= 400 ? Number(error.status) : 500
  ctx.body = { error: error?.message || String(error) }
}

function userToken(ctx: Context): string {
  return ctx.get('Authorization').replace(/^Bearer /, '')
}

function viewerOf(ctx: Context): string {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const clientId = String(body.clientId || ctx.query.clientId || '')
  return ScreenGateway.viewerId(ctx.state.user?.id ?? 'user', clientId)
}

/** Status, plus whether this viewer holds control. */
export async function status(ctx: Context) {
  try {
    const current = await screenManager.status()
    const hash = viewerHash(viewerOf(ctx))
    ctx.body = { ...current, youHaveControl: current.lease?.holder === 'human' && current.lease?.viewer_hash === hash }
  } catch (error) { fail(ctx, error) }
}

export async function install(ctx: Context) {
  void screenManager.install().catch(() => undefined)
  ctx.status = 202
  ctx.body = await screenManager.status()
}

export async function start(ctx: Context) {
  try { await screenManager.start(); ctx.body = await screenManager.status() } catch (error) { fail(ctx, error) }
}

export async function stop(ctx: Context) {
  try { await screenManager.stop((ctx.request.body as any)?.force === true); ctx.body = await screenManager.status() } catch (error) { fail(ctx, error) }
}

/** A single-use ticket for the live view (noVNC's websocket cannot send headers). */
export async function ticket(ctx: Context) {
  ctx.body = { ticket: screenGateway.createTicket(viewerOf(ctx), userToken(ctx)) }
}

/** take | release | force: take control, hand it back, or clear a stuck hold. */
export async function control(ctx: Context) {
  try {
    const action = String((ctx.request.body as any)?.action || '')
    if (!['take', 'release', 'force'].includes(action)) { ctx.status = 400; ctx.body = { error: 'action must be take, release or force' }; return }
    const viewer = viewerOf(ctx)
    const lease = await screenManager.lease(action as 'take' | 'release' | 'force', viewer, String((ctx.request.body as any)?.reason || ''))
    ctx.body = { lease, youHaveControl: lease.holder === 'human' && lease.viewer_hash === viewerHash(viewer) }
  } catch (error) { fail(ctx, error) }
}

/** An agent's browser action (sent by Studio's browser tools). */
export async function recordActivity(ctx: Context) {
  const { browserActivity, cleanActivity } = await import('../services/screen/activity')
  const entry = cleanActivity((ctx.request.body || {}) as Record<string, unknown>, ctx.state.runBinding || {})
  if (!entry) { ctx.status = 400; ctx.body = { error: 'kind and summary are required' }; return }
  browserActivity.add(entry)
  ctx.status = 204
}

/** Recent browser activity, optionally for one chat. */
export async function listActivity(ctx: Context) {
  const { browserActivity } = await import('../services/screen/activity')
  const sessionId = typeof ctx.query.sessionId === 'string' && ctx.query.sessionId ? ctx.query.sessionId : undefined
  ctx.body = { activity: browserActivity.list({ limit: Number(ctx.query.limit) || 100, sessionId }) }
}

// ── Saved logins (Hermes's encrypted vault) ───────────────────────────────

async function vault(args: string[], input?: string): Promise<{ status: number; body: any }> {
  const { bridgeScript } = await import('../services/screen/manager')
  const python = screenManager.python
  if (!python) return { status: 503, body: { error: 'Hermes is not installed here' } }
  const result = await runWithInput(python, [bridgeScript(), 'vault', ...args], input)
  let body: any
  try { body = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}') } catch { body = { error: 'The vault did not answer' } }
  return { status: body.error ? 400 : 200, body }
}

function runWithInput(command: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const child = spawn(command, args, { env: { ...process.env, HERMES_HOME: screenManager.home, STUDIO_SCREEN_HOME: screenManager.home }, stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.once('error', () => { clearTimeout(timer); resolve({ code: -1, stdout }) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout }) })
    child.stdin.end(input || '')
  })
}

/** Saved logins: what they are and where they work, never their passwords. */
export async function listVault(ctx: Context) {
  const out = await vault(['list'])
  ctx.status = out.status
  ctx.body = out.body
}

/** Save a login, card or address (secrets go to the helper on stdin, encrypted at rest by Hermes). */
export async function addVaultItem(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const text = (key: string, max = 500) => String(body[key] ?? '').trim().slice(0, max)
  const kind = ['login', 'payment', 'address'].includes(String(body.kind)) ? String(body.kind) : 'login'
  let item: Record<string, string>
  if (kind === 'login') {
    item = {
      kind, label: text('label', 200), origin: text('origin'),
      identifier_type: ['email', 'phone', 'username'].includes(String(body.identifierType)) ? String(body.identifierType) : 'username',
      identifier: text('identifier'), password: String(body.password || ''),
      ...(body.otpSecret ? { otp_secret: text('otpSecret', 200) } : {}),
    }
  } else if (kind === 'payment') {
    item = {
      kind, label: text('label', 200), ...(body.origin ? { origin: text('origin') } : {}),
      card_number: text('cardNumber', 40).replace(/[\s-]/g, ''), exp_month: text('expMonth', 2), exp_year: text('expYear', 4),
      cvc: text('cvc', 4), cardholder_name: text('cardholderName', 200), billing_postal_code: text('postalCode', 20),
    }
  } else {
    item = {
      kind, label: text('label', 200), address_line1: text('addressLine1'), address_line2: text('addressLine2'),
      city: text('city', 200), state: text('state', 200), postal_code: text('postalCode', 20), country: text('country', 100),
    }
  }
  const out = await vault(['add'], JSON.stringify(item))
  ctx.status = out.status
  ctx.body = out.body
}

export async function removeVaultItem(ctx: Context) {
  const out = await vault(['rm', String(ctx.params.id || '')])
  ctx.status = out.status
  ctx.body = out.body
}

/** An agent fills a saved login into the screen's browser (only on its own site). */
export async function fillVaultItem(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const handle = String(body.handle || '')
  if (!handle) { ctx.status = 400; ctx.body = { error: 'handle is required' }; return }
  const { bridgeScript } = await import('../services/screen/manager')
  const python = screenManager.python
  if (!python) { ctx.status = 503; ctx.body = { error: 'Hermes is not installed here' }; return }
  const browser = await screenManager.run(python, [bridgeScript(), 'browser'], 60_000)
  let port = 0
  try { port = Number(JSON.parse(browser.stdout.trim().split(/\r?\n/).pop() || '{}').port) || 0 } catch { port = 0 }
  if (!port) {
    ctx.status = 409
    ctx.body = { error: browser.code === 42 ? 'A person has taken over the screen; wait until they hand it back.' : "The agents' screen browser is not running" }
    return
  }
  const out = await vault(['fill', handle, String(port), String(body.tabId || '')])
  ctx.status = out.status
  ctx.body = out.body
}
