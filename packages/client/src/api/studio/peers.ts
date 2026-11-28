import { request } from '../client'

/** Paired Studios for projects (docs/projects.md#federation). */
export interface StudioPeer {
  id: string
  url: string
  label: string
  /** This Studio let it in. */
  approved: boolean
  /** Projects this Studio shares with it. */
  projects: string[]
  /** In this Studio's group: it gets the group's projects and meets the other members. */
  group: boolean
  /** The group member that introduced it ('' when paired by code). */
  introducedBy: string
  createdAt: number
  lastSeenAt: number
}

/** What a paired Studio shows of a project it shares. */
export interface SharedProject {
  id: string
  name: string
  counts: { needsYou: number; working: number; done: number; resolved: number }
  threads: Array<{ id: string; title: string; agent: string; status: string; resolved: boolean; pr: string }>
  tasks: Array<{ id: string; title: string; column: string; pr: string }>
  artifacts: Array<{ id: string; title: string; ref: string }>
}

/** One thing that crossed between Studios. */
export interface BridgeLogEntry {
  at: number
  peer: string
  label: string
  direction: 'in' | 'out'
  kind: 'message' | 'task' | 'introduced'
  project: string
  text: string
  by: 'person' | 'coordinator' | 'studio'
  from?: { project: string; name: string }
}

const base = '/api/studio/peers'
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })
const at = (id: string) => `${base}/${encodeURIComponent(id)}`

export const listPeers = () => request<{ self: { id: string; label: string }; peers: StudioPeer[] }>(base)
export const createPairingCode = () => request<{ code: string; expiresAt: number }>(`${base}/code`, json('POST', {}))
export const pairStudio = async (input: { url: string; code: string; selfUrl: string; label?: string; group?: boolean }) =>
  (await request<{ peer: StudioPeer }>(`${base}/pair`, json('POST', input))).peer
export const updatePeer = async (id: string, change: { approved?: boolean; label?: string; projects?: string[]; group?: boolean }) =>
  (await request<{ peer: StudioPeer }>(at(id), json('PUT', change))).peer
export const removePeer = (id: string) => request<{ removed: true; told: boolean }>(at(id), { method: 'DELETE' })
export const peerProjects = async (id: string) => (await request<{ projects: SharedProject[] }>(`${at(id)}/projects`)).projects
export const messagePeerProject = (id: string, projectId: string, text: string) =>
  request<{ queued: true }>(`${at(id)}/projects/${encodeURIComponent(projectId)}/message`, json('POST', { text }))
export const addPeerTask = (id: string, projectId: string, title: string) =>
  request<unknown>(`${at(id)}/projects/${encodeURIComponent(projectId)}/tasks`, json('POST', { title }))
export const groupProjects = async () => (await request<{ projects: string[] }>(`${base}/group`)).projects
export const setGroupProjects = async (projects: string[]) => (await request<{ projects: string[] }>(`${base}/group`, json('PUT', { projects }))).projects
export const bridgeLog = async (limit = 40) => (await request<{ log: BridgeLogEntry[] }>(`${base}/log?limit=${limit}`)).log
