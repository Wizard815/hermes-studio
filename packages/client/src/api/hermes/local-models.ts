import { hermesAgent } from './agent-api'
import { request } from '../client'

/**
 * Hermes Agent's local models (a llama.cpp runtime Hermes manages, through
 * Studio's Hermes Agent passthrough) and the key pools of Studio's account
 * Providers. Local models reach chats as the model gateway Provider
 * `custom:hermes-local`; pooled keys are rotated by the gateway.
 */

export interface LocalModelsStatus {
  enabled: boolean
  tag: string | null
  configured_tag: string | null
  update_available: boolean
  runtime_installed: boolean
  runtime_backend: string | null
  server_running: boolean
  server_base_url: string | null
  active_model_id: string | null
  loaded_models: Record<string, string>
  loading: Record<string, unknown>
  placement: Record<string, { window_label?: string; granted_window_label?: string; spilled?: boolean }>
  models: Array<{ id: string; size_bytes: number; size_label: string }>
  models_dir: string
}

export interface LocalHardware {
  uma: boolean
  vram_total_bytes: number
  vram_usable_bytes: number
  ram_total_bytes: number
  ram_available_bytes: number
  vram_label: string
  gpu_name: string | null
  gpu_util_percent: number | null
  vram_used_bytes: number | null
}

export interface LocalCatalogModel {
  id: string
  display_name: string
  description: string
  native_context_label: string
  recommended: boolean
  recommended_reason: string | null
  downloaded: boolean
  downloaded_model_id: string | null
  downloaded_quant: string | null
  vision: boolean
  needs_engine: boolean
  min_engine: string | null
  fits: boolean
  size_label: string
  fit_summary: string
  fit_detail?: string
  quant?: string
}

export interface LocalJob {
  job_id: string
  kind: string
  target: string
  model_id: string | null
  status: 'running' | 'paused' | 'done' | 'error'
  phase: string
  detail: string
  total_bytes: number | null
  done_bytes: number
  started_at: number
  error: string | null
  percent?: number
  bytes_per_sec?: number
  eta_seconds?: number | null
  can_pause?: boolean
  can_resume?: boolean
  pause_requested?: boolean
}

export interface HfModelHit { repo: string; downloads: number; likes: number; updated: string; gated: boolean }
export interface HfFileGroup { label: string; paths: string[]; total_bytes: number; fit: 'fits-gpu' | 'needs-ram' | 'too-big' | 'unknown' | string }

type Q = Record<string, string | number | boolean | undefined>
const lm = <T>(path: string, profile: string | undefined, init: { method?: string; body?: unknown; query?: Q } = {}) =>
  hermesAgent<T>(`local-models/${path}`, { ...init, query: { ...(init.query || {}), profile: profile || undefined } })

export const getLocalStatus = (profile?: string) => lm<LocalModelsStatus>('status', profile)
export const getLocalHardware = (profile?: string) => lm<LocalHardware>('hardware', profile)
export const getLocalCatalog = (profile?: string) => lm<{ models: LocalCatalogModel[] }>('catalog', profile)
export const getLocalJobs = (profile?: string) => lm<{ jobs: LocalJob[] }>('jobs', profile)
export const searchHuggingFace = (q: string, profile?: string) => lm<{ hits: HfModelHit[] }>('search', profile, { query: { q, limit: 20 } })
export const listHuggingFaceFiles = (repo: string, profile?: string) => lm<{ files: HfFileGroup[] }>('search/files', profile, { query: { repo } })
export const installLocalRuntime = (profile?: string) => lm<{ job_id: string }>('runtime/install', profile, { method: 'POST', body: {} })
export const downloadLocalModel = (modelId: string, profile?: string) => lm<{ job_id: string | null; already_downloaded?: boolean }>('download', profile, { method: 'POST', body: { model_id: modelId } })
export const downloadBrowsedModel = (repo: string, paths: string[], profile?: string) => lm<{ job_id: string | null; already_downloaded?: boolean }>('download-browsed', profile, { method: 'POST', body: { repo, paths } })
export const pauseLocalJob = (jobId: string, profile?: string) => lm('download/pause', profile, { method: 'POST', body: { job_id: jobId } })
export const resumeLocalJob = (jobId: string, profile?: string) => lm('download/resume', profile, { method: 'POST', body: { job_id: jobId } })
export const activateLocalModel = (modelId: string, profile?: string) => lm<{ job_id: string }>('activate', profile, { method: 'POST', body: { model_id: modelId } })
export const ejectLocalModel = (modelId: string, profile?: string) => lm('eject', profile, { method: 'POST', body: { model_id: modelId } })
export const deleteLocalModel = (modelId: string, profile?: string) => lm(`models/${encodeURIComponent(modelId)}`, profile, { method: 'DELETE' })
export const localQuickstart = (profile?: string) => lm<{ job_id: string; display_name: string }>('quickstart', profile, { method: 'POST', body: {} })
export const setLocalServer = (action: 'start' | 'stop', profile?: string) => lm('server', profile, { method: 'POST', body: { action } })
export const sideloadLocalModel = (path: string, profile?: string) => lm<{ model_id: string; already_present?: boolean }>('sideload', profile, { method: 'POST', body: { path } })

// ── local models as a model gateway Provider ─────────────

export interface LocalProviderInfo { provider: string; registered: boolean; base_url: string; models: string[]; default_model?: string }
const profileQuery = (profile?: string) => profile ? `?profile=${encodeURIComponent(profile)}` : ''
export const getLocalProvider = (profile?: string) => request<LocalProviderInfo>(`/api/hermes/model-local-provider${profileQuery(profile)}`)
/** Register or refresh Studio's `custom:hermes-local` Provider; with a model, make it the profile's default. */
export const syncLocalProvider = (profile?: string, defaultModel?: string) => request<LocalProviderInfo>(`/api/hermes/model-local-provider${profileQuery(profile)}`, {
  method: 'POST', body: JSON.stringify(defaultModel ? { default_model: defaultModel } : {}),
})

// ── key pools on account Providers ───────────────────────────

export interface PoolEntry { index: number; id: string; label: string; auth_type: string; source: string; last_status: string | null; request_count: number; token_preview: string }
export interface PoolProvider { provider: string; entries: PoolEntry[] }
export const getCredentialPools = () => request<{ providers: PoolProvider[] }>('/api/hermes/model-key-pools')
export const addPoolKey = (provider: string, apiKey: string, label: string) =>
  request('/api/hermes/model-key-pools', { method: 'POST', body: JSON.stringify({ provider, api_key: apiKey, label: label || undefined }) })
export const removePoolKey = (provider: string, index: number) =>
  request(`/api/hermes/model-key-pools/${encodeURIComponent(provider)}/${index}`, { method: 'DELETE' })

// ── pure helpers ─────────────────────────────────────────────

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '0 MB'
  const gb = bytes / (1 << 30)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / (1 << 20)))} MB`
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return ''
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Jobs to show: running and paused first, then the latest few finished ones. */
export function visibleJobs(jobs: LocalJob[], finished = 3): LocalJob[] {
  const active = jobs.filter(job => job.status === 'running' || job.status === 'paused')
  const settled = jobs.filter(job => job.status === 'done' || job.status === 'error').slice(0, finished)
  return [...active, ...settled]
}

export const hasActiveJob = (jobs: LocalJob[]) => jobs.some(job => job.status === 'running')
