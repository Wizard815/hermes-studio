import { readConfigYamlForProfile, updateConfigYamlForProfile } from '../../../studio/public/provider-config'
import { hermesApi } from '../hermes-api'

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
export function applyLocalProvider(config: Record<string, any>, status: LocalServerStatus, options: { defaultModel?: string } = {}): boolean {
  const before = JSON.stringify(config)
  const models = (status.models || []).map(model => String(model.id || '').trim()).filter(Boolean)
  const pooled = config.studio_provider_pool === 2
  const existing = pooled
    ? config.providers?.[HERMES_LOCAL_PROVIDER_KEY]
    : (Array.isArray(config.custom_providers) ? config.custom_providers : []).find((entry: any) => `custom:${entry?.name}` === HERMES_LOCAL_PROVIDER_KEY)
  const baseUrl = localServerApiUrl(status.server_base_url) || String(existing?.base_url || '')
  const selection = config.model && typeof config.model === 'object' ? config.model : undefined
  // A profile Hermes pointed at its own `llamacpp` provider moves to the gateway Provider.
  const legacyDefault = selection?.provider === HERMES_NATIVE_LOCAL_PROVIDER ? String(selection.default || '') : ''
  if (options.defaultModel && !models.includes(options.defaultModel)) models.push(options.defaultModel)
  if (legacyDefault && !models.includes(legacyDefault)) models.push(legacyDefault)
  if (!baseUrl || (!models.length && !existing)) return false

  const previousModels = existing?.models && typeof existing.models === 'object' ? existing.models : {}
  const entry = {
    ...existing,
    ...(pooled ? { name: HERMES_LOCAL_PROVIDER_NAME, catalog_provider: HERMES_LOCAL_PROVIDER_KEY, runtime_provider: HERMES_LOCAL_PROVIDER_KEY } : { name: 'hermes-local' }),
    base_url: baseUrl,
    // llama.cpp needs no key; the gateway still sends one.
    api_key: existing?.api_key || 'local',
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
    const changed = applyLocalProvider(config, status, { defaultModel })
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
