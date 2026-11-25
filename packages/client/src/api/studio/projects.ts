import { request } from '../client'

/** herdr's agent states, plus `starting` (just launched) and `gone` (its pane closed). */
export type ProjectThreadStatus = 'starting' | 'working' | 'blocked' | 'done' | 'idle' | 'unknown' | 'gone'

export interface ProjectThread {
  id: string
  title: string
  agent: string
  brief: string
  paneId: string
  /** '' until herdr reports the agent's session (agents herdr detects). */
  sessionId: string
  status: ProjectThreadStatus
  liveStatus: ProjectThreadStatus
  resolved: boolean
  createdAt: number
  updatedAt: number
}

export interface Project {
  id: string
  name: string
  folder: string
  instructions: string
  profile: string
  categoryId: number | null
  coordinatorSessionId: string
  defaultAgent: string
  threads: ProjectThread[]
  counts: { needsYou: number; working: number; done: number; resolved: number }
  createdAt: number
  updatedAt: number
}

export interface ProjectInput {
  name?: string
  folder?: string
  instructions?: string
  defaultAgent?: string
  profile?: string
}

const base = '/api/studio/projects'
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

export const listProjects = async () => (await request<{ projects: Project[] }>(base)).projects

export const createProject = async (input: ProjectInput) =>
  (await request<{ project: Project }>(base, json('POST', input))).project

export const updateProject = async (id: string, input: ProjectInput) =>
  (await request<{ project: Project }>(`${base}/${encodeURIComponent(id)}`, json('PUT', input))).project

export const removeProject = (id: string) =>
  request<{ removed: boolean }>(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const startProjectThread = async (id: string, input: { title?: string; brief: string; agent?: string }) =>
  (await request<{ thread: ProjectThread }>(`${base}/${encodeURIComponent(id)}/threads`, json('POST', input))).thread

export const addChatToProject = async (id: string, sessionId: string) =>
  (await request<{ thread: ProjectThread }>(`${base}/${encodeURIComponent(id)}/chats`, json('POST', { sessionId }))).thread

export const setThreadResolved = async (id: string, threadId: string, resolved: boolean) =>
  (await request<{ thread: ProjectThread }>(`${base}/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/resolved`, json('PUT', { resolved }))).thread

export const removeThreadFromProject = (id: string, threadId: string) =>
  request<{ ok: true }>(`${base}/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' })
