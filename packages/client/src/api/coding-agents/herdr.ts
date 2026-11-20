import type { OrbWorkRef } from '../studio/orb'
import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrl, getBaseUrlValue, request } from '../client'
import { socketEndpoint } from '@/utils/deployment-url'
import type { SpaceFolderViewData, SpaceRepo } from '@/components/coding-agents/herdr/space-folders'

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
  /** Studio profile for chats and agents started from herdr; '' follows Studio's profile. */
  profile: string
  /** The profile last picked in Studio. */
  studioProfile?: string
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
  /** When the agent took its current status (ms, Studio's clock): the Agents list's time in state. */
  status_since?: number
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
  /** Studio chats with a herdr space now; other top-level chats sleep until opened (older servers leave it out). */
  chatSpaces?: string[]
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
  /** The home folder with symlinks resolved, when that differs. */
  homeReal?: string
  /** Where the Herdr App layout installer is on Studio's machine ('' if missing). */
  appLayoutScript?: string
  /** herdr keys (the user's or herdr's defaults) for Studio's herdr buttons. */
  keys?: { prefix: string; search: string; workspaces: string; settings: string; help: string; sidebar?: string; studioChats?: string; newChat?: string; reopen?: string }
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

/** Reopen the newest closed herdr chat (Studio's "Reopen closed chat"); `reopened` is empty when none is left. */
export const reopenClosedHerdrChat = () =>
  request<{ reopened: Array<{ sessionId: string; title: string; link: HerdrLink }>; remaining: number }>(`${base}/closed-chats/reopen`, { method: 'POST', body: '{}' })

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

/** One herdr space as the Herdr App layout draws it: its tabs, and its active tab's panes (rects are fractions). */
export interface HerdrSpaceView {
  workspaceId: string
  tabs: Array<{ tab_id: string; label: string; number: number; focused: boolean; agent_status: string; pane_count: number }>
  activeTabId: string
  focusedPaneId: string
  zoomed: boolean
  panes: Array<{ pane_id: string; focused: boolean; rect: { x: number; y: number; width: number; height: number }; process: string }>
}

export const fetchHerdrSpaceView = (workspaceId: string) =>
  request<HerdrSpaceView>(`${base}/spaces/${encodeURIComponent(workspaceId)}/view`)

export const createHerdrTab = (workspaceId: string) =>
  request<{ tabId: string; paneId: string }>(`${base}/spaces/${encodeURIComponent(workspaceId)}/tabs`, { method: 'POST', body: '{}' })

export const focusHerdrTab = (tabId: string) =>
  request<{ ok: boolean }>(`${base}/tabs/${encodeURIComponent(tabId)}/focus`, { method: 'POST', body: '{}' })

export const closeHerdrTab = (tabId: string) =>
  request<{ ok: boolean }>(`${base}/tabs/${encodeURIComponent(tabId)}`, { method: 'DELETE' })

export interface HerdrPaneChanges {
  root: string
  branch: string | null
  changes: Array<{ path: string; status: string; added: number; removed: number }>
  notRepo?: boolean
}

export const fetchHerdrPaneChanges = (paneId: string) =>
  request<HerdrPaneChanges>(`${base}/panes/${encodeURIComponent(paneId)}/changes`)

export const fetchHerdrPaneDiff = (paneId: string, path: string) =>
  request<{ root: string; path: string; diff: string; truncated: boolean }>(`${base}/panes/${encodeURIComponent(paneId)}/diff?path=${encodeURIComponent(path)}`)

/** Whether this browser can unzip herdr's gzipped state. */
export function canGunzip(): boolean {
  return typeof DecompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function'
}

/** herdr's gzipped state (`herdr.state.gz`) as the bridge state. */
export async function gunzipState(payload: ArrayBuffer | Uint8Array): Promise<HerdrBridgeState | null> {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return JSON.parse(await new Response(stream).text()) as HerdrBridgeState | null
}

export function connectHerdrSocket(): Socket {
  const endpoint = socketEndpoint(getBaseUrlValue(), '/herdr')
  return io(endpoint.url, {
    forceNew: true,
    path: endpoint.path,
    // gz: herdr's state comes gzipped (it lists every chat's space).
    auth: { token: getApiKey(), gz: canGunzip() },
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

// ---- Studio's Spaces sidebar (space folders) ----

export const fetchSpaceFolderView = () => request<SpaceFolderViewData>(`${base}/space-folders`)

export const createSpaceFolder = (input: { name: string; parentId?: string; color?: string; start?: string; rules?: string }) =>
  request<{ id: string }>(`${base}/space-folders/folders`, { method: 'POST', body: JSON.stringify(input) })

export const updateSpaceFolder = (id: string, patch: Partial<Pick<SpaceFolder, 'name' | 'color' | 'folded' | 'start' | 'rules'>>) =>
  request<{ ok: boolean }>(`${base}/space-folders/folders/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) })

export const deleteSpaceFolder = (id: string) =>
  request<{ ok: boolean }>(`${base}/space-folders/folders/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const orderSpaceFolders = (ids: string[], move?: { id: string; parentId: string }) =>
  request<{ ok: boolean }>(`${base}/space-folders/order`, { method: 'PUT', body: JSON.stringify({ ids, move }) })

/** folderId: a folder, '' for out of every folder, null to let the folders' rules decide. */
export const placeChatInFolder = (sessionId: string, folderId: string | null) =>
  request<{ ok: boolean }>(`${base}/space-folders/chats/${encodeURIComponent(sessionId)}`, { method: 'PUT', body: JSON.stringify({ folderId }) })

export const placeSpaceInFolder = (workspaceId: string, folderId: string | null) =>
  request<{ ok: boolean }>(`${base}/space-folders/spaces/${encodeURIComponent(workspaceId)}`, { method: 'PUT', body: JSON.stringify({ folderId }) })

export const newSpaceInFolder = (folderId: string) =>
  request<{ workspaceId: string; paneId: string }>(`${base}/space-folders/folders/${encodeURIComponent(folderId)}/space`, { method: 'POST', body: '{}' })

export const fetchSpaceRepos = (cwds: string[]) =>
  request<{ repos: Record<string, SpaceRepo | null> }>(`${base}/space-repos`, { method: 'POST', body: JSON.stringify({ cwds }) })

/** The Herdr App layout installer (a shell script), to save and run on the computer Herdr App is on. */
export async function downloadHerdrAppLayoutScript(): Promise<Blob> {
  const key = getApiKey()
  const res = await fetch(`${getBaseUrl()}${base}/app-layout/script`, { headers: key ? { Authorization: `Bearer ${key}` } : {} })
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`)
  return res.blob()
}
