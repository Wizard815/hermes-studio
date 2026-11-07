import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  HERDR_LIFECYCLE_EVENTS,
  isHerdrStatus,
  nativeSessionIdOf,
  normalizeSnapshot,
  studioAgentForHerdrAgent,
  transcriptPathOf,
  type HerdrAgentStatus,
  type HerdrPane,
  type HerdrSnapshot,
} from './protocol'
import { HerdrRequestError, HerdrSocketClient } from './socket-client'
import { readTranscriptFrom, type TranscriptMessage } from './transcript'
import type { HerdrSettings } from './runtime'

export interface HerdrSessionRef {
  id: string
  agent: string
  title: string | null
  workspace: string | null
  agent_native_session_id: string
  message_count?: number
}

export interface HerdrInteractiveLaunch {
  agentId: string
  command: string
  args: string[]
  env: Record<string, string>
  workspaceDir: string
  provider: string
  model: string
}

export interface HerdrLinkInfo {
  paneId: string
  workspaceId: string
  status: HerdrAgentStatus
}

/** Everything the bridge needs from Studio, injected so it stays testable. */
export interface HerdrBridgeDeps {
  findSessionByNativeId(nativeId: string): HerdrSessionRef | null
  getSession(id: string): HerdrSessionRef | null
  createSession(input: {
    id: string
    agent: string
    nativeId: string
    title: string
    workspace: string | null
    profile: string
    provider?: string
    model?: string
  }): void
  updateNativeSessionId(id: string, nativeId: string): void
  appendMessages(sessionId: string, messages: TranscriptMessage[]): void
  setLink(sessionId: string, link: HerdrLinkInfo | null): void
  notifyUpdated(sessionId: string): void
  locateTranscript(agent: string, nativeId: string): Promise<string | null>
  prepareSessionLaunch(sessionId: string): Promise<HerdrInteractiveLaunch>
  prepareAgentLaunch(agentId: string, input: { profile: string; provider?: string; model?: string; workspace?: string }): Promise<HerdrInteractiveLaunch>
  herdrKindFor(agentId: string): string | null
  /** Studio agent display name, used for titles. */
  agentLabel(agentId: string): string
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
}

export interface HerdrPaneView extends HerdrPane {
  studioAgent: string | null
  studioSessionId: string | null
  nativeSessionId: string | null
}

export interface HerdrBridgeState {
  connected: boolean
  error: string
  version: string
  focusedPaneId: string | null
  workspaces: HerdrSnapshot['workspaces']
  panes: HerdrPaneView[]
}

interface PersistedState {
  offsets: Record<string, { path: string; offset: number }>
  /** Native session ids whose chat was deleted in Studio: never re-import them. */
  dismissed: string[]
}

interface PendingLaunch {
  sessionId?: string
  agentId: string
  provider?: string
  model?: string
  title: string
}

/** Stable chat id for an agent session first seen in herdr. */
export function herdrChatId(nativeId: string): string {
  return `herdr-${nativeId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`
}

function titleFromFirstMessage(messages: TranscriptMessage[]): string {
  const first = messages.find(message => message.role === 'user')?.content.replace(/\s+/g, ' ').trim() || ''
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}...` : first
}

export class HerdrBridge {
  private client: HerdrSocketClient | null = null
  private subscription: { close: () => void } | null = null
  private statusSubscription: { close: () => void } | null = null
  private statusPaneKey = ''
  private snapshot: HerdrSnapshot = { workspaces: [], panes: [] }
  private panes: HerdrPaneView[] = []
  private links = new Map<string, HerdrLinkInfo>()
  /** Panes Studio opened itself: pane id → launch details. */
  private pending = new Map<string, PendingLaunch>()
  /** Native ids that have shown activity; they become chats even before a transcript exists. */
  private active = new Set<string>()
  private persisted: PersistedState = { offsets: {}, dismissed: [] }
  private persistedLoaded = false
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private mirrorTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private refreshing: Promise<void> | null = null
  private refreshAgain = false
  private stopped = true
  private error = ''
  private listeners = new Set<(state: HerdrBridgeState) => void>()

  constructor(
    private settings: HerdrSettings,
    private readonly deps: HerdrBridgeDeps,
    private readonly stateFile: string,
    private readonly socketPathResolver: () => Promise<string>,
  ) {}

  onChange(listener: (state: HerdrBridgeState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): HerdrBridgeState {
    return {
      connected: !!this.subscription,
      error: this.error,
      version: this.snapshot.version || '',
      focusedPaneId: this.snapshot.focused_pane_id ?? null,
      workspaces: this.snapshot.workspaces,
      panes: this.panes,
    }
  }

  linkFor(sessionId: string): HerdrLinkInfo | undefined {
    return this.links.get(sessionId)
  }

  updateSettings(settings: HerdrSettings): void {
    this.settings = settings
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.loadPersisted()
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    this.subscription?.close(); this.subscription = null
    this.statusSubscription?.close(); this.statusSubscription = null
    this.statusPaneKey = ''
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.mirrorTimer) clearInterval(this.mirrorTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.refreshTimer = this.mirrorTimer = this.retryTimer = null
    for (const sessionId of this.links.keys()) this.deps.setLink(sessionId, null)
    this.links.clear()
    this.panes = []
    this.snapshot = { workspaces: [], panes: [] }
    this.client = null
    this.emit()
  }

  private log(level: 'info' | 'warn', message: string, data?: Record<string, unknown>) {
    this.deps.log?.(level, message, data)
  }

  private emit() {
    const state = this.getState()
    for (const listener of this.listeners) {
      try { listener(state) } catch { /* ignore */ }
    }
  }

  private scheduleRetry(delayMs = 3000) {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delayMs)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      const socketPath = await this.socketPathResolver()
      const client = new HerdrSocketClient(socketPath)
      await client.request('ping', {}, 2000)
      this.client = client
      // Subscribe first, then read: events after this point invalidate the snapshot.
      const subscription = client.subscribe(
        HERDR_LIFECYCLE_EVENTS.map(type => ({ type })),
        () => this.scheduleRefresh(),
        reason => {
          if (this.subscription !== subscription) return
          this.subscription = null
          this.statusSubscription?.close(); this.statusSubscription = null; this.statusPaneKey = ''
          if (!this.stopped) {
            this.error = reason === 'events_lost' ? '' : `herdr disconnected (${reason})`
            this.emit()
            // events_lost: resubscribe immediately and reconcile; otherwise back off.
            this.scheduleRetry(reason === 'events_lost' ? 0 : 3000)
          }
        },
      )
      this.subscription = subscription
      await subscription.ready
      this.error = ''
      if (!this.mirrorTimer) this.mirrorTimer = setInterval(() => this.mirrorWorking(), 2000)
      await this.refresh()
    } catch (error) {
      this.subscription?.close(); this.subscription = null
      this.error = error instanceof Error ? error.message : String(error)
      this.emit()
      this.scheduleRetry()
    }
  }

  /** Coalesce bursts of events into one authoritative read. */
  scheduleRefresh(delayMs = 60): void {
    if (this.refreshTimer || this.stopped) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, delayMs)
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true
      return this.refreshing
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false
        try { await this.reconcile() } catch (error) {
          this.log('warn', '[herdr] reconcile failed', { error: String(error) })
          // A busy server can time out a snapshot; try again shortly instead of
          // waiting for the next event, which may never come for an idle pane.
          if (!this.stopped) setTimeout(() => this.scheduleRefresh(0), 1000)
        }
      } while (this.refreshAgain && !this.stopped)
    })()
    try { await this.refreshing } finally { this.refreshing = null }
  }

  /** Per-pane status subscriptions catch screen-detected changes between lifecycle events. */
  private syncStatusSubscription(paneIds: string[]) {
    const key = paneIds.slice().sort().join(',')
    if (key === this.statusPaneKey || !this.client) return
    this.statusSubscription?.close()
    this.statusSubscription = null
    this.statusPaneKey = key
    if (!paneIds.length) return
    const subscription = this.client.subscribe(
      paneIds.map(pane_id => ({ type: 'pane.agent_status_changed', pane_id })),
      () => this.scheduleRefresh(),
      () => {
        if (this.statusSubscription !== subscription) return
        // A pane closed or events were lost: rebuild on the next reconcile.
        this.statusSubscription = null
        this.statusPaneKey = ''
        this.scheduleRefresh(200)
      },
    )
    this.statusSubscription = subscription
  }

  private async reconcile(): Promise<void> {
    const client = this.client
    if (!client) return
    const snapshot = normalizeSnapshot(await client.request('session.snapshot', {}, 15000))
    if (this.stopped || client !== this.client) return
    this.snapshot = snapshot
    const seen = new Set<string>()
    const views: HerdrPaneView[] = []
    const livePaneIds = new Set(snapshot.panes.map(pane => pane.pane_id))
    for (const paneId of this.pending.keys()) if (!livePaneIds.has(paneId)) this.pending.delete(paneId)

    for (const pane of snapshot.panes) {
      const pending = this.pending.get(pane.pane_id)
      const studioAgent = studioAgentForHerdrAgent(pane.agent) ?? (pending?.agentId || null)
      const nativeId = pane.agent ? nativeSessionIdOf(pane) : null
      const status: HerdrAgentStatus = isHerdrStatus(pane.agent_status) ? pane.agent_status : 'unknown'
      let sessionId: string | null = null

      if (nativeId && (status === 'working' || status === 'blocked')) this.active.add(nativeId)

      if (pending?.sessionId) {
        sessionId = pending.sessionId
        // Resuming can fork a new native session; follow it so the link survives restarts.
        if (nativeId) {
          const row = this.deps.getSession(sessionId)
          if (row && row.agent_native_session_id !== nativeId) this.deps.updateNativeSessionId(sessionId, nativeId)
        }
      } else if (nativeId) {
        const row = this.deps.findSessionByNativeId(nativeId) ?? this.deps.getSession(herdrChatId(nativeId))
        if (row) sessionId = row.id
        else if (this.settings.autoImport && studioAgent && !this.persisted.dismissed.includes(nativeId)) {
          sessionId = await this.importPane(pane, studioAgent, nativeId, pending)
        }
        if (sessionId && pending) pending.sessionId = sessionId
      }

      if (sessionId) {
        seen.add(sessionId)
        const link: HerdrLinkInfo = { paneId: pane.pane_id, workspaceId: pane.workspace_id, status }
        const previous = this.links.get(sessionId)
        this.links.set(sessionId, link)
        this.deps.setLink(sessionId, link)
        if (this.settings.mirrorTranscripts && nativeId && studioAgent && (!previous || previous.status !== status)) {
          await this.mirror(sessionId, pane, studioAgent, nativeId)
        }
      }
      views.push({ ...pane, studioAgent, studioSessionId: sessionId, nativeSessionId: nativeId })
    }

    for (const sessionId of [...this.links.keys()]) {
      if (seen.has(sessionId)) continue
      this.links.delete(sessionId)
      this.deps.setLink(sessionId, null)
    }
    this.panes = views
    this.syncStatusSubscription(snapshot.panes.filter(pane => pane.agent).map(pane => pane.pane_id))
    this.emit()
  }

  /** Create a Studio chat for an agent session that started in herdr. */
  private async importPane(pane: HerdrPane, studioAgent: string, nativeId: string, pending?: PendingLaunch): Promise<string | null> {
    const path = transcriptPathOf(pane) || await this.deps.locateTranscript(studioAgent, nativeId)
    let preview: TranscriptMessage[] = []
    if (path) {
      try { preview = (await readTranscriptFrom(path, 0, 256 * 1024)).messages } catch { preview = [] }
    }
    // Skip agents opened and closed without doing anything, unless Studio
    // launched them on purpose: those get their chat right away.
    if (!pending && !this.active.has(nativeId) && !preview.some(message => message.role === 'user')) return null
    const id = herdrChatId(nativeId)
    const workspace = this.snapshot.workspaces.find(w => w.workspace_id === pane.workspace_id)
    const title = titleFromFirstMessage(preview)
      || pending?.title
      || `${this.deps.agentLabel(studioAgent)}${workspace?.label ? ` · ${workspace.label}` : ''}`
    this.deps.createSession({
      id,
      agent: studioAgent,
      nativeId,
      title,
      workspace: pane.foreground_cwd || pane.cwd || null,
      profile: this.settings.profile || 'default',
      provider: pending?.provider,
      model: pending?.model,
    })
    // Herdr-born chats import their whole history.
    if (path) this.persisted.offsets[id] = { path, offset: 0 }
    await this.savePersisted()
    this.log('info', '[herdr] imported agent session', { sessionId: id, agent: studioAgent, pane: pane.pane_id })
    return id
  }

  private async mirror(sessionId: string, pane: HerdrPane, studioAgent: string, nativeId: string): Promise<void> {
    try {
      let entry = this.persisted.offsets[sessionId]
      const path = transcriptPathOf(pane) || entry?.path || await this.deps.locateTranscript(studioAgent, nativeId)
      if (!path) return
      if (!entry || entry.path !== path) {
        // An existing Studio chat already holds its history: mirror only new turns.
        const row = this.deps.getSession(sessionId)
        const startAtEnd = !!row && !sessionId.startsWith('herdr-') && (row.message_count ?? 0) > 0
        entry = { path, offset: startAtEnd ? (await stat(path)).size : 0 }
        this.persisted.offsets[sessionId] = entry
      }
      const { messages, offset } = await readTranscriptFrom(path, entry.offset)
      if (offset === entry.offset) return
      entry.offset = offset
      if (messages.length) {
        this.deps.appendMessages(sessionId, messages)
        this.deps.notifyUpdated(sessionId)
      }
      await this.savePersisted()
    } catch (error) {
      this.log('warn', '[herdr] transcript mirror failed', { sessionId, error: String(error) })
    }
  }

  /** While agents work, transcripts grow without status changes; poll those only. */
  private async mirrorWorking() {
    if (!this.settings.mirrorTranscripts) return
    for (const pane of this.panes) {
      if (!pane.studioSessionId || !pane.nativeSessionId || !pane.studioAgent) continue
      if (pane.agent_status !== 'working' && pane.agent_status !== 'blocked') continue
      await this.mirror(pane.studioSessionId, pane, pane.studioAgent, pane.nativeSessionId)
    }
  }

  private async loadPersisted() {
    if (this.persistedLoaded) return
    this.persistedLoaded = true
    try {
      const raw = JSON.parse(await readFile(this.stateFile, 'utf8'))
      if (raw && typeof raw.offsets === 'object') this.persisted.offsets = raw.offsets
      if (Array.isArray(raw?.dismissed)) this.persisted.dismissed = raw.dismissed.filter((id: unknown) => typeof id === 'string').slice(-500)
    } catch { /* fresh state */ }
  }

  private saving: Promise<void> = Promise.resolve()

  /** Writes are serialized: concurrent mirrors must not race on the temp file. */
  private savePersisted(): Promise<void> {
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(dirname(this.stateFile), { recursive: true })
        const temp = `${this.stateFile}.${process.pid}.tmp`
        await writeFile(temp, JSON.stringify(this.persisted))
        await rename(temp, this.stateFile)
      } catch (error) {
        this.log('warn', '[herdr] could not save bridge state', { error: String(error) })
      }
    })
    return this.saving
  }

  /**
   * A chat was deleted in Studio. If its agent is still live in herdr, unlink
   * it and remember not to re-create the chat; the pane itself keeps running.
   */
  async forgetSession(sessionId: string): Promise<void> {
    const nativeIds = new Set(this.panes.filter(pane => pane.studioSessionId === sessionId && pane.nativeSessionId).map(pane => pane.nativeSessionId!))
    if (sessionId.startsWith('herdr-')) nativeIds.add(sessionId.slice('herdr-'.length))
    for (const nativeId of nativeIds) if (!this.persisted.dismissed.includes(nativeId)) this.persisted.dismissed.push(nativeId)
    this.persisted.dismissed = this.persisted.dismissed.slice(-500)
    delete this.persisted.offsets[sessionId]
    for (const [paneId, pending] of this.pending) if (pending.sessionId === sessionId) this.pending.delete(paneId)
    if (this.links.delete(sessionId)) this.deps.setLink(sessionId, null)
    await this.savePersisted()
    this.scheduleRefresh(0)
  }

  private requireClient(): HerdrSocketClient {
    if (!this.client) throw Object.assign(new Error('herdr is not connected'), { status: 503 })
    return this.client
  }

  /** Open a pane running an interactive launch, as a new herdr workspace. */
  private async openLaunch(launch: HerdrInteractiveLaunch, label: string, pending: PendingLaunch): Promise<HerdrLinkInfo> {
    const client = this.requireClient()
    const created = await client.request<any>('workspace.create', {
      cwd: launch.workspaceDir,
      label: label.slice(0, 48),
      focus: true,
    })
    const workspaceId = String(created?.workspace?.workspace_id || '')
    const tabId = String(created?.tab?.tab_id || '')
    if (!workspaceId || !tabId) throw new Error('herdr did not return the new workspace')
    // Replaces the workspace's starter shell tab with the agent pane.
    const applied = await client.request<any>('layout.apply', {
      tab_id: tabId,
      tab_label: this.deps.agentLabel(launch.agentId).slice(0, 32),
      focus: true,
      root: {
        type: 'pane',
        label: label.slice(0, 48),
        cwd: launch.workspaceDir,
        command: [launch.command, ...launch.args],
        env: launch.env,
      },
    })
    const paneId = String(applied?.layout?.focused_pane_id || applied?.layout?.root?.pane_id || '')
      || await this.firstPaneIn(workspaceId)
    if (!paneId) throw new Error('herdr did not return the agent pane')
    this.pending.set(paneId, pending)
    const link: HerdrLinkInfo = { paneId, workspaceId, status: 'unknown' }
    if (pending.sessionId) {
      this.links.set(pending.sessionId, link)
      this.deps.setLink(pending.sessionId, link)
    }
    this.scheduleRefresh(0)
    return link
  }

  private async firstPaneIn(workspaceId: string): Promise<string> {
    const result = await this.requireClient().request<any>('pane.list', { workspace_id: workspaceId })
    return String(result?.panes?.[0]?.pane_id || '')
  }

  /** Open (or focus) a Studio chat as a live herdr pane. */
  async openSession(sessionId: string): Promise<HerdrLinkInfo> {
    const existing = this.links.get(sessionId)
    if (existing) {
      await this.focusPane(existing.paneId)
      return existing
    }
    const row = this.deps.getSession(sessionId)
    if (!row) throw Object.assign(new Error('Chat not found'), { status: 404 })
    const launch = await this.deps.prepareSessionLaunch(sessionId)
    return this.openLaunch(launch, row.title || this.deps.agentLabel(launch.agentId), {
      sessionId,
      agentId: launch.agentId,
      provider: launch.provider,
      model: launch.model,
      title: row.title || '',
    })
  }

  /** Start a new agent in herdr with Studio's provider routing, MCP and prompt. */
  async launchAgent(agentId: string, input: { provider?: string; model?: string; workspace?: string; title?: string }): Promise<HerdrLinkInfo> {
    const launch = await this.deps.prepareAgentLaunch(agentId, { ...input, profile: this.settings.profile || 'default' })
    const title = input.title?.trim() || this.deps.agentLabel(launch.agentId)
    return this.openLaunch(launch, title, {
      agentId: launch.agentId,
      provider: launch.provider,
      model: launch.model,
      title,
    })
  }

  async focusPane(paneId: string): Promise<void> {
    await this.requireClient().request('pane.focus', { pane_id: paneId })
  }

  /** Send a chat message into the live pane instead of starting a second process. */
  async promptSession(sessionId: string, text: string): Promise<{ paneId: string }> {
    const link = this.links.get(sessionId)
    if (!link) throw Object.assign(new Error('Chat is not open in herdr'), { status: 409 })
    const body = String(text || '')
    if (!body.trim()) throw Object.assign(new Error('Message is empty'), { status: 400 })
    try {
      await this.requireClient().request('agent.prompt', { target: link.paneId, text: body }, 15000)
    } catch (error) {
      if (error instanceof HerdrRequestError && error.code === 'agent_blocked') {
        throw Object.assign(new Error('The agent is waiting on an approval or question in herdr'), { status: 409, code: 'agent_blocked' })
      }
      throw error
    }
    return { paneId: link.paneId }
  }

  async closeSessionPane(sessionId: string): Promise<boolean> {
    const link = this.links.get(sessionId)
    if (!link) return false
    await this.requireClient().request('pane.close', { pane_id: link.paneId })
    this.scheduleRefresh(0)
    return true
  }
}
