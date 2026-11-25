import type { Context } from 'koa'
import { PassThrough } from 'node:stream'
import { getApprovalAlerts } from '../services/approval-alerts'
import { getAgentWork } from '../services/agent-work'

/** Where approvals reach you and paired phones (docs/approval-alerts.md). */

function fail(ctx: Context, error: unknown) {
  const status = Number((error as { status?: number })?.status)
  ctx.status = status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

const body = (ctx: Context) => ((ctx.request as any).body || {}) as Record<string, any>
const userId = (ctx: Context) => Number(ctx.state.user?.id)

// --- Settings (super admins, for themselves) -----------------------------------

export async function status(ctx: Context) {
  try {
    const service = getApprovalAlerts()
    let mattermost = { channel: '', buttons: false }
    try {
      const settings = await getAgentWork().publicSettings()
      mattermost = { channel: settings.mattermost.channel, buttons: !!settings.mattermost.actionUrl }
    } catch { /* Agent work not running: no channel */ }
    ctx.body = { prefs: service.prefs(userId(ctx)), devices: service.devices(userId(ctx)), mattermost }
  } catch (error) { fail(ctx, error) }
}

export async function savePrefs(ctx: Context) {
  try { ctx.body = { prefs: getApprovalAlerts().savePrefs(userId(ctx), body(ctx).prefs ?? body(ctx)) } } catch (error) { fail(ctx, error) }
}

export async function startPairing(ctx: Context) {
  try { ctx.body = getApprovalAlerts().startPairing(userId(ctx), body(ctx).name) } catch (error) { fail(ctx, error) }
}

export async function removeDevice(ctx: Context) {
  try {
    getApprovalAlerts().removeDevice(userId(ctx), String(ctx.params.id))
    ctx.body = { removed: true, devices: getApprovalAlerts().devices(userId(ctx)) }
  } catch (error) { fail(ctx, error) }
}

export async function sendTest(ctx: Context) {
  try {
    const service = getApprovalAlerts()
    const item = service.sendTest(userId(ctx))
    ctx.body = { item, connected: service.devices(userId(ctx)).filter(device => device.connected).length }
  } catch (error) { fail(ctx, error) }
}

// --- Pairing (public: the code is the secret) ----------------------------------

export async function pair(ctx: Context) {
  try {
    const result = getApprovalAlerts().pair(body(ctx).code, body(ctx).name)
    ctx.status = 201
    ctx.body = result
  } catch (error) { fail(ctx, error) }
}

// --- The phone's key ---------------------------------------------------------

export async function deviceStatus(ctx: Context) {
  try { ctx.body = getApprovalAlerts().deviceStatus(getApprovalAlerts().device(ctx.state.phoneKey?.id)) } catch (error) { fail(ctx, error) }
}

export async function deviceApprovals(ctx: Context) {
  try {
    const device = getApprovalAlerts().device(ctx.state.phoneKey?.id)
    ctx.body = { items: getApprovalAlerts().forUser(device.userId) }
  } catch (error) { fail(ctx, error) }
}

function deviceAnswer(decision: 'approve' | 'reject') {
  return async (ctx: Context) => {
    try {
      const device = getApprovalAlerts().device(ctx.state.phoneKey?.id)
      ctx.body = await getApprovalAlerts().answerFromPhone(device, String(ctx.params.id), decision)
    } catch (error) { fail(ctx, error) }
  }
}
export const deviceApprove = deviceAnswer('approve')
export const deviceReject = deviceAnswer('reject')

/** Server-sent events: `approvals` with the whole list now and on every change, a comment every 45 s. */
const HEARTBEAT_MS = 45_000

export async function deviceStream(ctx: Context) {
  let device
  let service
  try {
    device = getApprovalAlerts().device(ctx.state.phoneKey?.id)
    service = getApprovalAlerts()
  } catch (error) { fail(ctx, error); return }
  ctx.req.socket.setTimeout(0)
  ctx.req.socket.setNoDelay(true)
  ctx.req.socket.setKeepAlive(true)
  ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
  ctx.set('Cache-Control', 'no-cache, no-transform')
  ctx.set('Connection', 'keep-alive')
  // Proxies (nginx, Cloudflare) must not hold events back.
  ctx.set('X-Accel-Buffering', 'no')
  const stream = new PassThrough()
  ctx.status = 200
  ctx.body = stream
  const send = (event: string, data: unknown) => { stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  // Reconnect after 10 s when the connection drops.
  stream.write('retry: 10000\n\n')
  const unsubscribe = service.subscribe(device, (event, data) => {
    send(event, data)
    if (event === 'revoked' || event === 'bye') stream.end()
  })
  const heartbeat = setInterval(() => stream.write(': ping\n\n'), HEARTBEAT_MS)
  heartbeat.unref?.()
  const close = () => { clearInterval(heartbeat); unsubscribe() }
  stream.on('close', close)
  ctx.req.on('close', () => { close(); stream.end() })
}
