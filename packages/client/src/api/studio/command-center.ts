import { request } from '../client'

/** Command Center in the herdr page's Tools dock (server: modules/studio/services/command-center). */

export interface CommandCenterSettings { github: { enabled: boolean; repos: string[] } }

export interface GithubItem {
  id: string
  kind: 'ci' | 'review'
  repo: string
  title: string
  url: string
  number?: number
  at: number
  detail?: string
}

export interface GithubInbox {
  enabled: boolean
  available: boolean
  signedIn: boolean
  login?: string
  repos: string[]
  items: GithubItem[]
  error?: string
  checkedAt: number
}

export interface AgentContext {
  sessionId: string
  agent: string
  model: string
  provider: string
  profile: string
  contextTokens: number | null
  contextWindow: number | null
  inputTokens: number
  outputTokens: number
}

export interface PlanWindow { usedPercent: number; windowMinutes: number | null; resetsAt: number | null }
export interface PlanLimits { agent: 'codex'; at: number; primary: PlanWindow | null; secondary: PlanWindow | null }

export type SkillshareKind = 'skills' | 'agents' | 'mcp' | 'plugins' | 'extras'
export type SkillshareState = 'ok' | 'sync' | 'missing' | 'update' | 'off' | 'broken'

export interface SkillshareItem { key: string; kind: SkillshareKind; name: string; state: SkillshareState; source: string; targets: string[]; reason?: string }

export interface SkillshareOverview {
  installed: boolean
  version?: string
  source?: string
  error?: string
  targets: Array<{ name: string; path: string; waiting: number }>
  kinds: Array<{ kind: SkillshareKind; total: number; needsSync: number; updates: number }>
  items: SkillshareItem[]
  checked: boolean
  checkedAt: number
}

export interface SkillshareResult { ok: boolean; message: string }

const base = '/api/studio/command-center'

export const fetchCommandCenterSettings = () => request<CommandCenterSettings>(`${base}/settings`)
export const saveCommandCenterSettings = (change: { github?: { enabled?: boolean; repos?: string[] | string } }) =>
  request<CommandCenterSettings>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(change) })
export const fetchGithubInbox = (refresh = false) => request<GithubInbox>(`${base}/github${refresh ? '?refresh=1' : ''}`)
export const fetchAgentDetails = (input: { sessions: string[]; folders: string[] }) =>
  request<{ contexts: Record<string, AgentContext>; branches: Record<string, string> }>(`${base}/agents`, { method: 'POST', body: JSON.stringify(input) })
export const fetchPlanLimits = () => request<{ limits: PlanLimits[] }>(`${base}/plan-limits`)
export const fetchSkillshare = () => request<SkillshareOverview>(`${base}/skillshare`)
export const checkSkillshare = () => request<SkillshareOverview>(`${base}/skillshare/check`, { method: 'POST', body: '{}' })
export const syncSkillshare = () => request<SkillshareResult>(`${base}/skillshare/sync`, { method: 'POST', body: JSON.stringify({ confirm: true }) })
export const updateSkillshare = (input: { kind: SkillshareKind; name?: string; all?: boolean }) =>
  request<SkillshareResult>(`${base}/skillshare/update`, { method: 'POST', body: JSON.stringify({ ...input, confirm: true }) })
export const installSkillshare = (source: string) =>
  request<SkillshareResult>(`${base}/skillshare/install`, { method: 'POST', body: JSON.stringify({ source, confirm: true }) })
