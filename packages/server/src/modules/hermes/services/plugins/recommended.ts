import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'
import { safeFileStore } from '../../../studio/public/safe-file-store'
import { readAppConfig } from '../../../studio/public/app-config'
import { getProfileDir, listProfileNamesFromDisk } from '../profiles/profile'
import { hermesApi } from '../hermes-api'

/**
 * Official Hermes plugins Studio installs and enables once per Hermes profile
 * (docs/hermes-integrations.md, "Recommended plugins"). Installs go through
 * Hermes's own plugin hub at the catalog's pinned commit, exactly like the
 * Install button on the Plugins page. Only enabling: no terminal backend
 * switch, no import run, no keys.
 */
export const RECOMMENDED_HERMES_PLUGINS = ['agent-importers', 'homeassistant', 'langfuse', 'mcp-serve', 'bubblewrap'] as const

export const RECOMMENDED_PLUGINS_ENV = 'STUDIO_RECOMMENDED_HERMES_PLUGINS'

/** Why a plugin is done for a profile; anything else is retried on a later start. */
export type RecommendedOutcome = 'installed' | 'enabled' | 'already-enabled' | 'kept-disabled' | 'not-for-this-platform'

export interface RecommendedRecord { outcome: RecommendedOutcome; at: string; missingEnv?: string[] }
export interface RecommendedAttempt { at: string; error: string; attempts: number }

export interface RecommendedProfileState {
  profile: string
  done: Record<string, RecommendedRecord>
  lastFailure?: Record<string, RecommendedAttempt>
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
  hermesVersion: () => string | null
  stateFile: string
  platform: NodeJS.Platform
  homeOf: (profile: string) => string
}

function stateFilePath(): string {
  return join(config.appHome, 'recommended-hermes-plugins.json')
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
    hermesVersion: () => hermesApi.status().version,
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

function errorText(call: HermesCall): string {
  const body = call.body
  const detail = body && typeof body === 'object' ? (body.error || body.detail || body.message) : body
  return String(detail || `HTTP ${call.status}`).slice(0, 300)
}

export interface RecommendedRunResult {
  profile: string
  done: string[]
  failed: Record<string, string>
  skipped?: string
}

/**
 * Installs and enables the recommended plugins a profile has not had yet.
 * Each plugin is recorded once done; a plugin the user disables or removes
 * later is never touched again. Failures are logged and retried on a later
 * start. Never throws.
 */
export async function applyRecommendedPlugins(profile: string, deps: RecommendedDeps = defaultDeps()): Promise<RecommendedRunResult> {
  const result: RecommendedRunResult = { profile, done: [], failed: {} }
  const home = deps.homeOf(profile)
  let state: RecommendedPluginsState
  try {
    state = await readRecommendedState(deps.stateFile)
  } catch (err) {
    logger.warn(err, '[recommended-plugins] state file unreadable; not touching plugins')
    result.skipped = 'state'
    return result
  }
  const doneBefore = state.homes[home]?.done || {}
  const pending = RECOMMENDED_HERMES_PLUGINS.filter(name => !doneBefore[name])
  if (!pending.length) { result.skipped = 'done'; return result }

  let catalog: CatalogEntry[]
  try {
    const answer = await deps.call('GET', 'dashboard/plugins/catalog', undefined, profile)
    if (answer.status >= 400 || !Array.isArray(answer.body?.entries)) throw new Error(errorText(answer))
    catalog = answer.body.entries
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 300)
    logger.warn('[recommended-plugins] plugin catalog not reachable profile=%s: %s (retry on next start)', profile, message)
    for (const name of pending) result.failed[name] = message
    await recordFailures(deps.stateFile, home, profile, result.failed)
    return result
  }

  const version = deps.hermesVersion()
  const records: Record<string, RecommendedRecord> = {}
  for (const name of pending) {
    const at = new Date().toISOString()
    const entry = catalog.find(item => item.name === name)
    if (!entry) { result.failed[name] = 'not in the Hermes plugin catalog'; continue }
    if (Array.isArray(entry.platforms) && entry.platforms.length && !entry.platforms.includes(deps.platform)) {
      records[name] = { outcome: 'not-for-this-platform', at }
      continue
    }
    if (entry.installed) {
      // Installed before Studio got to it: an explicit disable is the user's choice.
      if (entry.runtime_status === 'disabled') { records[name] = { outcome: 'kept-disabled', at }; continue }
      if (entry.runtime_status === 'enabled') { records[name] = { outcome: 'already-enabled', at }; continue }
      const answer = await deps.call('POST', `dashboard/agent-plugins/${encodeURIComponent(name)}/enable`, {}, profile).catch(err => ({ status: 599, body: { error: String(err?.message || err) } }))
      if (answer.status >= 400 || answer.body?.ok === false) { result.failed[name] = errorText(answer); continue }
      records[name] = { outcome: 'enabled', at }
      continue
    }
    if (satisfiesHermes(entry.requires_hermes, version) === false) {
      result.failed[name] = `needs Hermes ${entry.requires_hermes}; this is ${version}`
      continue
    }
    const answer = await deps.call('POST', 'dashboard/agent-plugins/install', { identifier: '', catalog_name: name, enable: true }, profile)
      .catch(err => ({ status: 599, body: { error: String(err?.message || err) } }))
    const body = answer.body && typeof answer.body === 'object' ? answer.body : {}
    if (answer.status >= 400 || body.ok === false || body.consent_required || body.scan_blocked) {
      result.failed[name] = body.consent_required ? 'Hermes asks for consent; install it from the Plugins page'
        : body.scan_blocked ? 'blocked by Hermes security scan' : errorText(answer)
      continue
    }
    const missingEnv = Array.isArray(body.missing_env) ? body.missing_env.map(String) : []
    records[name] = { outcome: 'installed', at, ...(missingEnv.length ? { missingEnv } : {}) }
  }

  result.done = Object.keys(records)
  try {
    await updateState(deps.stateFile, (next) => {
      const current = next.homes[home] || { profile, done: {} }
      current.profile = profile
      current.done = { ...current.done, ...records }
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
  for (const [name, error] of Object.entries(result.failed)) {
    logger.warn('[recommended-plugins] %s not installed profile=%s: %s (retry on next start)', name, profile, error)
  }
  return result
}

async function recordFailures(stateFile: string, home: string, profile: string, failed: Record<string, string>) {
  try {
    await updateState(stateFile, (next) => {
      const current = next.homes[home] || { profile, done: {} }
      const failures = { ...(current.lastFailure || {}) }
      for (const [name, error] of Object.entries(failed)) {
        failures[name] = { at: new Date().toISOString(), error, attempts: (failures[name]?.attempts || 0) + 1 }
      }
      current.lastFailure = failures
      next.homes[home] = current
    })
  } catch (err) {
    logger.warn(err, '[recommended-plugins] could not save state profile=%s', profile)
  }
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
        if (!existsSync(getProfileDir(profile))) continue
        await applyRecommendedPlugins(profile, deps)
      }
    } catch (err) {
      logger.warn(err, '[recommended-plugins] run failed (retry on next start)')
    }
  })
  return running
}

/** Required env names a plugin.yaml lists (strings or {name: ...}). */
export function requiredEnvNames(requiresEnv: Array<string | Record<string, unknown>> | undefined): string[] {
  return (requiresEnv || [])
    .map(item => typeof item === 'string' ? item : String((item as any)?.name || ''))
    .map(name => name.trim())
    .filter(Boolean)
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    let value = trimmed.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
    env[trimmed.slice(0, eq).replace(/^export\s+/, '').trim()] = value
  }
  return env
}

/** The profile's .env file and which of `names` are set neither there nor in Studio's environment. */
export function missingEnvFor(profileDir: string, names: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (!names.length) return []
  const file = join(profileDir, '.env')
  let saved: Record<string, string> = {}
  try { if (existsSync(file)) saved = parseEnvFile(readFileSync(file, 'utf-8')) } catch { /* unreadable: treat as unset */ }
  return names.filter(name => !String(saved[name] || env[name] || '').trim())
}
