import { getApiKey, getBaseUrlValue } from '../client'
import { hermesAgent } from './agent-api'

/*
 * Hermes Agent tools, terminal, subagent routing, maintenance and job
 * templates, through Studio's private Hermes API (super administrators).
 */

// ---------- Toolsets ----------

export interface Toolset {
  name: string
  label: string
  description: string
  platform: string
  platform_label: string
  enabled: boolean
  configured: boolean
  tools: string[]
}

export interface ToolsetEnvVar { key: string; prompt: string; url?: string | null; default?: string | null; is_set: boolean }
export interface ToolsetProvider {
  name: string
  badge?: string
  tag?: string
  env_vars: ToolsetEnvVar[]
  post_setup?: string | null
  requires_nous_auth?: boolean
  managed_nous_feature?: string | null
  is_active: boolean
  status?: string
  capabilities?: string[]
  web_backend?: string
}
export interface ToolsetConfig {
  name: string
  has_category: boolean
  providers: ToolsetProvider[]
  active_provider: string | null
  active_search_backend?: string | null
  active_extract_backend?: string | null
}
export interface ToolsetModels {
  name: string
  has_models: boolean
  models: { id: string; display: string; speed?: string; strengths?: string; price?: string }[]
  current: string | null
  default: string | null
}

const enc = encodeURIComponent

export const listToolsets = () => hermesAgent<Toolset[]>('tools/toolsets')
export const setToolsetEnabled = (name: string, enabled: boolean) =>
  hermesAgent<{ ok: boolean; post_setup_started?: string | null }>(`tools/toolsets/${enc(name)}`, { method: 'PUT', body: { enabled } })
export const getToolsetConfig = (name: string) => hermesAgent<ToolsetConfig>(`tools/toolsets/${enc(name)}/config`)
export const getToolsetModels = (name: string, provider?: string) =>
  hermesAgent<ToolsetModels>(`tools/toolsets/${enc(name)}/models`, { query: { provider } })
export const setToolsetModel = (name: string, model: string, provider?: string) =>
  hermesAgent(`tools/toolsets/${enc(name)}/model`, { method: 'PUT', body: { model, provider } })
export const setToolsetProvider = (name: string, provider: string, capability?: 'search' | 'extract') =>
  hermesAgent<{ ok: boolean; needs_nous_auth?: boolean }>(`tools/toolsets/${enc(name)}/provider`, { method: 'PUT', body: { provider, ...(capability ? { capability } : {}) } })
export const saveToolsetKeys = (name: string, env: Record<string, string>) =>
  hermesAgent<{ saved: string[]; is_set: Record<string, boolean> }>(`tools/toolsets/${enc(name)}/env`, { method: 'PUT', body: { env } })
export const runToolsetSetup = (name: string, key: string) =>
  hermesAgent(`tools/toolsets/${enc(name)}/post-setup`, { method: 'POST', body: { key } })

/** Only keys the user typed something into; blank means "leave as is". Secrets are never read back. */
export function filledKeys(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) if (value && value.trim()) out[key] = value.trim()
  return out
}

// ---------- Terminal ----------

export interface TerminalBackend { name: string; label: string; description: string; active: boolean; status: 'ready' | 'needs_setup' | 'unavailable' | string; detail: string }
export const listTerminalBackends = () => hermesAgent<{ active: string; backends: TerminalBackend[] }>('tools/terminal/backends')
export const setTerminalBackend = (backend: string) => hermesAgent('tools/terminal/backend', { method: 'PUT', body: { backend } })

export type TerminalFieldType = 'text' | 'number' | 'switch'
export interface TerminalField { key: string; type: TerminalFieldType; placeholder?: string }

/** The `terminal.*` settings in config.yaml each backend reads. */
export const TERMINAL_FIELDS: Record<string, TerminalField[]> = {
  ssh: [
    { key: 'ssh_host', type: 'text', placeholder: '192.168.1.10' },
    { key: 'ssh_user', type: 'text', placeholder: 'root' },
    { key: 'ssh_port', type: 'number', placeholder: '22' },
    { key: 'ssh_key', type: 'text', placeholder: '~/.ssh/id_ed25519' },
  ],
  docker: [
    { key: 'docker_image', type: 'text', placeholder: 'python:3.12-slim' },
    { key: 'docker_network', type: 'text', placeholder: 'bridge' },
    { key: 'container_cpu', type: 'number', placeholder: '1' },
    { key: 'container_memory', type: 'number', placeholder: '5120' },
    { key: 'container_disk', type: 'number', placeholder: '51200' },
    { key: 'container_persistent', type: 'switch' },
  ],
  modal: [
    { key: 'modal_image', type: 'text', placeholder: 'python:3.12-slim' },
    { key: 'container_cpu', type: 'number' },
    { key: 'container_memory', type: 'number' },
    { key: 'container_persistent', type: 'switch' },
  ],
  daytona: [
    { key: 'daytona_image', type: 'text', placeholder: 'python:3.12-slim' },
    { key: 'container_cpu', type: 'number' },
    { key: 'container_memory', type: 'number' },
    { key: 'container_persistent', type: 'switch' },
  ],
}
/** Settings every backend shares. */
export const TERMINAL_COMMON_FIELDS: TerminalField[] = [
  { key: 'cwd', type: 'text', placeholder: '/root' },
  { key: 'timeout', type: 'number', placeholder: '180' },
]

function normalizeTerminalValue(field: TerminalField, value: any): string | number | boolean | null {
  if (field.type === 'switch') return value === true || value === 'true'
  if (field.type === 'number') {
    if (value === '' || value === null || value === undefined) return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return value === null || value === undefined ? '' : String(value).trim()
}

/** The settings the user changed, ready to save under `terminal`. */
export function terminalChanges(fields: TerminalField[], before: Record<string, any>, after: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const field of fields) {
    const next = normalizeTerminalValue(field, after[field.key])
    // A cleared number keeps its saved value: Studio's config save merges, it cannot remove a key.
    if (next === null) continue
    if (next !== normalizeTerminalValue(field, before[field.key])) out[field.key] = next
  }
  return out
}

export const WEEKDAY_CHOICES = ['everyday', 'weekdays', 'weekends']

export interface ComputerUseStatus { platform: string; platform_supported: boolean; installed: boolean; version: string | null; ready: boolean | null; can_grant: boolean; error: string | null }
export const getComputerUseStatus = () => hermesAgent<ComputerUseStatus>('tools/computer-use/status')

// ---------- Subagent routing ----------

export interface DelegationBackend { name: string; label: string; description: string; available: boolean; reason: string; builtin: boolean }
export interface ModelRoute { name: string; description: string; provider?: string; model: string; base_url?: string; api_key?: string; reasoning_effort?: string; original_name?: string; [key: string]: any }
export interface ProfileRoute { name: string; description?: string }
export interface DelegationRouting {
  configured: string
  blocked_reason: string | null
  backends: DelegationBackend[]
  model_map: { options: ModelRoute[]; default: string | null }
  profile_routes: { profiles: ProfileRoute[]; default: string | null }
  profiles: string[]
}
export const getDelegationRouting = () => hermesAgent<DelegationRouting>('delegation/routing')
export const setDelegationBackend = (backend: string) => hermesAgent('delegation/backend', { method: 'PUT', body: { backend } })
export const saveModelRoutes = (options: ModelRoute[], defaultName: string | null) =>
  hermesAgent('delegation/backends/model_map', { method: 'PUT', body: { options, default: defaultName || null } })
export const saveProfileRoutes = (profiles: ProfileRoute[], defaultName: string | null) =>
  hermesAgent('delegation/backends/profile_routes', { method: 'PUT', body: { profiles, default: defaultName || null } })

/** A default that is no longer in the list is dropped (Hermes refuses it). */
export function routeDefault(names: string[], current: string | null): string | null {
  return current && names.includes(current) ? current : null
}

// ---------- Maintenance ----------

export interface ActionStatus { name: string; running: boolean; exit_code: number | null; pid: number | null; lines: string[] }
export type MaintenanceAction = 'doctor' | 'security-audit' | 'prompt-size' | 'backup' | 'import' | 'checkpoints-prune' | 'tools-post-setup'
export const getActionStatus = (name: MaintenanceAction, lines = 400) => hermesAgent<ActionStatus>(`actions/${name}/status`, { query: { lines } })
export const runDoctor = () => hermesAgent('ops/doctor', { method: 'POST' })
export const runSecurityAudit = () => hermesAgent('ops/security-audit', { method: 'POST' })
export const runPromptSize = () => hermesAgent('ops/prompt-size', { method: 'POST' })
export const runBackup = () => hermesAgent<{ archive?: string }>('ops/backup', { method: 'POST', body: {} })
export const runImport = (archive: string, force: boolean) => hermesAgent('ops/import', { method: 'POST', body: { archive, force } })
export const listCheckpoints = () => hermesAgent<{ sessions: { session: string; files: number; bytes: number }[]; total_bytes: number }>('ops/checkpoints')
export const pruneCheckpoints = () => hermesAgent('ops/checkpoints/prune', { method: 'POST' })

export interface HermesHook { event: string; matcher?: string | null; command: string; timeout?: number | null; allowed: boolean; approved_at?: string | null; executable: boolean }
export const listHooks = () => hermesAgent<{ hooks: HermesHook[]; valid_events: string[] }>('ops/hooks')
export const addHook = (hook: { event: string; command: string; matcher?: string; timeout?: number | null; approve: boolean }) =>
  hermesAgent('ops/hooks', { method: 'POST', body: hook })
export const deleteHook = (event: string, command: string) => hermesAgent('ops/hooks', { method: 'DELETE', body: { event, command } })

export interface UpdateCheck { install_method: string; current_version: string; behind: number | null; update_available: boolean; update_command: string; message: string | null }
export const checkForUpdate = (force = false) => hermesAgent<UpdateCheck>('hermes/update/check', { query: { force: force || undefined } })

/** Downloads a backup archive Hermes wrote (through Studio, with the signed-in user's token). */
export async function downloadBackup(archive: string): Promise<void> {
  const headers: Record<string, string> = {}
  const token = getApiKey()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${getBaseUrlValue()}/api/hermes-agent/ops/backup/download?archive=${enc(archive)}`, { headers })
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.trim())
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = archive.split(/[\\/]/).pop() || 'hermes-backup.zip'
  a.click()
  URL.revokeObjectURL(url)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${i === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

/** Strips terminal colour codes from a command's output. */
export function cleanLogLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

/** ok / warning / error for a doctor or audit line, from its leading mark. */
export function logLineLevel(line: string): 'ok' | 'warn' | 'error' | 'heading' | 'plain' {
  const text = line.trim()
  if (/^[✓✔]/.test(text)) return 'ok'
  if (/^[⚠!]/.test(text)) return 'warn'
  if (/^[✗✘×]/.test(text)) return 'error'
  if (/^[◆#]/.test(text)) return 'heading'
  return 'plain'
}

// ---------- Job templates (cron blueprints) ----------

export interface BlueprintField { name: string; type: 'time' | 'enum' | 'text' | 'weekdays' | string; label: string; default: any; options: string[]; optional: boolean; strict: boolean; help: string }
export interface Blueprint { key: string; title: string; description: string; category: string; tags: string[]; fields: BlueprintField[]; scheduleHuman?: string; source?: string }
export const listBlueprints = () => hermesAgent<{ blueprints: Blueprint[] }>('cron/blueprints')
export const instantiateBlueprint = (blueprint: string, values: Record<string, any>) =>
  hermesAgent('cron/blueprints/instantiate', { method: 'POST', body: { blueprint, values } })

export function blueprintDefaults(blueprint: Blueprint): Record<string, any> {
  const values: Record<string, any> = {}
  for (const field of blueprint.fields) values[field.name] = field.default ?? ''
  return values
}

/** Values to send: optional fields left blank are omitted. */
export function blueprintValues(blueprint: Blueprint, values: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const field of blueprint.fields) {
    const value = values[field.name]
    if (value === undefined || value === null || value === '') continue
    out[field.name] = typeof value === 'string' ? value.trim() : value
  }
  return out
}

/** First required field without a value, if any. */
export function missingBlueprintField(blueprint: Blueprint, values: Record<string, any>): BlueprintField | undefined {
  return blueprint.fields.find(field => !field.optional && (values[field.name] === undefined || values[field.name] === null || String(values[field.name]).trim() === ''))
}
