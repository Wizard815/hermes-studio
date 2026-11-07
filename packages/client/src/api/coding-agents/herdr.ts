import type { OrbWorkRef } from '../studio/orb'
import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrlValue, request } from '../client'
import { socketEndpoint } from '@/utils/deployment-url'

export type HerdrStatusValue = 'working' | 'blocked' | 'done' | 'idle' | 'unknown'

export interface HerdrSettings {
  enabled: boolean
  autoStart: boolean
  setupVersion: string
  binaryPath: string
  session: string
  autoImport: boolean
  mirrorTranscripts: boolean
  profile: string
}

export interface HerdrPaneView {
  pane_id: string
  workspace_id: string
  tab_id?: string
  agent?: string
  agent_status?: HerdrStatusValue
  cwd?: string
  foreground_cwd?: string
  focused?: boolean
  label?: string
  terminal_title_stripped?: string
  studioAgent: string | null
  studioSessionId: string | null
  nativeSessionId: string | null
}

export interface HerdrWorkspace {
  workspace_id: string
  label?: string
  agent_status?: HerdrStatusValue
  focused?: boolean
  pane_count?: number
}

export interface HerdrBridgeState {
  connected: boolean
  error: string
  version: string
  focusedPaneId: string | null
  workspaces: HerdrWorkspace[]
  panes: HerdrPaneView[]
}

export interface HerdrStatus {
  settings: HerdrSettings
  installed: boolean
  binary: string
  version: string
  server: { version: string; running: boolean; socket: string; session: string; compatible: boolean } | null
  error: string
  bridge: HerdrBridgeState | null
  integrations: string[]
  home: string
}

export interface HerdrLink { paneId: string; workspaceId: string; status: HerdrStatusValue }

const base = '/api/coding-agents/herdr'

export const fetchHerdrStatus = () => request<HerdrStatus>(base)

export const saveHerdrSettings = (settings: Partial<HerdrSettings>) =>
  request<{ settings: HerdrSettings }>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(settings) })

export const startHerdrServer = () => request<HerdrStatus>(`${base}/server/start`, { method: 'POST', body: '{}' })

export const installHerdrIntegrations = (kinds?: string[]) =>
  request<{ results: Array<{ kind: string; ok: boolean; message: string }> }>(`${base}/integrations`, {
    method: 'POST', body: JSON.stringify(kinds ? { kinds } : {}),
  })

export const installHerdrStudioPlugin = () =>
  request<{ pluginDir: string; configDir: string; linked: boolean; message: string }>(`${base}/plugin-install`, { method: 'POST', body: '{}' })

export interface HerdrSetupResult {
  version: string
  integrations: Array<{ kind: string; ok: boolean; message: string }>
  plugin: { linked?: boolean; message?: string; error?: string }
  keybinding: { key?: string | null; added?: boolean; message?: string; error?: string }
}

export const installHerdr = () => request<HerdrSetupResult & { binary: string }>(`${base}/install`, { method: 'POST', body: '{}' })

export const setupHerdr = () => request<HerdrSetupResult>(`${base}/setup`, { method: 'POST', body: '{}' })

export const fetchHerdrProfiles = () => request<{ profiles: string[] }>(`${base}/profiles`)

export const openSessionInHerdr = (sessionId: string) =>
  request<{ link: HerdrLink }>(`${base}/sessions/${encodeURIComponent(sessionId)}/open`, { method: 'POST', body: '{}' })

export const promptHerdrSession = (sessionId: string, text: string) =>
  request<{ paneId: string }>(`${base}/sessions/${encodeURIComponent(sessionId)}/prompt`, { method: 'POST', body: JSON.stringify({ text }) })

export const closeHerdrSessionPane = (sessionId: string) =>
  request<{ closed: boolean }>(`${base}/sessions/${encodeURIComponent(sessionId)}/pane`, { method: 'DELETE' })

export const launchHerdrAgent = (input: { agentId: string; provider?: string; model?: string; workspace?: string; title?: string; prompt?: string; orb?: OrbWorkRef }) =>
  request<{ link: HerdrLink }>(`${base}/agents`, { method: 'POST', body: JSON.stringify(input) })

export const focusHerdrPane = (paneId: string) =>
  request<{ ok: boolean }>(`${base}/panes/${encodeURIComponent(paneId)}/focus`, { method: 'POST', body: '{}' })

export function connectHerdrSocket(): Socket {
  const endpoint = socketEndpoint(getBaseUrlValue(), '/herdr')
  return io(endpoint.url, {
    forceNew: true,
    path: endpoint.path,
    auth: { token: getApiKey() },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  })
}

export interface SpaceFolder {
  id: string
  name: string
  color: string
  folded: boolean
  start: string
  rules: string
}

export interface SpaceFolderState {
  list: SpaceFolder[]
  of: Record<string, string>
  at: number
}

export const fetchSpaceFolders = () => request<SpaceFolderState>(`${base}/folders`)

export const saveSpaceFolders = (state: SpaceFolderState) =>
  request<SpaceFolderState>(`${base}/folders`, { method: 'PUT', body: JSON.stringify(state) })

export const createHerdrWorkspace = (input: { cwd?: string; label?: string }) =>
  request<{ workspaceId: string; paneId: string }>(`${base}/workspaces`, { method: 'POST', body: JSON.stringify(input) })
