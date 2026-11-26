import { request } from '../client'

/** Hermes Gadget (the `gadget` Hermes plugin): devices such as D.A.S.H connect to its WebSocket. */
export interface GadgetDevice {
  id: string
  name: string
  board: string
  firmware: string
  online: boolean
  paired: boolean
  pending: boolean
  profile: string | null
  lastSeen: number | null
  batteryPercent: number | null
  activity: string | null
}

export interface GadgetStatus {
  profile: string
  plugin: { installed: boolean; enabled: boolean }
  platform: { enabled: boolean; configured: boolean; host: string; port: number; path: string; tls: boolean }
  gateway: { running: boolean; state: string | null; error: string | null }
  listening: boolean
  portOpen: boolean | null
  statusUpdatedAt: number | null
  devices: GadgetDevice[]
  connected: number
  env: { host: string; port: string }
}

export const fetchGadgetStatus = () => request<GadgetStatus>('/api/hermes/plugins/gadget/status')

export const updateGadgetPlatform = (change: { enabled?: boolean; host?: string; port?: number }) =>
  request<{ ok: boolean; restartRequired: boolean }>('/api/hermes/plugins/gadget/platform', { method: 'PUT', body: JSON.stringify(change) })

/** The address a device connects to, e.g. ws://<this host>:8765/gadget. */
export function gadgetDeviceUrl(status: Pick<GadgetStatus, 'platform'>, hostname: string): string {
  const { host, port, path, tls } = status.platform
  const shown = host === '0.0.0.0' || host === '::' ? hostname : host
  return `${tls ? 'wss' : 'ws'}://${shown}:${port}${path}`
}

/** What the panel says about the gateway: one state, most important first. */
export type GadgetState = 'not-installed' | 'plugin-off' | 'platform-off' | 'listening' | 'gateway-stopped' | 'restart' | 'error'

/** How long after "Restart gateway" the panel says "Restarting…" before it says the restart failed. */
export const GADGET_RESTART_TIMEOUT_MS = 120_000

/**
 * After "Restart gateway" the gateway is not listening for up to a minute; that is
 * a restart in progress, not a problem. It is back once the restarted gateway wrote
 * its status (listening, written after the restart began: the old gateway's file
 * still reads as listening for a moment). Null when no restart is pending or it is back.
 */
export function gadgetRestartPhase(status: Pick<GadgetStatus, 'listening' | 'statusUpdatedAt'>, startedAt: number | null, now = Date.now()): 'restarting' | 'failed' | null {
  if (startedAt === null) return null
  if (status.listening && (status.statusUpdatedAt ?? 0) * 1000 >= startedAt) return null
  return now - startedAt < GADGET_RESTART_TIMEOUT_MS ? 'restarting' : 'failed'
}

export function gadgetState(status: GadgetStatus): GadgetState {
  if (!status.plugin.installed) return 'not-installed'
  if (!status.plugin.enabled) return 'plugin-off'
  if (!status.platform.enabled) return 'platform-off'
  if (status.listening) return 'listening'
  if (['fatal', 'startup_failed', 'error'].includes(String(status.gateway.state)) && status.gateway.error) return 'error'
  if (!status.gateway.running) return 'gateway-stopped'
  return 'restart'
}
