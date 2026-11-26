import { hermesAgent } from './agent-api'

/* Hermes Agent memory providers, skills hub, skill locks and curator (through Studio's passthrough). */

export type MemoryProviderStatus = 'ready' | 'needs_config' | 'unavailable' | 'missing' | string

export interface MemoryProviderSetupInfo {
  pip_dependencies?: string[]
  python_dependencies_declared?: boolean
  external_dependencies?: { name: string; install?: string; check?: string }[]
  required_env?: string[]
  dependencies_installed?: boolean
}

export interface MemoryProviderRow {
  name: string
  description: string
  available: boolean
  configured: boolean
  status: MemoryProviderStatus
  setup?: MemoryProviderSetupInfo
}

export interface MemoryOverview {
  active: string
  providers: MemoryProviderRow[]
  builtin_files: { memory: number; user: number }
}

export interface MemoryProviderFieldOption { value: string; label: string; description?: string }

export interface MemoryProviderField {
  key: string
  label: string
  /** legacy: text | secret | select | boolean | integer | number; declared: text | secret | select | bool | number | json */
  kind: string
  description?: string
  placeholder?: string
  required?: boolean
  value: string | number | boolean | null
  is_set: boolean
  options?: MemoryProviderFieldOption[]
  url?: string
  when?: Record<string, unknown> | null
  minimum?: number | null
  maximum?: number | null
  step?: number | null
}

export interface MemoryProviderConfig {
  name: string
  label: string
  docs_url?: string
  fields: MemoryProviderField[]
  setup?: MemoryProviderSetupInfo
  /** Which Hermes config surface these fields came from. */
  surface: 'declared' | 'legacy'
}

export interface MemoryProviderSetupResult {
  ok: boolean
  provider: string
  results: { kind: string; name: string; status: string; command: string; returncode: number | null; stdout: string; stderr: string }[]
  status?: MemoryProviderRow | null
}

export const getMemoryOverview = () => hermesAgent<MemoryOverview>('memory')
export const setMemoryProvider = (provider: string) => hermesAgent<{ ok: boolean; active: string }>('memory/provider', { method: 'PUT', body: { provider } })
export const resetBuiltinMemory = (target: 'all' | 'memory' | 'user') => hermesAgent<{ ok: boolean; deleted: string[] }>('memory/reset', { method: 'POST', body: { target } })

/** A provider's settings: a provider that declares a config panel uses it, others their own schema. */
export async function getMemoryProviderConfig(name: string): Promise<MemoryProviderConfig> {
  const path = `memory/providers/${encodeURIComponent(name)}/config`
  const declared = await hermesAgent<Omit<MemoryProviderConfig, 'surface'>>(path, { query: { surface: 'declared' } }).catch(() => null)
  if (declared?.fields?.length) return { ...declared, surface: 'declared' }
  const legacy = await hermesAgent<Omit<MemoryProviderConfig, 'surface'>>(path)
  return { ...legacy, fields: legacy.fields || [], surface: 'legacy' }
}

export const saveMemoryProviderConfig = (name: string, surface: MemoryProviderConfig['surface'], values: Record<string, unknown>) =>
  hermesAgent<{ ok: boolean; active?: string }>(`memory/providers/${encodeURIComponent(name)}/config`, {
    method: 'PUT', body: { values }, query: { surface: surface === 'declared' ? 'declared' : undefined },
  })

export const runMemoryProviderSetup = (name: string, values: Record<string, unknown> = {}) =>
  hermesAgent<MemoryProviderSetupResult>(`memory/providers/${encodeURIComponent(name)}/setup`, { method: 'POST', body: { values } })

/** Form value for a field as the editor holds it (secrets always start blank: never echoed back). */
export function initialFieldValue(field: MemoryProviderField): string | number | boolean | null {
  if (field.kind === 'secret') return ''
  if (field.kind === 'boolean' || field.kind === 'bool') return field.value === true || String(field.value).toLowerCase() === 'true'
  if (field.kind === 'integer' || field.kind === 'number') {
    if (field.value === '' || field.value === null || field.value === undefined) return null
    const n = Number(field.value)
    return Number.isFinite(n) ? n : null
  }
  return field.value === null || field.value === undefined ? '' : String(field.value)
}

/** Whether a field shows, given the other fields' current form values (Hermes's `when`). */
export function fieldVisible(field: MemoryProviderField, values: Record<string, unknown>): boolean {
  if (!field.when || typeof field.when !== 'object') return true
  return Object.entries(field.when).every(([key, expected]) => String(values[key] ?? '') === String(expected))
}

/** Values to send: blank secrets are left out so a stored key is kept; hidden fields are skipped. */
export function buildSubmitValues(fields: MemoryProviderField[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (!fieldVisible(field, values)) continue
    const value = values[field.key]
    if (field.kind === 'secret') {
      if (typeof value === 'string' && value.trim()) out[field.key] = value.trim()
      continue
    }
    out[field.key] = value === null || value === undefined ? '' : value
  }
  return out
}

export function providerStatusType(status: MemoryProviderStatus): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'ready') return 'success'
  if (status === 'needs_config') return 'warning'
  if (status === 'unavailable' || status === 'missing') return 'error'
  return 'default'
}

/** "retaindb" -> "Retaindb", "open_viking" -> "Open Viking"; known names keep their brand spelling. */
const PROVIDER_LABELS: Record<string, string> = {
  honcho: 'Honcho', mem0: 'Mem0', hindsight: 'Hindsight', holographic: 'Holographic', retaindb: 'RetainDB',
  byterover: 'ByteRover', supermemory: 'Supermemory', openviking: 'OpenViking', memori: 'Memori',
}
export function providerLabel(name: string): string {
  if (PROVIDER_LABELS[name]) return PROVIDER_LABELS[name]
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ---- Skills (Hermes's own view: locks, hub) ----

export interface HermesSkillRow { name: string; description: string; category: string | null; locked: boolean; enabled: boolean; usage: number; provenance: string }
export const listHermesSkills = () => hermesAgent<HermesSkillRow[]>('skills')
export const setSkillLocked = (name: string, locked: boolean) => hermesAgent<{ ok: boolean }>('skills/lock', { method: 'PUT', body: { name, locked } })

export interface HubSkill {
  name: string
  description: string
  source: string
  identifier: string
  trust_level: string
  repo?: string | null
  tags: string[]
  category?: string
  installed?: boolean
}
export interface HubSources {
  sources: { id: string; label: string; available?: boolean; rate_limited?: boolean; searchable?: boolean }[]
  index_available: boolean
  featured: HubSkill[]
  installed: Record<string, { name?: string } & Record<string, unknown>>
}
export interface HubSearchResult { results: HubSkill[]; source_counts: Record<string, number>; timed_out: string[]; installed: HubSources['installed'] }
export interface HubPreview extends HubSkill { skill_md: string; files: string[] }
export interface HubAction { ok: boolean; pid: number; name: string }
export interface ActionStatus { name: string; running: boolean; exit_code: number | null; lines: string[] }

export const getHubSources = () => hermesAgent<HubSources>('skills/hub/sources')
export const getOfficialCatalog = () => hermesAgent<{ skills: HubSkill[] }>('skills/hub/official')
export const searchHub = (q: string, source = 'all') => hermesAgent<HubSearchResult>('skills/hub/search', { query: { q, source, limit: 30 } })
export const previewHubSkill = (identifier: string) => hermesAgent<HubPreview>('skills/hub/preview', { query: { identifier } })
export const installHubSkill = (identifier: string) => hermesAgent<HubAction>('skills/hub/install', { method: 'POST', body: { identifier } })
export const uninstallHubSkill = (name: string) => hermesAgent<HubAction>('skills/hub/uninstall', { method: 'POST', body: { name } })
export const getActionStatus = (name: string) => hermesAgent<ActionStatus>(`actions/${encodeURIComponent(name)}/status`, { query: { lines: 40 } })

/** Poll a background Hermes action until it ends; resolves with its last status. */
export async function waitForAction(name: string, { intervalMs = 1500, timeoutMs = 300_000, sleep = (ms: number) => new Promise(r => setTimeout(r, ms)) } = {}): Promise<ActionStatus> {
  const started = Date.now()
  for (;;) {
    const status = await getActionStatus(name)
    if (!status.running) return status
    if (Date.now() - started > timeoutMs) return status
    await sleep(intervalMs)
  }
}

/** Installed-entry for a hub skill (ClawHub search hits use a bare slug; the lock answers to `clawhub/<slug>`). */
export function hubInstalledEntry(skill: HubSkill, installed: HubSources['installed']): ({ name?: string } & Record<string, unknown>) | null {
  if (installed[skill.identifier]) return installed[skill.identifier]
  if (skill.source === 'clawhub' && installed[`clawhub/${skill.identifier}`]) return installed[`clawhub/${skill.identifier}`]
  return skill.installed ? {} : null
}

// ---- Curator ----

export interface CuratorStatus {
  enabled: boolean
  paused: boolean
  interval_hours: number | null
  last_run_at: string | null
  min_idle_hours: number | null
  stale_after_days: number | null
  archive_after_days: number | null
}
export const getCurator = () => hermesAgent<CuratorStatus>('curator')
export const setCuratorPaused = (paused: boolean) => hermesAgent<{ ok: boolean; paused: boolean }>('curator/paused', { method: 'PUT', body: { paused } })
export const runCurator = () => hermesAgent<HubAction>('curator/run', { method: 'POST' })
