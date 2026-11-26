import { request } from '../client'

/** herdr's agent states, plus `starting` (just launched) and `gone` (its pane closed). */
export type ProjectThreadStatus = 'starting' | 'working' | 'blocked' | 'done' | 'idle' | 'unknown' | 'gone'

export interface ProjectThread {
  id: string
  title: string
  agent: string
  /** Its model, '' for the agent's own default. */
  model?: string
  provider?: string
  brief: string
  paneId: string
  /** '' until herdr reports the agent's session (agents herdr detects). */
  sessionId: string
  /** Its own git worktree, or the project folder when it has none. */
  workspace: string
  /** Its branch when it has its own worktree, else ''. */
  branch: string
  status: ProjectThreadStatus
  liveStatus: ProjectThreadStatus
  resolved: boolean
  /** Its pull request link, '' when none. */
  pr: string
  createdAt: number
  updatedAt: number
}

export type ProjectTaskColumn = 'todo' | 'doing' | 'review' | 'done'

/** A board card that is not a thread (yet). */
export interface ProjectTask {
  id: string
  title: string
  notes: string
  column: ProjectTaskColumn
  pr: string
  threadId: string
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
  /** Model for the default agent's threads, '' for its own default. */
  defaultModel?: string
  worktrees: boolean
  wakeCoordinator: boolean
  threads: ProjectThread[]
  tasks: ProjectTask[]
  counts: { needsYou: number; working: number; done: number; resolved: number }
  createdAt: number
  updatedAt: number
}

export interface ProjectInput {
  name?: string
  folder?: string
  instructions?: string
  defaultAgent?: string
  defaultModel?: string
  profile?: string
  worktrees?: boolean
  wakeCoordinator?: boolean
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

export const startProjectThread = async (id: string, input: { title?: string; brief: string; agent?: string; model?: string }) =>
  (await request<{ thread: ProjectThread }>(`${base}/${encodeURIComponent(id)}/threads`, json('POST', input))).thread

export const addChatToProject = async (id: string, sessionId: string) =>
  (await request<{ thread: ProjectThread }>(`${base}/${encodeURIComponent(id)}/chats`, json('POST', { sessionId }))).thread

export const setThreadResolved = async (id: string, threadId: string, resolved: boolean) =>
  (await request<{ thread: ProjectThread }>(`${base}/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/resolved`, json('PUT', { resolved }))).thread

export const removeThreadFromProject = (id: string, threadId: string) =>
  request<{ ok: true }>(`${base}/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' })

export interface ThreadMessage { role: string; text: string }

export const readProjectThread = (id: string, threadId: string, limit = 20) =>
  request<{ thread: ProjectThread; messages: ThreadMessage[] }>(`${base}/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}?limit=${limit}`)

export const messageProjectThread = (id: string, threadId: string, text: string) =>
  request<unknown>(`${base}/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/message`, json('POST', { text }))

export const getProject = async (id: string) =>
  (await request<{ project: Project }>(`${base}/${encodeURIComponent(id)}`)).project

export const addProjectTask = async (id: string, input: { title: string; notes?: string; column?: ProjectTaskColumn; pr?: string }) =>
  (await request<{ task: ProjectTask }>(`${base}/${encodeURIComponent(id)}/tasks`, json('POST', input))).task

export const updateProjectTask = async (id: string, taskId: string, change: Partial<Pick<ProjectTask, 'title' | 'notes' | 'column' | 'pr'>>) =>
  (await request<{ task: ProjectTask }>(`${base}/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`, json('PUT', change))).task

export const removeProjectTask = (id: string, taskId: string) =>
  request<{ removed: true }>(`${base}/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' })

export const startProjectTask = (id: string, taskId: string, agent?: string) =>
  request<{ task: ProjectTask; thread: ProjectThread }>(`${base}/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/start`, json('POST', { agent }))

export const setProjectThreadPr = async (id: string, threadId: string, pr: string) =>
  (await request<{ thread: ProjectThread }>(`${base}/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/pr`, json('PUT', { pr }))).thread
