import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

import { awakeChats, chatAgentLabel, chatSpaceLabel, keptWakeUps, planChatSpaces, type ChatSpaceChat, type ChatSpaceRecord } from './chat-spaces'

export interface HerdrSessionRef {
  id: string
  agent: string
  title: string | null
  workspace: string | null
  agent_native_session_id: string
  message_count?: number
  /** Studio chat folder (session category). */
  category_id?: number | null
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
type ChatPaneSetup = NonNullable<Awaited<ReturnType<NonNullable<HerdrBridgeDeps['chatPane']>>>>

export interface StudioChatAccess {
  /** Studio login for its chat-run socket (short-lived). */
  token: string
  profile: string
  /** Fields every turn's run sends (session, agent, model, folder). */
  run: Record<string, unknown>
  /** What herdr lists as the pane's agent. */
  agent: string
  /** The agent's name for people ("Ekko"). */
  name: string
}

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
    categoryId?: number | null
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
  /**
   * The agent launched for a piece of work (`onWorking`) changed state: from its
   * first `working` on, every herdr status change, then `gone` when its pane
   * closes. Calls for one pane arrive in order.
   */
  workStatusChanged?: (data: HerdrWorkRef, paneId: string, status: HerdrAgentStatus | 'gone', agent: string | null) => void | Promise<void>
  /**
   * The Studio chat folder a herdr space is filed in (Mission's placement, or
   * the folder whose start directory or rules match its directory).
   */
  categoryForSpace?: (spaceId: string, cwd: string) => Promise<number | null>
  /** Every Studio chat (all agents, not archived), so each one is a herdr space. */
  listChatSpaces?: () => Promise<ChatSpaceChat[]>
  /**
   * Talk to a chat whose agent herdr cannot run (Ekko, Hermes without its
   * CLI) from a herdr pane: a short-lived login for Studio's chat runs and the
   * run fields that keep the chat's agent, model and folder.
   */
  chatAccess?: (sessionId: string) => Promise<StudioChatAccess>
  /**
   * The chat so far, for an agent that starts a fresh session on an old chat
   * (no saved agent session to resume). Empty when there is nothing to tell.
   */
  chatRecap?: (sessionId: string) => Promise<string>
  /** A chat's newest messages for its card in herdr. */
  chatPreview?: (sessionId: string) => Promise<Array<{ role: string; text: string }>>
  /**
   * How herdr runs a chat's waiting pane: the shell script and the environment
   * it needs (Studio's node and plugin script, cards folder). Null when the
   * script is missing.
   */
  chatPane?: () => Promise<{ script: string; env: Record<string, string>; cardsDir: string; studioUrl: string } | null>
  /** Where work belongs: a Studio chat folder (and its start directory) matching the project. */
  folderForWork?: (data: HerdrWorkRef) => Promise<{ categoryId: number | null; workspace: string } | null>
  /**
   * Give agents in herdr a fresh short-lived Studio login for a profile, so
   * their Studio MCP tools (sessions, Orb, workflows) are authorized like a
   * Studio run's. Called on launch and while agents work.
   */
  grantAgentAccess?: (profile: string) => Promise<void>
}

/** What a launched agent is for (e.g. a Pondering Orb task or project). */
export interface HerdrWorkRef {
  /** When it was launched (set by the bridge). */
  at?: number
  /** Set once the agent first worked; later changes are reported from then on. */
  started?: boolean
  /** Last status reported. */
  last?: string
  orb?: { task?: { title: string; list: string }; project?: string }
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
  /** Agents launched for a piece of work, by pane id, until their pane closes. */
  working?: Record<string, HerdrWorkRef>
  /** Each Studio chat's herdr space, by chat id. */
  chatSpaces?: Record<string, ChatSpaceRecord>
  /** Sleeping chats woken in herdr, and when (they stay awake for the awake window). */
  wokenChats?: Record<string, number>
}

interface PendingLaunch {
  sessionId?: string
  /** Studio chat folder for the chat this launch creates. */
  categoryId?: number | null
  agentId: string
  provider?: string
  model?: string
  title: string
}

/** Stable chat id for an agent session first seen in herdr. */
/** How long a new or restarted waiting pane has to report itself to herdr. */
const STUB_GRACE_MS = 20_000

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
  private accessAt = new Map<string, number>()
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
  /** Chats whose own agent runs in herdr right now (not a waiting pane): chat id → workspace id. */
  private liveChats = new Map<string, string>()
  /** Waiting panes that stopped reporting (a herdr restart brings them back as plain shells), and since when. */
  private silentStubs = new Map<string, number>()
  /** herdr's spaces and panes as the last chat sync saw them. */
  private chatLayout = ''
  private chatSync: Promise<void> | null = null
  private chatSyncAgain = false
  private chatSyncTimer: ReturnType<typeof setTimeout> | null = null
  /** What each chat card was last written from, so unchanged cards are not rewritten. */
  private cards = new Map<string, string>()

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

  /** Whether the chat has its own herdr space (awake). */
  hasChatSpace(sessionId: string): boolean {
    return !!this.persisted.chatSpaces?.[sessionId]
  }

  linkFor(sessionId: string): HerdrLinkInfo | undefined {
    return this.links.get(sessionId)
  }

  updateSettings(settings: HerdrSettings): void {
    const chatSpacesChanged = settings.chatSpaces !== this.settings.chatSpaces || settings.chatSpacesAwakeDays !== this.settings.chatSpacesAwakeDays
    this.settings = settings
    if (chatSpacesChanged) this.scheduleChatSync(0)
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
    if (this.persisted.working) {
      // A snapshot taken just before a new pane appeared must not drop it.
      const gone = Object.entries(this.persisted.working).filter(([paneId, ref]) => !livePaneIds.has(paneId) && Date.now() - (ref.at || 0) > 30000).map(([paneId]) => paneId)
      if (gone.length) {
        for (const paneId of gone) {
          const ref = this.persisted.working[paneId]
          delete this.persisted.working[paneId]
          if (ref.started) this.reportWork(ref, paneId, 'gone', null)
        }
        void this.savePersisted()
      }
    }

    const stubOwner = new Map(Object.entries(this.persisted.chatSpaces || {}).filter(([, record]) => record.stubPaneId).map(([sessionId, record]) => [record.stubPaneId, sessionId]))
    const liveChats = new Map<string, string>()
    const silent = new Map<string, number>()
    for (const pane of snapshot.panes) {
      if (stubOwner.has(pane.pane_id) && !pane.agent && !this.pending.has(pane.pane_id)) {
        silent.set(pane.pane_id, this.silentStubs.get(pane.pane_id) ?? Date.now())
      }
      const pending = this.pending.get(pane.pane_id)
      const studioAgent = studioAgentForHerdrAgent(pane.agent) ?? (pending?.agentId || null)
      const nativeId = pane.agent ? nativeSessionIdOf(pane) : null
      const status: HerdrAgentStatus = isHerdrStatus(pane.agent_status) ? pane.agent_status : 'unknown'
      let sessionId: string | null = null

      if (nativeId && (status === 'working' || status === 'blocked')) this.active.add(nativeId)
      if (this.persisted.working?.[pane.pane_id]) this.trackWork(pane.pane_id, status, pane.agent || null)
      if (status === 'working' && pane.agent) void this.refreshAgentAccess(false)

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

      // The chat's own agent runs here (a waiting pane has no agent session of its own).
      if (sessionId && (nativeId || pending)) liveChats.set(sessionId, pane.workspace_id)
      // A chat's waiting pane stands for its chat until its agent resumes.
      if (!sessionId && stubOwner.has(pane.pane_id)) sessionId = stubOwner.get(pane.pane_id)!

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
    this.liveChats = liveChats
    this.silentStubs = silent
    // Chat spaces only need a look when herdr's spaces or panes changed (not on every status change).
    const layout = `${snapshot.workspaces.map(item => item.workspace_id).join(',')}|${snapshot.panes.map(item => `${item.pane_id}${item.agent ? '+' : ''}`).join(',')}`
    if (layout !== this.chatLayout || silent.size) { this.chatLayout = layout; this.scheduleChatSync() }
    // Follow status only where a chat's agent really runs: herdr's status
    // subscription costs CPU per pane, and a waiting pane is always idle.
    const waiting = (pane: HerdrPane) => stubOwner.has(pane.pane_id) && !liveChats.has(stubOwner.get(pane.pane_id)!)
    this.syncStatusSubscription(snapshot.panes.filter(pane => pane.agent && !waiting(pane)).map(pane => pane.pane_id))
    this.emit()
  }

  /** Bring herdr's chat spaces in line with Studio's chats (soon, once at a time). */
  scheduleChatSync(delayMs = 1500): void {
    if (this.stopped || this.chatSyncTimer) return
    this.chatSyncTimer = setTimeout(() => {
      this.chatSyncTimer = null
      if (this.chatSync) { this.chatSyncAgain = true; return }
      this.chatSync = this.syncChatSpaces()
        .catch(error => this.log('warn', '[herdr] could not sync chat spaces', { error: String(error) }))
        .finally(() => {
          this.chatSync = null
          if (this.chatSyncAgain) { this.chatSyncAgain = false; this.scheduleChatSync(0) }
        })
    }, delayMs)
    this.chatSyncTimer.unref?.()
  }

  /**
   * Every Studio chat is a herdr space: chats without one get a space with a
   * waiting pane, labels follow titles and folders, spaces of deleted chats
   * close, and spaces keep Studio's folder order in herdr's sidebar.
   */
  private async syncChatSpaces(): Promise<void> {
    const client = this.client
    if (!client || !this.deps.listChatSpaces || !this.deps.chatPane) return
    const records = { ...(this.persisted.chatSpaces || {}) }
    const workspaces = new Set(this.snapshot.workspaces.map(workspace => workspace.workspace_id))
    if (this.settings.chatSpaces === false) {
      // Turned off: waiting spaces go; spaces with a running agent stay.
      for (const [sessionId, record] of Object.entries(records)) {
        if (record.stubPaneId && workspaces.has(record.workspaceId) && !this.liveChats.has(sessionId)) {
          await client.request('workspace.close', { workspace_id: record.workspaceId }).catch(() => undefined)
        }
      }
      if (Object.keys(records).length) { this.persisted.chatSpaces = {}; await this.savePersisted() }
      return
    }
    const pane = await this.deps.chatPane()
    if (!pane) return
    // Only awake chats have a space; sleeping ones wake when opened or messaged.
    const awakeDays = this.settings.chatSpacesAwakeDays ?? 7
    const woken = keptWakeUps(this.persisted.wokenChats || {}, Date.now(), awakeDays)
    const chats = awakeChats(await this.deps.listChatSpaces(), { now: Date.now(), awakeDays, woken, live: this.liveChats })
    let changed = Object.keys(woken).length !== Object.keys(this.persisted.wokenChats || {}).length
    this.persisted.wokenChats = woken
    // A waiting pane that stopped reporting: herdr dropped its report (a busy
    // restart) and Studio reports it again, or it is a plain shell now and its
    // space is made again.
    for (const [sessionId, record] of Object.entries(records)) {
      const since = record.stubPaneId ? this.silentStubs.get(record.stubPaneId) : undefined
      if (since === undefined || Date.now() - since < STUB_GRACE_MS || this.liveChats.has(sessionId)) continue
      const chat = chats.find(item => item.id === sessionId)
      if (chat && await this.stubRunning(client, record.stubPaneId)) {
        const env = this.stubEnv(chat, pane)
        await client.request('pane.report_agent', {
          pane_id: record.stubPaneId,
          source: 'studio:chat',
          agent: env.STUDIO_CHAT_AGENT,
          state: 'idle',
          resume_argv: ['env', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), 'sh', pane.script, chat.id],
        }).catch(() => undefined)
        this.silentStubs.delete(record.stubPaneId)
        continue
      }
      await client.request('workspace.close', { workspace_id: record.workspaceId }).catch(() => undefined)
      workspaces.delete(record.workspaceId)
      this.silentStubs.delete(record.stubPaneId)
      delete records[sessionId]
      changed = true
    }
    const panes = new Map(this.snapshot.panes.map(item => [item.pane_id, item.workspace_id]))
    const plan = planChatSpaces({ chats, records, workspaces, panes, live: this.liveChats })
    for (const sessionId of plan.forget) { delete records[sessionId]; changed = true }
    for (const { sessionId, workspaceId } of plan.close) {
      await client.request('workspace.close', { workspace_id: workspaceId }).catch(() => undefined)
      delete records[sessionId]; changed = true
    }
    await this.writeCards(chats, pane.cardsDir)
    // A chat whose agent runs in another space (started from herdr's picker, or
    // opened there): that space is the chat's now, and its waiting space closes.
    for (const chat of chats) {
      const workspaceId = this.liveChats.get(chat.id)
      const record = records[chat.id]
      if (!workspaceId || record?.workspaceId === workspaceId) continue
      if (record?.stubPaneId && workspaces.has(record.workspaceId)) {
        await client.request('workspace.close', { workspace_id: record.workspaceId }).catch(() => undefined)
      }
      records[chat.id] = { workspaceId, stubPaneId: '', label: record?.label || '' }
      changed = true
    }
    for (const { workspaceId, label } of plan.rename) {
      await client.request('workspace.rename', { workspace_id: workspaceId, label }).catch(() => undefined)
      const sessionId = Object.keys(records).find(id => records[id].workspaceId === workspaceId)
      if (!sessionId) continue
      records[sessionId] = { ...records[sessionId], label }
      changed = true
      // The waiting pane carries the chat's title too.
      const title = chats.find(chat => chat.id === sessionId)?.title
      if (records[sessionId].stubPaneId && title) {
        await client.request('pane.rename', { pane_id: records[sessionId].stubPaneId, label: title.slice(0, 48) }).catch(() => undefined)
      }
    }
    const created: string[] = []
    for (const chat of plan.create) {
      if (this.stopped || client !== this.client) break
      const record = await this.createChatSpace(client, chat, pane).catch(error => {
        this.log('warn', '[herdr] could not create a chat space', { sessionId: chat.id, error: String(error) })
        return null
      })
      if (!record) continue
      records[chat.id] = record
      created.push(record.workspaceId)
      changed = true
    }
    const order = [...plan.order, ...created]
    if (order.length > 1) {
      // herdr's sidebar keeps Studio's folder order; other spaces stay above.
      const current = this.snapshot.workspaces.map(workspace => workspace.workspace_id).filter(id => order.includes(id))
      if (created.length || current.join(',') !== plan.order.join(',')) {
        await client.request('workspace.move_block', { workspace_ids: order }).catch(() => undefined)
      }
    }
    if (changed) {
      this.persisted.chatSpaces = records
      await this.savePersisted()
      this.scheduleRefresh(0)
    }
    // Look again once a silent waiting pane's grace is over.
    const left = [...this.silentStubs.values()].map(since => STUB_GRACE_MS - (Date.now() - since)).filter(ms => ms > 0)
    if (left.length) this.scheduleChatSync(Math.min(...left) + 500)
  }

  /** The waiting pane's environment (also what herdr runs to bring it back). */
  private stubEnv(chat: ChatSpaceChat, pane: ChatPaneSetup): Record<string, string> {
    const kind = chat.hostable ? this.deps.herdrKindFor(chat.agent) || '' : ''
    return {
      ...pane.env,
      STUDIO_CHAT_KIND: kind,
      // What herdr's agent list calls the chat's agent (Ekko and Hermes chats show too).
      STUDIO_CHAT_AGENT: kind || chatAgentLabel(chat.agent),
      STUDIO_CHAT_URL: `${pane.studioUrl}/#/hermes/session/${encodeURIComponent(chat.id)}`,
    }
  }

  /** Whether the pane still runs its waiting script (not a plain shell). */
  private async stubRunning(client: HerdrSocketClient, paneId: string): Promise<boolean> {
    const info = await client.request<any>('pane.process_info', { pane_id: paneId }).catch(() => null)
    const processes: Array<{ argv?: string[] }> = info?.process_info?.foreground_processes || []
    return processes.some(item => (item.argv || []).some(arg => arg.endsWith('studio-chat.sh')))
  }

  private async createChatSpace(client: HerdrSocketClient, chat: ChatSpaceChat, pane: ChatPaneSetup): Promise<ChatSpaceRecord> {
    const label = chatSpaceLabel(chat)
    const cwd = chat.workspace || process.env.HOME || '/'
    const created = await client.request<any>('workspace.create', { cwd, label, focus: false })
    const workspaceId = String(created?.workspace?.workspace_id || '')
    const tabId = String(created?.tab?.tab_id || '')
    if (!workspaceId || !tabId) throw new Error('herdr did not return the new workspace')
    const applied = await client.request<any>('layout.apply', {
      tab_id: tabId,
      tab_label: (chat.title || 'Chat').slice(0, 32),
      focus: false,
      root: {
        type: 'pane',
        label: (chat.title || 'Chat').slice(0, 48),
        cwd,
        command: ['sh', pane.script, chat.id],
        env: this.stubEnv(chat, pane),
      },
    })
    const stubPaneId = String(applied?.layout?.focused_pane_id || applied?.layout?.root?.pane_id || '') || await this.firstPaneIn(workspaceId)
    return { workspaceId, stubPaneId, label, hostable: chat.hostable }
  }

  /** Each chat's card (title, folder, agent, newest messages), shown in its waiting pane. */
  private async writeCards(chats: ChatSpaceChat[], dir: string): Promise<void> {
    await mkdir(dir, { recursive: true })
    for (const chat of chats) {
      const key = `${chat.title}|${chat.folderPath.join('/')}|${chat.agent}|${chat.lastActive}`
      if (this.cards.get(chat.id) === key) continue
      const preview = await this.deps.chatPreview?.(chat.id).catch(() => []) ?? []
      const lines = [
        `  \u001b[1m${chat.title || 'Chat'}\u001b[0m`,
        `  ${[...chat.folderPath, ''].join(' / ').replace(/ \/ $/, '') || 'No folder'} · ${chat.agent || 'chat'}`,
        '',
        ...preview.slice(-6).map(message => `  ${message.role === 'user' ? '>' : ' '} ${message.text.replace(/\s+/g, ' ').slice(0, 300)}`),
      ]
      await writeFile(join(dir, `${chat.id.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`), `${lines.join('\n')}\n`).catch(() => undefined)
      this.cards.set(chat.id, key)
    }
  }

  /**
   * A chat's waiting pane resumes its agent in place: the launch the pane runs,
   * and the pane remembered as this chat's so herdr's detection links it.
   */
  async prepareResume(sessionId: string, paneId: string): Promise<HerdrInteractiveLaunch> {
    if (!this.snapshot.panes.some(pane => pane.pane_id === paneId)) throw Object.assign(new Error('No such herdr pane'), { status: 404 })
    const row = this.deps.getSession(sessionId)
    if (!row) throw Object.assign(new Error('Chat not found'), { status: 404 })
    await this.refreshAgentAccess(true)
    const launch = await this.deps.prepareSessionLaunch(sessionId)
    this.pending.set(paneId, { sessionId, agentId: launch.agentId, provider: launch.provider, model: launch.model, title: row.title || '' })
    this.scheduleRefresh(500)
    // No agent session to resume (an old chat): the fresh session starts from the chat so far.
    if (!row.agent_native_session_id && this.deps.chatRecap) {
      void this.deps.chatRecap(sessionId).then(recap => recap ? this.promptWhenAgentStarted(paneId, recap) : false)
        .catch(error => this.log('warn', '[herdr] could not give the agent the chat so far', { sessionId, error: String(error) }))
    }
    return launch
  }

  /**
   * Prompt the agent once it has started in the pane: it has reported its own
   * session (a chat's waiting pane reports an idle agent without one).
   */
  async promptWhenAgentStarted(paneId: string, text: string, timeoutMs = 90000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.stopped) {
      const pane = this.panes.find(entry => entry.pane_id === paneId)
      if (pane?.nativeSessionId && (pane.agent_status === 'idle' || pane.agent_status === 'done')) return this.promptWhenReady(paneId, text, 15000)
      await new Promise(resolve => setTimeout(resolve, 500))
      this.scheduleRefresh(0)
    }
    this.log('warn', '[herdr] agent did not start in time for the chat so far', { paneId })
    return false
  }

  /** Wake a sleeping chat: it gets its herdr space now and stays awake for the awake window. */
  async wakeChat(sessionId: string): Promise<ChatSpaceRecord | null> {
    this.persisted.wokenChats = { ...(this.persisted.wokenChats || {}), [sessionId]: Date.now() }
    await this.savePersisted()
    // Run the sync now (after one already running), not on the usual delay.
    while (this.chatSync) await this.chatSync.catch(() => undefined)
    this.chatSync = this.syncChatSpaces().finally(() => { this.chatSync = null })
    await this.chatSync
    return this.persisted.chatSpaces?.[sessionId] ?? null
  }

  /** A herdr pane (a chat's waiting pane) talks to its chat through Studio's own runs. */
  async prepareChat(sessionId: string, paneId: string): Promise<StudioChatAccess> {
    if (!this.snapshot.panes.some(pane => pane.pane_id === paneId)) throw Object.assign(new Error('No such herdr pane'), { status: 404 })
    if (!this.deps.getSession(sessionId)) throw Object.assign(new Error('Chat not found'), { status: 404 })
    if (!this.deps.chatAccess) throw Object.assign(new Error('Studio cannot run chats from herdr here'), { status: 501 })
    return this.deps.chatAccess(sessionId)
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
    const cwd = pane.foreground_cwd || pane.cwd || ''
    this.deps.createSession({
      id,
      agent: studioAgent,
      nativeId,
      title,
      workspace: cwd || null,
      profile: this.settings.profile || 'default',
      provider: pending?.provider,
      model: pending?.model,
      // Chats made in herdr are Studio chats: they go in the space's Studio folder.
      categoryId: pending?.categoryId ?? await this.categoryForPane(pane, cwd),
    })
    // Herdr-born chats import their whole history.
    if (path) this.persisted.offsets[id] = { path, offset: 0 }
    await this.savePersisted()
    this.log('info', '[herdr] imported agent session', { sessionId: id, agent: studioAgent, pane: pane.pane_id })
    return id
  }

  /** A chat already in the same space decides; else where the space is filed. */
  private async categoryForPane(pane: HerdrPane, cwd: string): Promise<number | null> {
    for (const view of this.panes) {
      if (view.workspace_id !== pane.workspace_id || view.pane_id === pane.pane_id || !view.studioSessionId) continue
      const category = this.deps.getSession(view.studioSessionId)?.category_id
      if (category != null) return category
    }
    try { return (await this.deps.categoryForSpace?.(pane.workspace_id, cwd)) ?? null } catch { return null }
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
      if (raw?.working && typeof raw.working === 'object') this.persisted.working = raw.working
      if (raw?.chatSpaces && typeof raw.chatSpaces === 'object') this.persisted.chatSpaces = raw.chatSpaces
      if (raw?.wokenChats && typeof raw.wokenChats === 'object') this.persisted.wokenChats = raw.wokenChats
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
    // The chat waits in its own herdr space: resume it there, as Enter in that pane does.
    // A sleeping chat wakes into its space first.
    let record = this.persisted.chatSpaces?.[sessionId]
    let ready = !!record?.stubPaneId && this.snapshot.panes.some(pane => pane.pane_id === record!.stubPaneId)
    if (!ready && this.settings.chatSpaces !== false && this.deps.listChatSpaces) {
      await this.wakeChat(sessionId)
      record = this.persisted.chatSpaces?.[sessionId]
      ready = !!record?.stubPaneId
    }
    if (record?.stubPaneId && ready) {
      const client = this.requireClient()
      await this.focusPane(record.stubPaneId).catch(() => undefined)
      await client.request('pane.send_keys', { pane_id: record.stubPaneId, keys: ['Enter'] })
      const link: HerdrLinkInfo = { paneId: record.stubPaneId, workspaceId: record.workspaceId, status: 'unknown' }
      this.links.set(sessionId, link)
      this.deps.setLink(sessionId, link)
      return link
    }
    await this.refreshAgentAccess(true)
    const launch = await this.deps.prepareSessionLaunch(sessionId)
    return this.openLaunch(launch, row.title || this.deps.agentLabel(launch.agentId), {
      sessionId,
      agentId: launch.agentId,
      provider: launch.provider,
      model: launch.model,
      title: row.title || '',
    })
  }

  /**
   * Start a new agent in herdr with Studio's provider routing, MCP and prompt.
   * With `prompt`, the task is typed into the agent once it is ready, which is
   * how a plan from Pondering Orb (or any card) becomes a running agent.
   */
  async launchAgent(agentId: string, input: { provider?: string; model?: string; workspace?: string; title?: string; prompt?: string; onWorking?: HerdrWorkRef }): Promise<HerdrLinkInfo> {
    await this.refreshAgentAccess(true)
    // Project work starts in the project's folder (its start directory) and files its chat there.
    const folder = input.onWorking ? await this.deps.folderForWork?.(input.onWorking).catch(() => null) ?? null : null
    const workspace = folder?.workspace || input.workspace
    const launch = await this.deps.prepareAgentLaunch(agentId, { provider: input.provider, model: input.model, workspace, profile: this.settings.profile || 'default' })
    const title = input.title?.trim() || this.deps.agentLabel(launch.agentId)
    const link = await this.openLaunch(launch, title, {
      categoryId: folder?.categoryId ?? null,
      agentId: launch.agentId,
      provider: launch.provider,
      model: launch.model,
      title,
    })
    if (input.onWorking) {
      this.persisted.working = { ...this.persisted.working, [link.paneId]: { ...input.onWorking, at: Date.now() } }
      void this.savePersisted()
    }
    const prompt = String(input.prompt || '').trim()
    if (prompt) void this.promptWhenReady(link.paneId, prompt)
    return link
  }

  /** The login lasts an hour; refresh it at most every 15 minutes while agents work. */
  private async refreshAgentAccess(force: boolean): Promise<void> {
    if (!this.deps.grantAgentAccess) return
    const profile = this.settings.profile || 'default'
    if (!force && Date.now() - (this.accessAt.get(profile) || 0) < 15 * 60 * 1000) return
    this.accessAt.set(profile, Date.now())
    try { await this.deps.grantAgentAccess(profile) } catch (error) {
      this.accessAt.delete(profile)
      this.log('warn', '[herdr] could not give agents a Studio login', { profile, error: String(error) })
    }
  }

  /** Follow the agent on a piece of work: from its first `working`, report every change. */
  private trackWork(paneId: string, status: HerdrAgentStatus, agent: string | null) {
    const ref = this.persisted.working?.[paneId]
    if (!ref || status === 'unknown') return
    if (!ref.started && status !== 'working') return
    if (ref.last === status) return
    ref.started = true
    ref.last = status
    void this.savePersisted()
    this.reportWork(ref, paneId, status, agent)
  }

  private workReports = new Map<string, Promise<void>>()

  private reportWork(ref: HerdrWorkRef, paneId: string, status: HerdrAgentStatus | 'gone', agent: string | null) {
    const previous = this.workReports.get(paneId) || Promise.resolve()
    const next = previous
      .then(() => this.deps.workStatusChanged?.(ref, paneId, status, agent))
      .catch(error => this.log('warn', '[herdr] could not report the agent status for its work', { paneId, status, error: String(error) }))
    this.workReports.set(paneId, next)
    void next.then(() => { if (this.workReports.get(paneId) === next) this.workReports.delete(paneId) })
  }

  /** Wait until the agent in a pane is ready for input, then send the prompt once. */
  async promptWhenReady(paneId: string, text: string, timeoutMs = 90000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.stopped) {
      const pane = this.panes.find(entry => entry.pane_id === paneId)
      if (!pane && Date.now() > deadline - timeoutMs + 15000) break
      if (pane?.agent && (pane.agent_status === 'idle' || pane.agent_status === 'done')) {
        try {
          await this.requireClient().request('agent.prompt', { target: paneId, text }, 15000)
          return true
        } catch (error) {
          this.log('warn', '[herdr] could not send the initial prompt', { paneId, error: String(error) })
          return false
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500))
      this.scheduleRefresh(0)
    }
    this.log('warn', '[herdr] agent was not ready for its initial prompt', { paneId })
    return false
  }

  /** New empty space (herdr workspace) with a shell, optionally in a folder. */
  async createWorkspace(input: { cwd?: string; label?: string }): Promise<{ workspaceId: string; paneId: string }> {
    const created = await this.requireClient().request<any>('workspace.create', {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.label ? { label: input.label.slice(0, 48) } : {}),
      focus: true,
    })
    this.scheduleRefresh(0)
    return { workspaceId: String(created?.workspace?.workspace_id || ''), paneId: String(created?.root_pane?.pane_id || '') }
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
