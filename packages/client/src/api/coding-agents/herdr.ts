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
  /** Every chat is a herdr space. */
  chatSpaces?: boolean
  /** Chats used within this many days stay awake in herdr (0: all). */
  chatSpacesAwakeDays?: number
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
  /** herdr keys (the user's or herdr's defaults) for Studio's herdr buttons. */
  keys?: { prefix: string; search: string; workspaces: string; settings: string; help: string; sidebar?: string; studioChats?: string; newChat?: string }
  publicUrl?: string
  /** herdr's collapsed-rail width (4 or 0) and phone-layout width, for Studio's embedded view. */
  view?: { rail: number; mobileWidth: number }
  /** Whether herdr shows its first-run welcome screen (herdr's own `onboarding` option). */
  welcome?: boolean
}

export interface HerdrLink { paneId: string; workspaceId: string; status: HerdrStatusValue }

const base = '/api/coding-agents/herdr'

export const fetchHerdrStatus = () => request<HerdrStatus>(base)

export const saveHerdrSettings = (settings: Partial<HerdrSettings>) =>
  request<{ settings: HerdrSettings }>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(settings) })

export const setHerdrWelcome = (show: boolean) =>
  request<{ welcome: boolean }>(`${base}/welcome`, { method: 'PUT', body: JSON.stringify({ show }) })

/** herdr's remote (SSH) machines; their herdr servers show up in every herdr client. */
export interface HerdrMachine {
  id: string
  label: string
  target: string
  session: string
  enabled: boolean
  selected: boolean
  status?: string
  error?: string
}

export const fetchHerdrMachines = (withStatus = false) =>
  request<{ machines: HerdrMachine[] }>(`${base}/machines${withStatus ? '?status=1' : ''}`)

export const addHerdrMachine = (input: { target: string; label?: string; session?: string }) =>
  request<{ message: string; machines: HerdrMachine[] }>(`${base}/machines`, { method: 'POST', body: JSON.stringify(input) })

export const changeHerdrMachine = (id: string, change: { enabled?: boolean; label?: string }) =>
  request<{ machines: HerdrMachine[] }>(`${base}/machines/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(change) })

export const removeHerdrMachine = (id: string) =>
  request<{ machines: HerdrMachine[] }>(`${base}/machines/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** An agent on a saved machine (herdr's API over SSH). */
export interface HerdrRemoteAgent {
  pane_id: string
  workspace_id: string
  agent: string
  agent_status: HerdrStatusValue | string
  label: string
  cwd: string
  focused: boolean
}

export const fetchHerdrMachineAgents = (id: string) =>
  request<{ agents: HerdrRemoteAgent[] }>(`${base}/machines/${encodeURIComponent(id)}/agents`)

export const focusHerdrMachineAgent = (id: string, paneId: string) =>
  request<{ ok: boolean }>(`${base}/machines/${encodeURIComponent(id)}/agents/${encodeURIComponent(paneId)}/focus`, { method: 'POST', body: '{}' })

export const startHerdrServer = () => request<HerdrStatus>(`${base}/server/start`, { method: 'POST', body: '{}' })

export const installHerdrIntegrations = (kinds?: string[]) =>
  request<{ kinds?: string[]; results: Array<{ kind: string; ok: boolean; message: string }> }>(`${base}/integrations`, {
    method: 'POST', body: JSON.stringify(kinds ? { kinds } : {}),
  })

export const installHerdrStudioPlugin = () =>
  request<{ pluginDir: string; configDir: string; linked: boolean; message: string }>(`${base}/plugin-install`, { method: 'POST', body: '{}' })

export interface HerdrSetupResult {
  version: string
  integrations: Array<{ kind: string; ok: boolean; message: string }>
  plugin: { linked?: boolean; message?: string; error?: string }
  keybinding: { key?: string | null; added?: boolean; message?: string; error?: string }
  newChatKeybinding?: { key?: string | null; added?: boolean; message?: string; error?: string }
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

/** The pane Studio last asked herdr to focus, and when (herdr's focus reports lag behind it). */
export const studioFocusRequest = { paneId: '', at: 0 }

export function focusHerdrPane(paneId: string) {
  studioFocusRequest.paneId = paneId
  studioFocusRequest.at = Date.now()
  return request<{ ok: boolean }>(`${base}/panes/${encodeURIComponent(paneId)}/focus`, { method: 'POST', body: '{}' })
}

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
