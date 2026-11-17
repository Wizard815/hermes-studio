import { readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readConfigYamlForProfile, updateConfigYamlForProfile } from '../../../studio/public/provider-config'
import { hermesApi } from '../hermes-api'
import { getHermesBaseDir } from '../profiles/profile'

/**
 * Hermes Agent's local models (its llama.cpp engine, Models → Local models) as
 * a Provider of Studio's model gateway.
 *
 * Hermes downloads, loads and serves the models; Studio registers its
 * OpenAI-compatible llama.cpp server as the account Provider `custom:hermes-local`,
 * so Studio chats, Hermes (through the gateway), Ekko, coding agents, jobs and
 * herdr panes all pick local models the same way as any other model.
 */

export const HERMES_LOCAL_PROVIDER_KEY = 'custom:hermes-local'
export const HERMES_LOCAL_PROVIDER_NAME = 'Hermes local'
/** The provider Hermes itself writes for a local model (`hermes` before Studio's gateway). */
export const HERMES_NATIVE_LOCAL_PROVIDER = 'llamacpp'
/** Every name Hermes accepts for its llama.cpp provider. */
export const HERMES_NATIVE_LOCAL_PROVIDERS = new Set(['llamacpp', 'llama.cpp', 'llama-cpp'])
/** Hermes's managed llama-server listens here unless the port is taken. */
export const HERMES_LOCAL_DEFAULT_SERVER = 'http://127.0.0.1:18434'

export interface ManagedLocalServer { base_url: string; api_key: string }

/**
 * Hermes's managed llama-server as Hermes recorded it
 * (`<HERMES_HOME>/runtimes/llamacpp/server.json`: its address and the API key it
 * was started with), or null when it is not running.
 */
export function readManagedLocalServer(root = getHermesBaseDir(), proc = '/proc'): ManagedLocalServer | null {
  let state: Record<string, any>
  try { state = JSON.parse(readFileSync(join(root, 'runtimes', 'llamacpp', 'server.json'), 'utf8')) } catch { return null }
  const baseUrl = typeof state?.base_url === 'string' ? state.base_url.trim() : ''
  if (!baseUrl) return null
  // A state file left by a stopped server (or an older container) names a process that is gone.
  const pid = Number(state.pid)
  if (Number.isSafeInteger(pid) && pid > 0 && typeof state.executable === 'string' && state.executable) {
    let exe = ''
    try { exe = readlinkSync(join(proc, String(pid), 'exe')) } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null
      exe = state.executable // no /proc here (macOS, Windows): trust the file
    }
    if (exe.replace(/ \(deleted\)$/, '') !== state.executable) return null
  }
  return { base_url: baseUrl, api_key: typeof state.api_key === 'string' ? state.api_key : '' }
}

/** The stable key Hermes starts its llama-server with (`--api-key`), once it exists. */
function readManagedLocalKey(root = getHermesBaseDir()): string {
  try { return readFileSync(join(root, 'runtimes', 'llamacpp', '.api_key'), 'utf8').trim() } catch { return '' }
}

export class LocalServerNotRunningError extends Error {
  status = 503
  constructor() { super('The Hermes local model server is not running. Start it in Studio: Models → Local models (or pick another model).') }
}

/**
 * The gateway's upstream for `custom:hermes-local`: Hermes's llama-server where
 * it is running now, with the key it was started with (its port can change
 * when the stable one is busy, and it refuses requests without the key).
 */
export function resolveHermesLocalUpstream<T extends { provider: string; baseUrl?: string; apiKey?: string }>(resolved: T, server = readManagedLocalServer()): T {
  if (resolved.provider !== HERMES_LOCAL_PROVIDER_KEY) return resolved
  if (!server) throw new LocalServerNotRunningError()
  return { ...resolved, baseUrl: localServerApiUrl(server.base_url), ...(server.api_key ? { apiKey: server.api_key } : {}) }
}

export interface LocalServerStatus {
  server_base_url?: string | null
  models?: Array<{ id: string }>
}

/** llama.cpp's OpenAI-compatible API lives under /v1. */
export function localServerApiUrl(baseUrl: string | null | undefined): string {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return ''
  return /\/v1$/.test(url) ? url : `${url}/v1`
}

/**
 * Register (or refresh) the local Provider in a profile's provider config and,
 * when asked, make one of its models the profile's default. Returns whether
 * anything changed. Pure: no I/O.
 */
export function applyLocalProvider(config: Record<string, any>, status: LocalServerStatus, options: { defaultModel?: string; apiKey?: string } = {}): boolean {
  const before = JSON.stringify(config)
  const models = (status.models || []).map(model => String(model.id || '').trim()).filter(Boolean)
  const pooled = config.studio_provider_pool === 2
  const existing = pooled
    ? config.providers?.[HERMES_LOCAL_PROVIDER_KEY]
    : (Array.isArray(config.custom_providers) ? config.custom_providers : []).find((entry: any) => `custom:${entry?.name}` === HERMES_LOCAL_PROVIDER_KEY)
  const baseUrl = localServerApiUrl(status.server_base_url) || String(existing?.base_url || '')
  const selection = config.model && typeof config.model === 'object' ? config.model : undefined
  // A profile Hermes pointed at its own `llamacpp` provider moves to the gateway Provider.
  const legacyDefault = HERMES_NATIVE_LOCAL_PROVIDERS.has(String(selection?.provider || '').toLowerCase()) ? String(selection.default || '') : ''
  if (options.defaultModel && !models.includes(options.defaultModel)) models.push(options.defaultModel)
  if (legacyDefault && !models.includes(legacyDefault)) models.push(legacyDefault)
  if (!baseUrl || (!models.length && !existing)) return false

  const previousModels = existing?.models && typeof existing.models === 'object' ? existing.models : {}
  const entry = {
    ...existing,
    ...(pooled ? { name: HERMES_LOCAL_PROVIDER_NAME, catalog_provider: HERMES_LOCAL_PROVIDER_KEY, runtime_provider: HERMES_LOCAL_PROVIDER_KEY } : { name: 'hermes-local' }),
    base_url: baseUrl,
    // Hermes starts its llama-server with a key; the gateway also reads it from Hermes per request.
    api_key: options.apiKey || existing?.api_key || 'local',
    api_mode: 'chat_completions',
    model: options.defaultModel || (existing?.model && models.includes(existing.model) ? existing.model : models[0] || existing?.model || ''),
    models: Object.fromEntries(models.map(id => [id, previousModels[id] || {}])),
  }
  if (pooled) {
    config.providers = { ...(config.providers || {}), [HERMES_LOCAL_PROVIDER_KEY]: entry }
  } else {
    const list = Array.isArray(config.custom_providers) ? config.custom_providers : []
    config.custom_providers = existing ? list.map((item: any) => item === existing ? entry : item) : [...list, entry]
  }
  const defaultModel = options.defaultModel || legacyDefault
  if (defaultModel) {
    const next = { ...(selection || {}) }
    delete next.base_url
    delete next.api_key
    config.model = { ...next, provider: HERMES_LOCAL_PROVIDER_KEY, default: defaultModel }
  }
  return JSON.stringify(config) !== before
}

async function localStatus(profile: string): Promise<LocalServerStatus> {
  const result = await hermesApi.request('GET', 'local-models/status', new URLSearchParams(), undefined, profile)
  if (result.status >= 400) throw Object.assign(new Error(`Hermes local models are unavailable (${result.status})`), { status: 502 })
  return JSON.parse(result.body.toString('utf8') || '{}') as LocalServerStatus
}

/** Bring the local Provider in line with Hermes's local models; optionally make one the profile's default. */
export async function syncHermesLocalProvider(profile: string, defaultModel?: string): Promise<{ provider: string; registered: boolean; base_url: string; models: string[] }> {
  const status = await localStatus(profile)
  if (defaultModel && !localServerApiUrl(status.server_base_url)) {
    const current = await readConfigYamlForProfile(profile)
    const known = current.providers?.[HERMES_LOCAL_PROVIDER_KEY]?.base_url
      || (Array.isArray(current.custom_providers) ? current.custom_providers : []).find((entry: any) => `custom:${entry?.name}` === HERMES_LOCAL_PROVIDER_KEY)?.base_url
    if (!known) throw Object.assign(new Error('Start the local model server first (Local models → Start).'), { status: 409 })
  }
  await updateConfigYamlForProfile(profile, config => {
    const changed = applyLocalProvider(config, status, { defaultModel, apiKey: readManagedLocalKey() || undefined })
    return changed ? config : { data: config, write: false, result: undefined }
  })
  return describeLocalProvider(profile)
}

/** The local Provider as Studio sees it for a profile. */
export async function describeLocalProvider(profile: string): Promise<{ provider: string; registered: boolean; base_url: string; models: string[]; default_model: string }> {
  const config = await readConfigYamlForProfile(profile)
  const entry = config.providers?.[HERMES_LOCAL_PROVIDER_KEY]
    || (Array.isArray(config.custom_providers) ? config.custom_providers : []).find((item: any) => `custom:${item?.name}` === HERMES_LOCAL_PROVIDER_KEY)
  const selection = config.model && typeof config.model === 'object' ? config.model : {}
  return {
    provider: HERMES_LOCAL_PROVIDER_KEY,
    registered: !!entry,
    base_url: String(entry?.base_url || ''),
    models: Object.keys(entry?.models || {}),
    default_model: selection.provider === HERMES_LOCAL_PROVIDER_KEY ? String(selection.default || '') : '',
  }
}

/**
 * A profile whose Hermes default is its own llama.cpp provider (`llamacpp`, from
 * before Studio's gateway) moves onto `custom:hermes-local` without waiting for
 * the Local models tab, so Hermes chats, jobs and herdr panes keep that model.
 * Cheap when there is nothing to move: runs before every Hermes projection.
 */
export async function adoptNativeLocalDefault(profile: string): Promise<boolean> {
  const current = await readConfigYamlForProfile(profile)
  const selection = current.model && typeof current.model === 'object' ? current.model : undefined
  if (!selection || !HERMES_NATIVE_LOCAL_PROVIDERS.has(String(selection.provider || '').toLowerCase())) return false
  const server = readManagedLocalServer()
  const status: LocalServerStatus = { server_base_url: server?.base_url || HERMES_LOCAL_DEFAULT_SERVER, models: [] }
  const changed = await updateConfigYamlForProfile<boolean>(profile, config => {
    const changed = applyLocalProvider(config, status, { apiKey: server?.api_key || readManagedLocalKey() || undefined })
    return { data: config, write: changed, result: changed }
  })
  return changed ?? false
}
