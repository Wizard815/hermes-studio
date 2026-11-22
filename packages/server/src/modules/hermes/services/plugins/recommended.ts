import { join, resolve } from 'node:path'
import { config } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'
import { safeFileStore } from '../../../studio/public/safe-file-store'
import { readAppConfig } from '../../../studio/public/app-config'
import { getHermesBaseDir, getProfileDir, listProfileNamesFromDisk } from '../profiles/profile'
import { updateConfigYamlForProfile } from '../profiles/config'
import { findHermesCli } from '../herdr-launch'
import { hermesApi } from '../hermes-api'
import { GADGET_PLUGIN, enableGadgetPlatformOnce } from './gadget'

/**
 * Hermes plugins Studio installs and enables once per Hermes profile
 * (docs/hermes-integrations.md, "Recommended plugins"). Installs go through
 * Hermes's own plugin hub by catalog name, so only the catalog's pinned
 * commit is ever installed, exactly like the Install button on the Plugins
 * page. Only enabling: no terminal backend switch, no import run, no keys.
 */
export const RECOMMENDED_HERMES_PLUGINS = [
  'agent-importers', 'homeassistant', 'langfuse', 'mcp-serve', 'bubblewrap', 'rea', 'print3d', 'gadget',
] as const

export const RECOMMENDED_PLUGINS_ENV = 'STUDIO_RECOMMENDED_HERMES_PLUGINS'

/** The MCP server Studio adds once mcp-serve is installed (MCP page). */
export const MCP_SERVE_SERVER_NAME = 'hermes-chats'

/**
 * Read-only tools of `hermes mcp-serve`. Sending messages as the user's
 * accounts (messages_send) and answering approvals (permissions_respond)
 * stay off until the user turns them on on the MCP page.
 */
export const MCP_SERVE_READ_TOOLS = [
  'conversations_list', 'conversation_get', 'messages_read', 'attachments_fetch',
  'events_poll', 'events_wait', 'channels_list', 'permissions_list_open',
] as const

/** Why a plugin is done for a profile; anything else is retried on a later start. */
export type RecommendedOutcome = 'installed' | 'enabled' | 'already-enabled' | 'kept-disabled' | 'not-for-this-platform'

export interface RecommendedRecord { outcome: RecommendedOutcome; at: string; missingEnv?: string[] }
export interface RecommendedAttempt { at: string; error: string; attempts: number }

export interface RecommendedProfileState {
  profile: string
  done: Record<string, RecommendedRecord>
  lastFailure?: Record<string, RecommendedAttempt>
  /** Set once the mcp-serve MCP server was added (or found); never added again after that. */
  mcpServer?: { outcome: 'added' | 'already-present'; at: string }
  /** Set once the gadget platform was switched on (or found set); never switched again after that. */
  gadgetPlatform?: { outcome: 'enabled' | 'already-set'; at: string }
}

export interface RecommendedPluginsState {
  version: 1
  /** Keyed by the profile's Hermes home (a moved HERMES_HOME starts afresh). */
  homes: Record<string, RecommendedProfileState>
}

interface CatalogEntry {
  name: string
  requires_hermes?: string
  platforms?: string[]
  installed?: boolean
  runtime_status?: string | null
}

export interface HermesCall { status: number; body: any }

export interface RecommendedDeps {
  call: (method: string, path: string, body: unknown, profile: string) => Promise<HermesCall>
  hermesAvailable: () => boolean
  hermesVersion: () => string | null
  /** Adds the MCP server unless one of that name exists; true when it was added. */
  addMcpServer: (profile: string, name: string, server: Record<string, unknown>) => Promise<boolean>
  /** Switches the gadget gateway platform on unless the user already set it. */
  enableGadgetPlatform: (profile: string) => Promise<'enabled' | 'already-set'>
  hermesCommand: () => string
  stateFile: string
  platform: NodeJS.Platform
  homeOf: (profile: string) => string
}

function stateFilePath(): string {
  return join(config.appHome, 'recommended-hermes-plugins.json')
}

export async function addMcpServerToConfig(profile: string, name: string, server: Record<string, unknown>): Promise<boolean> {
  const added = await updateConfigYamlForProfile<boolean>(profile, (current) => {
    const cfg = current && typeof current === 'object' ? current : {}
    const servers = cfg.mcp_servers && typeof cfg.mcp_servers === 'object' && !Array.isArray(cfg.mcp_servers) ? cfg.mcp_servers : {}
    if (Object.keys(servers).some(key => key.toLowerCase() === name.toLowerCase())) return { data: cfg, result: false, write: false }
    cfg.mcp_servers = { ...servers, [name]: server }
    return { data: cfg, result: true }
  })
  return added === true
}

function defaultDeps(): RecommendedDeps {
  return {
    async call(method, path, body, profile) {
      const result = await hermesApi.request(method, path, new URLSearchParams(), body, profile)
      const text = result.body.toString('utf8')
      let parsed: any = text
      try { parsed = JSON.parse(text) } catch { /* not JSON */ }
      return { status: result.status, body: parsed }
    },
    hermesAvailable: () => hermesApi.status().available,
    hermesVersion: () => hermesApi.status().version,
    addMcpServer: addMcpServerToConfig,
    enableGadgetPlatform: profile => enableGadgetPlatformOnce(profile),
    hermesCommand: () => findHermesCli() || 'hermes',
    stateFile: stateFilePath(),
    platform: process.platform,
    homeOf: profile => resolve(getProfileDir(profile)),
  }
}

function emptyState(): RecommendedPluginsState {
  return { version: 1, homes: {} }
}

function parseState(raw: string): RecommendedPluginsState {
  if (!raw.trim()) return emptyState()
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.version !== 1 || typeof parsed.homes !== 'object' || Array.isArray(parsed.homes)) {
    throw new Error('Unsupported recommended plugins state')
  }
  return parsed as RecommendedPluginsState
}

export async function readRecommendedState(stateFile = stateFilePath()): Promise<RecommendedPluginsState> {
  try {
    return parseState(await safeFileStore.readText(stateFile))
  } catch (err: any) {
    if (err?.code === 'ENOENT') return emptyState()
    throw err
  }
}

async function updateState(stateFile: string, change: (state: RecommendedPluginsState) => void): Promise<void> {
  await safeFileStore.updateText(stateFile, (current) => {
    const state = parseState(current)
    change(state)
    return JSON.stringify(state, null, 2) + '\n'
  }, { backup: true })
}

function envDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(0|false|no|off)$/i.test(String(env[RECOMMENDED_PLUGINS_ENV] || '').trim())
}

/** On unless STUDIO_RECOMMENDED_HERMES_PLUGINS=0 or the Settings switch is off. */
export async function recommendedAutoInstallSetting(env: NodeJS.ProcessEnv = process.env): Promise<{ enabled: boolean; disabledByEnv: boolean }> {
  const disabledByEnv = envDisabled(env)
  const saved = (await readAppConfig()).recommendedHermesPlugins !== false
  return { enabled: saved && !disabledByEnv, disabledByEnv }
}

function versionTuple(value: string): number[] | null {
  const match = String(value || '').trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return null
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)]
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * Whether `version` satisfies a catalog `requires_hermes` such as ">=0.21.6"
 * or ">=0.21,<0.30". null when either side cannot be read: Hermes then decides.
 */
export function satisfiesHermes(spec: string | undefined, version: string | null): boolean | null {
  const clauses = String(spec || '').split(',').map(part => part.trim()).filter(Boolean)
  if (!clauses.length) return true
  const current = version ? versionTuple(version) : null
  if (!current) return null
  for (const clause of clauses) {
    const match = clause.match(/^(>=|<=|==|!=|>|<|~=)?\s*(.+)$/)
    const target = match ? versionTuple(match[2]) : null
    if (!match || !target) return null
    const diff = compare(current, target)
    const op = match[1] || '=='
    const ok = op === '>=' ? diff >= 0 : op === '>' ? diff > 0 : op === '<=' ? diff <= 0 : op === '<' ? diff < 0
      : op === '!=' ? diff !== 0 : op === '~=' ? diff >= 0 && current[0] === target[0] : diff === 0
    if (!ok) return false
  }
  return true
}

/** The catalog names platforms "linux", "macos", "windows"; Node says linux, darwin, win32. */
export function platformAllowed(platforms: string[] | undefined, platform: NodeJS.Platform): boolean {
  if (!Array.isArray(platforms) || !platforms.length) return true
  const names = new Set([platform, platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform])
  return platforms.some(value => names.has(String(value).toLowerCase() as NodeJS.Platform))
}

function errorText(call: HermesCall): string {
  const body = call.body
  const detail = body && typeof body === 'object' ? (body.error || body.detail || body.message) : body
  return String(typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `HTTP ${call.status}`).replace(/\s+/g, ' ').slice(0, 300)
}

/** The stdio server for `hermes mcp-serve` (read-only tools) for this profile. */
export function mcpServeServerConfig(profile: string, command: string, hermesBase: string): Record<string, unknown> {
  return {
    command,
    args: profile && profile !== 'default' ? ['-p', profile, 'mcp-serve'] : ['mcp-serve'],
    env: { HERMES_HOME: hermesBase },
    tools: { include: [...MCP_SERVE_READ_TOOLS] },
  }
}

export interface RecommendedRunResult {
  profile: string
  done: string[]
  failed: Record<string, string>
  skipped?: string
  mcpServer?: 'added' | 'already-present'
  gadgetPlatform?: 'enabled' | 'already-set'
}

const failureFrom = (err: any): HermesCall => ({ status: 599, body: { error: String(err?.message || err) } })

/**
 * Installs and enables the recommended plugins a profile has not had yet.
 * Each plugin is recorded once done; a plugin the user disables or removes
 * later is never touched again. Failures are logged and retried on a later
 * start. Never throws.
 */
export async function applyRecommendedPlugins(profile: string, deps: RecommendedDeps = defaultDeps()): Promise<RecommendedRunResult> {
  const result: RecommendedRunResult = { profile, done: [], failed: {} }
  if (!deps.hermesAvailable()) { result.skipped = 'no-hermes'; return result }
  const home = deps.homeOf(profile)
  let state: RecommendedPluginsState
  try {
    state = await readRecommendedState(deps.stateFile)
  } catch (err) {
    logger.warn(err, '[recommended-plugins] state file unreadable; not touching plugins')
    result.skipped = 'state'
    return result
  }
  const before = state.homes[home]
  const doneBefore = before?.done || {}
  const pending = RECOMMENDED_HERMES_PLUGINS.filter(name => !doneBefore[name])
  const records: Record<string, RecommendedRecord> = {}

  if (pending.length) {
    let catalog: CatalogEntry[] | null = null
    try {
      const answer = await deps.call('GET', 'dashboard/plugins/catalog', undefined, profile)
      if (answer.status >= 400 || !Array.isArray(answer.body?.entries)) throw new Error(errorText(answer))
      catalog = answer.body.entries
    } catch (err: any) {
      const message = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 300)
      logger.warn('[recommended-plugins] plugin catalog not reachable profile=%s: %s (retry on next start)', profile, message)
      for (const name of pending) result.failed[name] = message
    }

    const version = deps.hermesVersion()
    for (const name of catalog ? pending : []) {
      const at = new Date().toISOString()
      const entry = catalog!.find(item => item.name === name)
      if (!entry) { result.failed[name] = 'not in the Hermes plugin catalog'; continue }
      if (!platformAllowed(entry.platforms, deps.platform)) {
        records[name] = { outcome: 'not-for-this-platform', at }
        continue
      }
      if (entry.installed) {
        // Installed before Studio got to it: an explicit disable is the user's choice.
        if (entry.runtime_status === 'disabled') { records[name] = { outcome: 'kept-disabled', at }; continue }
        if (entry.runtime_status === 'enabled') { records[name] = { outcome: 'already-enabled', at }; continue }
        const answer = await deps.call('POST', `dashboard/agent-plugins/${encodeURIComponent(name)}/enable`, {}, profile).catch(failureFrom)
        if (answer.status >= 400 || answer.body?.ok === false) { result.failed[name] = errorText(answer); continue }
        records[name] = { outcome: 'enabled', at }
        continue
      }
      if (satisfiesHermes(entry.requires_hermes, version) === false) {
        result.failed[name] = `needs Hermes ${entry.requires_hermes}; this is ${version}`
        continue
      }
      // Catalog name only: Hermes installs the entry's pinned commit.
      const answer = await deps.call('POST', 'dashboard/agent-plugins/install', { identifier: '', catalog_name: name, enable: true }, profile).catch(failureFrom)
      const body = answer.body && typeof answer.body === 'object' ? answer.body : {}
      if (answer.status >= 400 || body.ok === false || body.consent_required || body.scan_blocked) {
        result.failed[name] = body.consent_required ? 'Hermes asks for consent; install it from the Plugins page'
          : body.scan_blocked ? 'blocked by Hermes security scan' : errorText(answer)
        continue
      }
      const missingEnv = Array.isArray(body.missing_env) ? body.missing_env.map(String) : []
      records[name] = { outcome: 'installed', at, ...(missingEnv.length ? { missingEnv } : {}) }
    }
  }
  result.done = Object.keys(records)

  // mcp-serve on the MCP page, once: a server the user removes later stays removed.
  const mcpServe = records['mcp-serve'] || doneBefore['mcp-serve']
  let mcpServer: RecommendedProfileState['mcpServer']
  if (!before?.mcpServer && mcpServe && ['installed', 'enabled', 'already-enabled'].includes(mcpServe.outcome)) {
    try {
      const server = mcpServeServerConfig(profile, deps.hermesCommand(), resolve(getHermesBaseDir()))
      const added = await deps.addMcpServer(profile, MCP_SERVE_SERVER_NAME, server)
      mcpServer = { outcome: added ? 'added' : 'already-present', at: new Date().toISOString() }
      result.mcpServer = mcpServer.outcome
    } catch (err: any) {
      logger.warn('[recommended-plugins] could not add the %s MCP server profile=%s: %s (retry on next start)', MCP_SERVE_SERVER_NAME, profile, String(err?.message || err))
    }
  }

  // The gadget platform (devices such as D.A.S.H connect to it), once: a platform the user turns off stays off.
  const gadget = records[GADGET_PLUGIN] || doneBefore[GADGET_PLUGIN]
  let gadgetPlatform: RecommendedProfileState['gadgetPlatform']
  if (!before?.gadgetPlatform && gadget && ['installed', 'enabled', 'already-enabled'].includes(gadget.outcome)) {
    try {
      gadgetPlatform = { outcome: await deps.enableGadgetPlatform(profile), at: new Date().toISOString() }
      result.gadgetPlatform = gadgetPlatform.outcome
    } catch (err: any) {
      logger.warn('[recommended-plugins] could not turn the gadget platform on profile=%s: %s (retry on next start)', profile, String(err?.message || err))
    }
  }

  if (!result.done.length && !Object.keys(result.failed).length && !mcpServer && !gadgetPlatform) {
    if (!pending.length) result.skipped = 'done'
    return result
  }
  try {
    await updateState(deps.stateFile, (next) => {
      const current = next.homes[home] || { profile, done: {} }
      current.profile = profile
      current.done = { ...current.done, ...records }
      if (mcpServer) current.mcpServer = mcpServer
      if (gadgetPlatform) current.gadgetPlatform = gadgetPlatform
      const failures = { ...(current.lastFailure || {}) }
      for (const name of result.done) delete failures[name]
      for (const [name, error] of Object.entries(result.failed)) {
        failures[name] = { at: new Date().toISOString(), error, attempts: (failures[name]?.attempts || 0) + 1 }
      }
      if (Object.keys(failures).length) current.lastFailure = failures
      else delete current.lastFailure
      next.homes[home] = current
    })
  } catch (err) {
    logger.warn(err, '[recommended-plugins] could not save state profile=%s', profile)
  }
  for (const name of result.done) logger.info('[recommended-plugins] %s profile=%s: %s', name, profile, records[name].outcome)
  if (result.gadgetPlatform === 'enabled') logger.info('[recommended-plugins] gadget platform on profile=%s (starts listening when the gateway restarts)', profile)
  if (result.mcpServer === 'added') logger.info('[recommended-plugins] MCP server %s added profile=%s', MCP_SERVE_SERVER_NAME, profile)
  // One line per start, not one per plugin: an offline server must not fill the log.
  const failed = Object.entries(result.failed)
  if (failed.length) {
    logger.warn('[recommended-plugins] not installed yet profile=%s (retry on next start): %s', profile,
      failed.map(([name, error]) => `${name}: ${error}`).join('; '))
  }
  return result
}

let running: Promise<void> = Promise.resolve()

/**
 * Runs in the background (never blocks startup or a request): profiles one at
 * a time, after anything already queued.
 */
export function scheduleRecommendedPlugins(profiles?: string[], deps?: RecommendedDeps): Promise<void> {
  running = running.then(async () => {
    try {
      const setting = await recommendedAutoInstallSetting()
      if (!setting.enabled) {
        logger.info('[recommended-plugins] auto-install is off (%s)', setting.disabledByEnv ? RECOMMENDED_PLUGINS_ENV : 'Settings')
        return
      }
      for (const profile of profiles || listProfileNamesFromDisk()) {
        await applyRecommendedPlugins(profile, deps)
      }
    } catch (err) {
      logger.warn(err, '[recommended-plugins] run failed (retry on next start)')
    }
  })
  return running
}
