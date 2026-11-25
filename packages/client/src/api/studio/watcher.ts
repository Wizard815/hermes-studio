import { request } from '../client'
import type { CronApprovalMode, TaskApprovalMode, TrustRule, WatcherEvent, WatcherExtraStatus, WatcherSettings } from '../../../../shared/watcher'

/** The Watcher (docs/watcher.md): the bell's feed, Settings → Watcher and trust rules. */
const base = '/api/studio/watcher'

export interface WatcherList { events: WatcherEvent[]; unread: number; total: number }
export interface WatcherSettingsResponse { settings: WatcherSettings; extras: WatcherExtraStatus[] }
export type TrustRuleInput = Pick<TrustRule, 'kind' | 'scope' | 'target' | 'pattern'> & { expiresAt?: number; note?: string }

export const fetchWatcherEvents = (limit = 50) => request<WatcherList>(`${base}/events?limit=${limit}`)
export const markWatcherRead = (ids: number[]) =>
  request<{ unread: number }>(`${base}/events/read`, { method: 'POST', body: JSON.stringify({ ids }) })
export const markAllWatcherRead = () =>
  request<{ unread: number }>(`${base}/events/read`, { method: 'POST', body: JSON.stringify({ all: true }) })
export const clearWatcherEvents = (ids?: number[]) =>
  request<{ unread: number }>(`${base}/events/clear`, { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) })
export const fetchWatcherSettings = () => request<WatcherSettingsResponse>(`${base}/settings`)
export const saveWatcherSettings = (settings: Partial<WatcherSettings> & Record<string, unknown>) =>
  request<WatcherSettingsResponse>(`${base}/settings`, { method: 'PUT', body: JSON.stringify({ settings }) })
export const fetchTrustRules = () => request<{ rules: TrustRule[] }>(`${base}/trust`)
export const addTrustRule = (rule: TrustRuleInput) =>
  request<{ rule: TrustRule; rules: TrustRule[] }>(`${base}/trust`, { method: 'POST', body: JSON.stringify(rule) })
export const removeTrustRule = (id: string) =>
  request<{ rules: TrustRule[] }>(`${base}/trust/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const fetchTaskApprovalMode = (taskId: string) =>
  request<{ sessionId: string; mode: TaskApprovalMode }>(`${base}/tasks/${encodeURIComponent(taskId)}/approval-mode`)
export const saveTaskApprovalMode = (taskId: string, mode: TaskApprovalMode) =>
  request<{ sessionId: string; mode: TaskApprovalMode }>(`${base}/tasks/${encodeURIComponent(taskId)}/approval-mode`, { method: 'PUT', body: JSON.stringify({ mode }) })
export const fetchCronApprovalMode = () => request<{ mode: CronApprovalMode }>('/api/hermes/jobs/approval-mode')
export const saveCronApprovalMode = (mode: CronApprovalMode) =>
  request<{ mode: CronApprovalMode }>('/api/hermes/jobs/approval-mode', { method: 'PUT', body: JSON.stringify({ mode }) })

/** The clean rooms' settings (docs/cleanroom.md); they live with the coding agents. */
export interface CleanRoomSettings {
  image: string
  network: 'studio' | 'allowlist' | 'internet'
  allowHosts: string[]
  cpus: number
  memory: string
  pids: number
  readOnlyRoot: boolean
  dropAllCaps: boolean
  capAdd: string[]
  user: 'auto' | 'room' | 'root'
  selfCheck: boolean
  leakCheck: boolean
  egressLog: boolean
  auditChain: boolean
  allowWebTools: boolean
}

export const fetchCleanRoomSettings = () => request<CleanRoomSettings>('/api/coding-agents/cleanroom/settings')
export const saveCleanRoomSettings = (settings: Partial<CleanRoomSettings>) =>
  request<CleanRoomSettings>('/api/coding-agents/cleanroom/settings', { method: 'PUT', body: JSON.stringify(settings) })
