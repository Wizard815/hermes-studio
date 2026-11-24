import { existsSync, readFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { join, resolve } from 'node:path'
import YAML from 'js-yaml'
import { getProfileDir } from '../profiles/profile'
import { updateConfigYamlForProfile } from '../profiles/config'

/**
 * Hermes Gadget (catalog `gadget`, Adolanium/hermes-gadget-sdk): a Hermes
 * gateway platform devices such as D.A.S.H reach over WebSocket
 * (`hermes-gadget.v1`, default `ws://<host>:8765/gadget`). Studio only reads
 * what the plugin and Hermes already write (config.yaml, the plugin's
 * `plugin-data/gadget/devices.json` and `status.json`, the gateway's state)
 * and never returns device keys.
 */
export const GADGET_PLUGIN = 'gadget'
export const GADGET_DEFAULT_PORT = 8765
export const GADGET_DEFAULT_PATH = '/gadget'
/** Bind address written when Studio turns the platform on (Docker: keep 0.0.0.0 and publish the port). */
export const GADGET_HOST_ENV = 'STUDIO_GADGET_HOST'
export const GADGET_PORT_ENV = 'STUDIO_GADGET_PORT'
/** The plugin rewrites status.json at least every 30 s while the gateway runs (plugin/status.py). */
const STATUS_STALE_AFTER_S = 90
const STATUS_FUTURE_SKEW_S = 5

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
  /** The gateway wrote a fresh status.json: the WebSocket listener is up. */
  listening: boolean
  /** A TCP connect to the port from Studio worked (null when not tried). */
  portOpen: boolean | null
  statusUpdatedAt: number | null
  devices: GadgetDevice[]
  connected: number
  env: { host: string; port: string }
}

function readJson(file: string): any {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null } catch { return null }
}

function readYaml(file: string): any {
  try { return existsSync(file) ? YAML.load(readFileSync(file, 'utf-8')) : null } catch { return null }
}

function nameList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function validPort(value: unknown): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/** A bind address as config.yaml takes it: an IP or hostname, nothing else. */
export function validHost(value: unknown): string | null {
  const host = String(value ?? '').trim()
  if (!host || host.length > 253) return null
  return /^[A-Za-z0-9.:_-]+$/.test(host) ? host : null
}

/** The live status file, as plugin/status.py `read` takes it: stale or stopped reads as not running. */
export function readLiveStatus(dataDir: string, now = Date.now() / 1000): { running: boolean; updatedAt: number | null; devices: Record<string, any> } {
  const raw = readJson(join(dataDir, 'status.json'))
  if (!raw || typeof raw !== 'object') return { running: false, updatedAt: null, devices: {} }
  const updatedAt = typeof raw.updated_at === 'number' && Number.isFinite(raw.updated_at) ? raw.updated_at : null
  const age = updatedAt === null ? null : now - updatedAt
  const fresh = age !== null && age >= -STATUS_FUTURE_SKEW_S && age <= STATUS_STALE_AFTER_S
  const running = !!raw.running && fresh
  const devices = running && raw.devices && typeof raw.devices === 'object' && !Array.isArray(raw.devices) ? raw.devices : {}
  return { running, updatedAt, devices }
}

/** Known devices (devices.json) merged with who is connected now (status.json). Keys never leave. */
export function gadgetDevices(dataDir: string, live: Record<string, any>): GadgetDevice[] {
  const store = readJson(join(dataDir, 'devices.json'))
  const known: Record<string, any> = store?.devices && typeof store.devices === 'object' ? store.devices : {}
  const nowS = Date.now() / 1000
  const ids = new Set([...Object.keys(known), ...Object.keys(live)])
  const rows: GadgetDevice[] = []
  for (const id of ids) {
    const rec = known[id] && typeof known[id] === 'object' ? known[id] : {}
    if (typeof rec.pending_until === 'number' && rec.pending_until < nowS && !live[id]) continue
    const now = live[id] && typeof live[id] === 'object' ? live[id] : null
    const pct = Number(now?.battery?.battery_percent)
    rows.push({
      id,
      name: String(now?.name || rec.name || ''),
      board: String(rec.board || ''),
      firmware: String(rec.firmware || ''),
      online: !!now?.online,
      paired: now ? !!now.paired : !('pending_until' in rec),
      pending: 'pending_until' in rec,
      profile: now?.profile ? String(now.profile) : null,
      lastSeen: typeof rec.last_seen === 'number' ? rec.last_seen : null,
      batteryPercent: Number.isFinite(pct) ? pct : null,
      activity: now?.activity?.state ? String(now.activity.state) : null,
    })
  }
  return rows.sort((a, b) => Number(b.online) - Number(a.online) || (a.name || a.id).localeCompare(b.name || b.id))
}

/** Whether something answers on host:port (0.0.0.0 and :: are tried on loopback). */
export function probePort(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  const target = host === '0.0.0.0' || host === '::' || !host ? '127.0.0.1' : host
  return new Promise((done) => {
    const socket = new Socket()
    const finish = (ok: boolean) => { socket.destroy(); done(ok) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, target)
  })
}

export interface GadgetStatusDeps {
  homeOf: (profile: string) => string
  /** Hermes's own view of the platform (GET messaging/platforms); null when Hermes is not reachable. */
  platformState: (profile: string) => Promise<{ gatewayRunning: boolean; state: string | null; error: string | null } | null>
  probe: (host: string, port: number) => Promise<boolean>
}

export async function readGadgetStatus(profile: string, deps: GadgetStatusDeps): Promise<GadgetStatus> {
  const home = deps.homeOf(profile)
  const cfg = readYaml(join(home, 'config.yaml')) || {}
  const plugins = cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {}
  const installed = existsSync(join(home, 'plugins', GADGET_PLUGIN))
  const enabled = installed && nameList(plugins.enabled).includes(GADGET_PLUGIN) && !nameList(plugins.disabled).includes(GADGET_PLUGIN)
  const platformCfg = cfg.platforms?.[GADGET_PLUGIN] && typeof cfg.platforms[GADGET_PLUGIN] === 'object' ? cfg.platforms[GADGET_PLUGIN] : {}
  const extra = platformCfg.extra && typeof platformCfg.extra === 'object' ? platformCfg.extra : {}
  const platform = {
    enabled: platformCfg.enabled === true || String(platformCfg.enabled).toLowerCase() === 'true',
    configured: 'enabled' in platformCfg,
    host: validHost(extra.host) || '0.0.0.0',
    port: validPort(extra.port) || GADGET_DEFAULT_PORT,
    path: String(extra.path || GADGET_DEFAULT_PATH),
    tls: !!extra.tls_cert,
  }
  const dataDir = join(home, 'plugin-data', GADGET_PLUGIN)
  const live = readLiveStatus(dataDir)
  const devices = gadgetDevices(dataDir, live.devices)
  const hermes = installed && enabled ? await deps.platformState(profile).catch(() => null) : null
  const portOpen = installed && enabled && platform.enabled ? await deps.probe(platform.host, platform.port).catch(() => false) : null
  return {
    profile,
    plugin: { installed, enabled },
    platform,
    gateway: { running: hermes?.gatewayRunning ?? false, state: hermes?.state ?? null, error: hermes?.error ?? null },
    listening: live.running,
    portOpen,
    statusUpdatedAt: live.updatedAt,
    devices,
    connected: devices.filter(device => device.online).length,
    env: { host: process.env[GADGET_HOST_ENV] || '', port: process.env[GADGET_PORT_ENV] || '' },
  }
}

export function gadgetDefaultsFromEnv(env: NodeJS.ProcessEnv = process.env): { host?: string; port?: number } {
  const host = validHost(env[GADGET_HOST_ENV])
  const port = validPort(env[GADGET_PORT_ENV])
  return { ...(host ? { host } : {}), ...(port ? { port } : {}) }
}

/**
 * Turns the gadget platform on once (as `hermes gateway setup` does:
 * `platforms.gadget.enabled: true`), with the bind address and port from
 * STUDIO_GADGET_HOST / STUDIO_GADGET_PORT when set. A platform the user has
 * already switched on or off is left alone. The gateway picks it up on its
 * next (re)start.
 */
export async function enableGadgetPlatformOnce(profile: string, env: NodeJS.ProcessEnv = process.env): Promise<'enabled' | 'already-set'> {
  const defaults = gadgetDefaultsFromEnv(env)
  const result = await updateConfigYamlForProfile<'enabled' | 'already-set'>(profile, (current) => {
    const cfg = current && typeof current === 'object' ? current : {}
    const platforms = cfg.platforms && typeof cfg.platforms === 'object' && !Array.isArray(cfg.platforms) ? cfg.platforms : {}
    const gadget = platforms[GADGET_PLUGIN] && typeof platforms[GADGET_PLUGIN] === 'object' ? platforms[GADGET_PLUGIN] : {}
    if ('enabled' in gadget) return { data: cfg, result: 'already-set', write: false }
    const extra = gadget.extra && typeof gadget.extra === 'object' ? gadget.extra : {}
    cfg.platforms = { ...platforms, [GADGET_PLUGIN]: { ...gadget, enabled: true, extra: { ...defaults, ...extra } } }
    return { data: cfg, result: 'enabled' }
  })
  return result || 'already-set'
}

/** Settings: bind address, port and on/off of the gadget platform. */
export async function updateGadgetPlatform(profile: string, change: { enabled?: boolean; host?: string; port?: number }): Promise<void> {
  await updateConfigYamlForProfile(profile, (current) => {
    const cfg = current && typeof current === 'object' ? current : {}
    const platforms = cfg.platforms && typeof cfg.platforms === 'object' && !Array.isArray(cfg.platforms) ? cfg.platforms : {}
    const gadget = platforms[GADGET_PLUGIN] && typeof platforms[GADGET_PLUGIN] === 'object' ? { ...platforms[GADGET_PLUGIN] } : {}
    const extra = gadget.extra && typeof gadget.extra === 'object' ? { ...gadget.extra } : {}
    if (typeof change.enabled === 'boolean') gadget.enabled = change.enabled
    if (change.host !== undefined) extra.host = change.host
    if (change.port !== undefined) extra.port = change.port
    gadget.extra = extra
    cfg.platforms = { ...platforms, [GADGET_PLUGIN]: gadget }
    return cfg
  })
}

export function defaultGadgetHome(profile: string): string {
  return resolve(getProfileDir(profile))
}
