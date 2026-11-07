import { request } from '../client'

export interface OrbStatus {
  connected: boolean
  version: string
  error: string
  settings: { url: string; hasToken: boolean; fromEnv: boolean }
}

export interface OrbTask { title: string; list: string; due: string; done: boolean; inProgress?: boolean; agentStatus?: AgentWorkStatus; priority: string }
/** herdr's state of the agent working on it ('' when none). */
export type AgentWorkStatus = '' | 'working' | 'blocked' | 'done' | 'idle'
/** The Orb task or project an agent works on; Studio marks it in progress once the agent starts working. */
export interface OrbWorkRef { task?: { title: string; list: string }; project?: string }
export interface OrbProject { name: string; status: string; next?: string; archived?: boolean; openTasks?: number; agentStatus?: AgentWorkStatus; [key: string]: unknown }
export interface OrbChore { name: string; daysLeft?: number; [key: string]: unknown }

export type OrbDataKind = 'projects' | 'tasks' | 'logs' | 'chores' | 'ideas' | 'events' | 'upkeep-repos' | 'upkeep-requests' | 'uptime' | 'system' | 'config'

const base = '/api/studio/orb'

export const fetchOrbStatus = () => request<OrbStatus>(base)

export const saveOrbSettings = (input: { url?: string; token?: string }) =>
  request<OrbStatus['settings']>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(input) })

export async function fetchOrbData<T = unknown>(kind: OrbDataKind): Promise<T> {
  return (await request<{ kind: string; data: T }>(`${base}/data/${encodeURIComponent(kind)}`)).data
}

export async function callOrbTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await request<{ result: T }>(`${base}/tools/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(args) })).result
}
