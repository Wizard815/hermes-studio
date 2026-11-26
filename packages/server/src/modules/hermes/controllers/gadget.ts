import { hermesApi } from '../services/hermes-api'
import {
  GADGET_PLUGIN, defaultGadgetHome, probePort, readGadgetStatus, updateGadgetPlatform, validHost,
} from '../services/plugins/gadget'
import { getActiveProfileName } from '../services/profiles/profile'

function profileOf(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

/** Hermes's own view of the gadget platform (connected, pending_restart, fatal ...). */
async function platformState(profile: string) {
  // A status read must stay quick: Hermes's view is optional, the files above are enough.
  const answer = await Promise.race([
    hermesApi.request('GET', 'messaging/platforms', new URLSearchParams(), undefined, profile),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000).unref()),
  ])
  if (answer.status >= 400) return null
  const body = JSON.parse(answer.body.toString('utf8'))
  const list: any[] = Array.isArray(body?.platforms) ? body.platforms : []
  const entry = list.find(item => item?.id === GADGET_PLUGIN)
  return {
    gatewayRunning: entry ? !!entry.gateway_running : list.some(item => item?.gateway_running),
    state: entry?.state ? String(entry.state) : null,
    error: entry?.error_message ? String(entry.error_message).slice(0, 300) : null,
  }
}

/** Gadget status for Settings: plugin and platform on, listening, devices (no keys). */
export async function status(ctx: any) {
  try {
    ctx.body = await readGadgetStatus(profileOf(ctx), {
      homeOf: defaultGadgetHome,
      platformState: profile => hermesApi.status().available ? platformState(profile) : Promise.resolve(null),
      probe: (host, port) => probePort(host, port),
    })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to read Gadget status' }
  }
}

/** Bind address, port and on/off of the gadget platform; the gateway applies it on restart. */
export async function update(ctx: any) {
  const body = ctx.request.body || {}
  const change: { enabled?: boolean; host?: string; port?: number } = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') { ctx.status = 400; ctx.body = { error: 'enabled must be true or false' }; return }
    change.enabled = body.enabled
  }
  if (body.host !== undefined) {
    const host = validHost(body.host)
    if (!host) { ctx.status = 400; ctx.body = { error: 'host must be an IP address or host name' }; return }
    change.host = host
  }
  if (body.port !== undefined) {
    const port = Number(body.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) { ctx.status = 400; ctx.body = { error: 'port must be 1-65535' }; return }
    change.port = port
  }
  if (!Object.keys(change).length) { ctx.status = 400; ctx.body = { error: 'nothing to change' }; return }
  try {
    await updateGadgetPlatform(profileOf(ctx), change)
    ctx.body = { ok: true, restartRequired: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to save Gadget settings' }
  }
}
