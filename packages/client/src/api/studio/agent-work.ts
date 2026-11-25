import { request } from '../client'

export type AgentWorkStatus = 'queued' | 'working' | 'blocked' | 'awaiting_approval' | 'done' | 'rejected'

/** One piece of agent work on a Vikunja task (the task itself lives in Vikunja). */
export interface AgentWork {
  id: string
  title: string
  vikunjaTaskId: string
  agent: string
  sessionId: string
  status: AgentWorkStatus
  summary: string
  decision: '' | 'approved' | 'rejected'
  decidedVia: '' | 'studio' | 'mattermost' | 'orb' | 'omi'
  decidedBy: string
  decidedAt: number
  vikunjaDoneAt: number
  vikunjaError: string
  createdAt: number
  updatedAt: number
}

export interface AgentActivity { id: number; workId: string; at: number; kind: string; status: string; actor: string; via: string; message: string }

export interface AgentWorkSummary { counts: Record<AgentWorkStatus, number>; awaitingApproval: number; blocked: number }

export interface AgentWorkSettings {
  shareToOrb: boolean
  mattermost: { channel: string; channelId: string; teamId: string; mention: string[]; mentionOnApproval: boolean; actionUrl: string }
  allglance: { url: string; hasToken: boolean; fromEnv: boolean }
  wiki: { url: string; hasToken: boolean; folder: string; section: string }
}

export interface AgentWorkSettingsInput {
  shareToOrb?: boolean
  mattermost?: { channel?: string; mention?: string; mentionOnApproval?: boolean; actionUrl?: string }
  allglance?: { url?: string; token?: string }
  wiki?: { url?: string; token?: string; folder?: string; section?: string }
}

const base = '/api/studio/agent-work'

export const fetchAgentWork = (status?: string) =>
  request<{ work: AgentWork[] } & AgentWorkSummary>(`${base}${status ? `?status=${encodeURIComponent(status)}` : ''}`)
export const fetchAgentWorkSummary = () => request<AgentWorkSummary>(`${base}/summary`)
export const fetchAgentWorkItem = (id: string) => request<{ work: AgentWork; activity: AgentActivity[] }>(`${base}/${encodeURIComponent(id)}`)
export const fetchAgentActivity = (limit = 100) => request<{ activity: AgentActivity[] }>(`${base}/activity?limit=${limit}`)
export const decideAgentWork = (id: string, decision: 'approve' | 'reject') =>
  request<{ work: AgentWork; changed: boolean; message: string }>(`${base}/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: '{}' })
export const fetchAgentWorkSettings = () => request<AgentWorkSettings>(`${base}/settings`)
export const saveAgentWorkSettings = (input: AgentWorkSettingsInput) =>
  request<AgentWorkSettings>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(input) })
export const writeAgentWorkDigest = () => request<{ written: boolean; path?: string; markdown: string }>(`${base}/digest`, { method: 'POST', body: '{}' })
