import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  HERDR_LIFECYCLE_EVENTS,
  herdrDetectsKind,
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
import { newTranscriptSince, readTranscriptFrom, type TranscriptMessage } from './transcript'
import { herdrChatProfile, type HerdrSettings } from './runtime'

import { chatAgentLabel, chatSpaceLabel, elevatedChatList, elevatedChatsFrom, planChatSpaces, planSeparation, type ChatSpaceChat, type ChatSpaceRecord } from './chat-spaces'

export interface HerdrSessionRef {
  id: string
  agent: string
  title: string | null
  workspace: string | null
  agent_native_session_id: string
  message_count?: number
  /** Studio chat folder (session category). */
  category_id?: number | null
  /** The chat's Studio profile. */
  profile?: string | null
}

export interface HerdrInteractiveLaunch {
  agentId: string
  command: string
  args: string[]
  env: Record<string, string>
  workspaceDir: string
  provider: string
  model: string
  /** The agent runs in the chat's clean-room container (the pane runs the docker client). */
  cleanRoom?: boolean
  /**
   * When the agent refuses `args` (Hermes: exit 2, the chat's model differs from the one its
   * session started with), the pane runs these instead, then `afterRetryInput` is typed there.
   */
  retryArgs?: string[]
  afterRetryInput?: string
  /** Host folder that is the agent's home inside its clean room (its transcripts land there). */
  agentHome?: string
}

export interface HerdrLinkInfo {
  paneId: string
  workspaceId: string
  status: HerdrAgentStatus
  /** The chat's waiting pane (no agent running there yet). */
  waiting?: boolean
  /** The Upstream Manager task the agent works on, when Upstream started it. */
  upstream?: { task: string; title?: string; repo?: string }
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
  /** Every Studio chat (all agents, not archived); the elevated ones are herdr spaces. */
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
  /**
   * Studio's per-turn context for a message Studio's chat box types into a chat's live
   * pane (docs/harness/herdr.md, "Studio's context blocks"). Studio begins the turn's
   * context (task card), puts it where the pane's agent reads it, and returns what to
   * add after the typed text when the pane cannot read it otherwise. `isCurrent` says
   * whether the pane turn still runs; `end` is called once when it is over.
   */
  paneTurn?: (sessionId: string, paneId: string, isCurrent: () => boolean, text: string) => Promise<HerdrPaneTurn | null>
}

/** Studio's context for one pane turn typed from Studio's chat box. */
export interface HerdrPaneTurn {
  /** Context blocks to type after the message (agents without Studio's hook). */
  append?: string
  end: (state: 'ended' | 'interrupted' | 'failed') => void
}

type PaneTurnEntry = { sessionId: string; working: boolean; timer?: ReturnType<typeof setTimeout>; end: HerdrPaneTurn['end'] }

/** A pane turn waits this long for its agent to start working before it counts as over. */
const PANE_TURN_START_MS = 120_000

/** What a launched agent is for (e.g. a Pondering Orb task or project). */
export interface HerdrWorkRef {
  /** When it was launched (set by the bridge). */
  at?: number
  /** Set once the agent first worked; later changes are reported from then on. */
  started?: boolean
  /** Last status reported. */
  last?: string
  orb?: { task?: { title: string; list: string }; project?: string }
  /** An Upstream Manager task (Upstream started the agent through Studio; see services/upstream). */
  upstream?: { task: string; title?: string; repo?: string }
}

export interface HerdrPaneView extends HerdrPane {
  studioAgent: string | null
  studioSessionId: string | null
  nativeSessionId: string | null
  /** When the pane's agent took its current status (ms; Studio's own clock), for "time in state". */
  status_since?: number
}

export interface HerdrBridgeState {
  connected: boolean
  error: string
  version: string
  focusedPaneId: string | null
  workspaces: HerdrSnapshot['workspaces']
  panes: HerdrPaneView[]
  /** Studio chats with a herdr space now. */
  chatSpaces: string[]
  /** Chats elevated to herdr (by hand, or with their agent running there); every other chat is Studio-only. */
  elevatedChats?: string[]
  /** Waiting panes of chat spaces (the chat's agent is not running): not agents in the Agents list. */
  waitingPanes?: string[]
}

interface PersistedState {
  offsets: Record<string, { path: string; offset: number }>
  /** Native session ids whose chat was deleted in Studio: never re-import them. */
  dismissed: string[]
  /** Agents launched for a piece of work, by pane id, until their pane closes. */
  working?: Record<string, HerdrWorkRef>
  /** Each Studio chat's herdr space, by chat id. */
  chatSpaces?: Record<string, ChatSpaceRecord>
  /** Chats elevated to herdr, and when: they keep their space until they return to Studio, their space is closed in herdr, or the chat goes away. */
  elevatedChats?: Record<string, number>
  /**
   * When this install moved from "every chat is a herdr space" to elevated
   * chats (`planSeparation`). Unset until it ran once with herdr connected.
   */
  separatedAt?: number
  /** "The chat so far" sent to a fresh agent session: kept out of the mirrored chat, with its reply. */
  recaps?: Record<string, { text: string; at: number; replying?: boolean }>
  /**
   * Panes running an agent herdr cannot detect (CodeBuddy, ZCode), by pane id:
   * Studio links them to their chat itself, also after a Studio restart.
   */
  hosted?: Record<string, PendingLaunch>
  /** Chats closed in herdr, newest last (see `closedChatEntries`); "Reopen closed chat" takes from the end. */
  closedChats?: ClosedChatEntry[]
}

/** One closed chat in a closed-chats entry. */
export interface ClosedChat {
  sessionId: string
  paneId: string
  workspaceId: string
  tabId?: string
  title?: string
}

/** Chats that closed together: one pane, or every chat pane of a closed tab or space. */
export interface ClosedChatEntry {
  at: number
  /** What was closed: a pane, a tab or a whole space (herdr workspace). */
  closed: 'pane' | 'tab' | 'workspace'
  chats: ClosedChat[]
}

/** How many closed entries "Reopen closed chat" remembers. */
export const MAX_CLOSED_CHATS = 50

/**
 * Chats that closed between two looks at herdr (on the same herdr server):
 * a chat whose pane was there before and has no pane now. Chats whose pane
 * Studio closed itself (`studioClosed`: pane or workspace ids) are not closes
 * by the user. Chats that went with the same space or tab are one entry.
 */
export function closedChatEntries(input: {
  before: Array<Pick<HerdrPaneView, 'pane_id' | 'workspace_id' | 'tab_id' | 'studioSessionId'>>
  after: Array<Pick<HerdrPaneView, 'pane_id' | 'workspace_id' | 'tab_id' | 'studioSessionId'>>
  workspaces: Set<string>
  studioClosed?: Set<string>
  titles?: Map<string, string>
  now?: number
}): ClosedChatEntry[] {
  const still = new Set(input.after.map(pane => pane.studioSessionId).filter(Boolean))
  const tabs = new Set(input.after.map(pane => pane.tab_id).filter(Boolean))
  const groups = new Map<string, ClosedChatEntry>()
  const seen = new Set<string>()
  for (const pane of input.before) {
    const sessionId = pane.studioSessionId
    if (!sessionId || still.has(sessionId) || seen.has(sessionId)) continue
    if (input.studioClosed?.has(pane.pane_id) || input.studioClosed?.has(pane.workspace_id)) continue
    seen.add(sessionId)
    const closed: ClosedChatEntry['closed'] = !input.workspaces.has(pane.workspace_id) ? 'workspace' : pane.tab_id && !tabs.has(pane.tab_id) ? 'tab' : 'pane'
    const key = closed === 'workspace' ? `w:${pane.workspace_id}` : closed === 'tab' ? `t:${pane.tab_id}` : `p:${pane.pane_id}`
    const entry = groups.get(key) ?? { at: input.now ?? Date.now(), closed, chats: [] }
    const title = input.titles?.get(sessionId)
    entry.chats.push({ sessionId, paneId: pane.pane_id, workspaceId: pane.workspace_id, ...(pane.tab_id ? { tabId: pane.tab_id } : {}), ...(title ? { title } : {}) })
    groups.set(key, entry)
  }
  return [...groups.values()]
}

/** Push closed entries onto the stack (newest last), keeping the newest `max`. */
export function pushClosedChats(stack: ClosedChatEntry[], entries: ClosedChatEntry[], max = MAX_CLOSED_CHATS): ClosedChatEntry[] {
  return [...stack, ...entries].slice(-max)
}

function validClosedEntries(raw: unknown): ClosedChatEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry: any) => entry && typeof entry.at === 'number' && Array.isArray(entry.chats)
    && entry.chats.every((chat: any) => chat && typeof chat.sessionId === 'string'))
    .slice(-MAX_CLOSED_CHATS) as ClosedChatEntry[]
}

const RECAP_MIRROR_WINDOW_MS = 30 * 60 * 1000
/** How long an agent herdr cannot detect gets to draw its terminal UI before Studio types into it. */
const UNDETECTED_START_MS = 4000

/**
 * Where a chat's herdr space starts: the chat's folder, or the home folder when
 * the chat has none or its folder is gone (moved or deleted since), so the
 * space is still made.
 */
export async function chatSpaceCwd(workspace: string | null | undefined, home = process.env.HOME || '/'): Promise<string> {
  const folder = String(workspace || '').trim()
  if (!folder) return home
  try {
    if ((await stat(folder)).isDirectory()) return folder
  } catch { /* gone */ }
  return home
}

/** The agent's own config home from its launch (Studio-provider agents keep sessions there). */
export function configHomeEnv(env: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  if (env?.CODEX_HOME) out.CODEX_HOME = env.CODEX_HOME
  if (env?.CLAUDE_CONFIG_DIR) out.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR
  return out
}

/**
 * Drops the recap Studio typed into a fresh session (one or more user messages
 * that are part of it) and the agent's answer to it, up to the next real user
 * message. Returns the messages to keep and the marker's new state (null: done).
 */
export function withoutRecap(messages: TranscriptMessage[], marker: { text: string; replying?: boolean }): { messages: TranscriptMessage[]; marker: { text: string; replying?: boolean } | null } {
  const recap = marker.text.replace(/\s+/g, ' ').trim()
  let replying = !!marker.replying
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const text = message.content.replace(/\s+/g, ' ').trim()
    if (message.role === 'user') {
      if (text && recap.includes(text)) { replying = true; continue }
      // The person's own next message: everything from here is the real chat.
      return { messages: messages.slice(index), marker: null }
    }
    if (!replying) return { messages: messages.slice(index), marker: null }
  }
  return { messages: [], marker: { ...marker, replying } }
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

/** Hermes's terminal UI is up: its input line ("❯") and status bar ("☤ <model>") are drawn. */
export function hermesInputReady(screen: string): boolean {
  const lines = screen.split(/\r?\n/)
  return lines.some(line => /^\s*❯/.test(line)) && lines.some(line => /^\s*☤\s/.test(line))
}

export class HerdrBridge {
  private client: HerdrSocketClient | null = null
  private subscription: { close: () => void } | null = null
  private statusSubscription: { close: () => void } | null = null
  private statusPaneKey = ''
  private snapshot: HerdrSnapshot = { workspaces: [], panes: [] }
  private panes: HerdrPaneView[] = []
  private links = new Map<string, HerdrLinkInfo>()
  /** Turns Studio's chat box typed into a live pane, by pane, until the agent is done. */
  private paneTurns = new Map<string, PaneTurnEntry>()
  /** Panes Studio opened itself: pane id → launch details. */
  private pending = new Map<string, PendingLaunch>()
  /** Text to type into a pane once its agent's retry launch runs (see `HerdrInteractiveLaunch.retryArgs`). */
  private readonly afterRetryInputs = new Map<string, string>()
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
  private reconcileRetry: ReturnType<typeof setTimeout> | null = null
  /** Spaces this bridge just made, by workspace id: a snapshot taken a moment earlier may not show them yet. */
  private recentChatSpaces = new Map<string, { at: number; stubPaneId: string }>()
  /** What each chat card was last written from, so unchanged cards are not rewritten. */
  private cards = new Map<string, string>()
  /** The herdr connection `panes` was read on: closes are only seen against the same server. */
  private panesClient: HerdrSocketClient | null = null
  /** Panes and spaces Studio closed itself (not closes by the user), and when. */
  private studioClosing = new Map<string, number>()
  /** One "Reopen closed chat" at a time: a second press goes further back. */
  private reopening: Promise<unknown> = Promise.resolve()
  /** Chats returning to Studio, and since when: their agent may still show live for a moment. */
  private returning = new Map<string, number>()
  /** The herdr connection the last chat sync ran on: a space gone on the same one was closed in herdr. */
  private chatSyncClient: HerdrSocketClient | null = null

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
      chatSpaces: Object.keys(this.persisted.chatSpaces || {}),
      elevatedChats: this.elevatedChatIds(),
      // A chat whose agent runs (in its waiting pane after Enter, or elsewhere) has no waiting pane.
      waitingPanes: Object.entries(this.persisted.chatSpaces || {}).filter(([sessionId, record]) => record.stubPaneId && !this.liveChats.has(sessionId)).map(([, record]) => record.stubPaneId),
    }
  }

  /** Chats in herdr: elevated by hand, or with their agent running there (not while returning to Studio). */
  elevatedChatIds(): string[] {
    const returning = this.returningChats()
    const ids = new Set(Object.keys(this.persisted.elevatedChats || {}))
    for (const sessionId of this.liveChats.keys()) if (!returning.has(sessionId)) ids.add(sessionId)
    return [...ids]
  }

  /** Whether the chat is elevated to herdr. */
  isElevated(sessionId: string): boolean {
    return this.persisted.elevatedChats?.[sessionId] != null || (this.liveChats.has(sessionId) && !this.returningChats().has(sessionId))
  }

  private returningChats(): Set<string> {
    const now = Date.now()
    for (const [id, at] of this.returning) if (now - at > 30_000) this.returning.delete(id)
    return new Set(this.returning.keys())
  }

  /** Each elevated chat's herdr space (chat id → workspace id). */
  chatWorkspaces(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.persisted.chatSpaces || {}).map(([sessionId, record]) => [sessionId, record.workspaceId]))
  }

  /** Whether the chat has its own herdr space (it is elevated). */
  hasChatSpace(sessionId: string): boolean {
    return !!this.persisted.chatSpaces?.[sessionId]
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
    if (this.chatSyncTimer) clearTimeout(this.chatSyncTimer)
    if (this.reconcileRetry) clearTimeout(this.reconcileRetry)
    this.refreshTimer = this.mirrorTimer = this.retryTimer = this.chatSyncTimer = this.reconcileRetry = null
    for (const paneId of [...this.paneTurns.keys()]) this.endPaneTurn(paneId, 'interrupted')
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
          if (!this.stopped && !this.reconcileRetry) {
            this.reconcileRetry = setTimeout(() => { this.reconcileRetry = null; this.scheduleRefresh(0) }, 1000)
            this.reconcileRetry.unref?.()
          }
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
    for (const paneId of [...this.paneTurns.keys()]) if (!livePaneIds.has(paneId)) this.endPaneTurn(paneId, 'interrupted')
    if (this.persisted.hosted) {
      const gone = Object.keys(this.persisted.hosted).filter(paneId => !livePaneIds.has(paneId))
      for (const paneId of gone) delete this.persisted.hosted[paneId]
      if (gone.length) void this.savePersisted()
    }
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
      const pending = this.pending.get(pane.pane_id) ?? this.hostedPending(pane)
      const studioAgent = studioAgentForHerdrAgent(pane.agent) ?? (pending?.agentId || null)
      const nativeId = pane.agent ? nativeSessionIdOf(pane) : null
      const status: HerdrAgentStatus = isHerdrStatus(pane.agent_status) ? pane.agent_status : 'unknown'
      let sessionId: string | null = null

      if (nativeId && (status === 'working' || status === 'blocked')) this.active.add(nativeId)
      if (this.persisted.working?.[pane.pane_id]) this.trackWork(pane.pane_id, status, pane.agent || null)
      this.trackPaneTurn(pane.pane_id, status)
      if (status === 'working' && pane.agent) void this.refreshAgentAccess(false)

      if (pending?.sessionId) {
        sessionId = pending.sessionId
        // Resuming can fork a new native session; follow it so the link survives restarts.
        if (nativeId) {
          const row = this.deps.getSession(sessionId)
          if (row && row.agent_native_session_id !== nativeId) this.deps.updateNativeSessionId(sessionId, nativeId)
        }
      } else if (nativeId) {
        // A Hermes chat runs as the Hermes session named after the chat itself (herdr brings
        // such a pane back after a restart without Studio launching it).
        const own = pane.agent === 'hermes' ? this.deps.getSession(nativeId) : null
        const row = this.deps.findSessionByNativeId(nativeId) ?? (own?.agent === 'hermes' ? own : null) ?? this.deps.getSession(herdrChatId(nativeId))
        if (row) sessionId = row.id
        else if (this.settings.autoImport && studioAgent && !this.persisted.dismissed.includes(nativeId)) {
          sessionId = await this.importPane(pane, studioAgent, nativeId, pending)
        }
        if (sessionId && pending) pending.sessionId = sessionId
      }

      // The chat's own agent runs here (a waiting pane has no agent session of its own).
      if (sessionId && (nativeId || pending)) liveChats.set(sessionId, pane.workspace_id)
      // A chat's waiting pane stands for its chat until its agent resumes.
      let waiting = false
      if (!sessionId && stubOwner.has(pane.pane_id)) { sessionId = stubOwner.get(pane.pane_id)!; waiting = true }

      // A chat whose agent runs in another pane (herdr brought it back after a restart) is linked
      // to that pane, not to its waiting pane.
      if (sessionId && waiting && liveChats.has(sessionId)) sessionId = null
      if (sessionId) {
        seen.add(sessionId)
        const upstream = this.persisted.working?.[pane.pane_id]?.upstream
        const link: HerdrLinkInfo = { paneId: pane.pane_id, workspaceId: pane.workspace_id, status, ...(waiting ? { waiting: true } : {}), ...(upstream ? { upstream } : {}) }
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
    if (this.panesClient === client) this.noteClosedChats(this.panes, views, snapshot)
    this.panesClient = client
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
      void this.runChatSync()
    }, delayMs)
    this.chatSyncTimer.unref?.()
  }

  /** One chat sync now; a sync asked for while it ran follows it. */
  private runChatSync(): Promise<void> {
    const run = this.syncChatSpaces()
      .catch(error => this.log('warn', '[herdr] could not sync chat spaces', { error: String(error) }))
      .finally(() => {
        if (this.chatSync === run) this.chatSync = null
        if (this.chatSyncAgain) { this.chatSyncAgain = false; this.scheduleChatSync(0) }
      })
    this.chatSync = run
    return run
  }

  /**
   * Elevated chats are herdr spaces: an elevated chat without one gets a space
   * with a waiting pane, labels follow titles and folders, spaces of chats
   * that returned to Studio or are gone close, and spaces keep Studio's folder
   * order in herdr's sidebar. Studio-only chats get nothing in herdr.
   */
  private async syncChatSpaces(): Promise<void> {
    const client = this.client
    if (!client || !this.deps.listChatSpaces || !this.deps.chatPane) return
    const records = { ...(this.persisted.chatSpaces || {}) }
    // A fresh look at herdr: the last snapshot can be older than spaces an
    // earlier sync just made, and planning from it would make them again.
    const snapshot = normalizeSnapshot(await client.request('session.snapshot', {}, 15000))
    if (this.stopped || client !== this.client) return
    const now = Date.now()
    for (const [id, made] of this.recentChatSpaces) if (now - made.at > 30_000) this.recentChatSpaces.delete(id)
    const workspaces = new Set(snapshot.workspaces.map(workspace => workspace.workspace_id))
    for (const id of this.recentChatSpaces.keys()) workspaces.add(id)
    let changed = false
    if (this.persisted.separatedAt == null) changed = await this.separateOnce(client, records, workspaces)
    const pane = await this.deps.chatPane()
    if (!pane) { if (changed) await this.savePersisted(); return }
    const allChats = await this.deps.listChatSpaces()
    const elevated = { ...(this.persisted.elevatedChats || {}) }
    const chatIds = new Set(allChats.map(chat => chat.id))
    for (const id of Object.keys(elevated)) if (!chatIds.has(id)) { delete elevated[id]; changed = true }
    // A space gone while herdr kept running (same connection) was closed there:
    // its chat is back in Studio. A new connection may be a herdr that started
    // over; its elevated chats get their spaces again.
    if (this.chatSyncClient === client) {
      for (const [sessionId, record] of Object.entries(records)) {
        if (workspaces.has(record.workspaceId) || this.liveChats.has(sessionId) || this.studioClosing.has(record.workspaceId)) continue
        if (elevated[sessionId] != null) { delete elevated[sessionId]; changed = true }
      }
    }
    this.chatSyncClient = client
    // A chat whose agent runs in herdr is elevated (started there, or resumed there by hand).
    const returning = this.returningChats()
    for (const sessionId of this.liveChats.keys()) {
      if (chatIds.has(sessionId) && elevated[sessionId] == null && !returning.has(sessionId)) { elevated[sessionId] = now; changed = true }
    }
    this.persisted.elevatedChats = elevated
    const chats = elevatedChatList(allChats, { elevated, live: this.liveChats, returning })
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
      await this.closeSpaceByStudio(client, record.workspaceId)
      workspaces.delete(record.workspaceId)
      this.silentStubs.delete(record.stubPaneId)
      delete records[sessionId]
      changed = true
    }
    const panes = new Map(snapshot.panes.map(item => [item.pane_id, item.workspace_id]))
    for (const [id, made] of this.recentChatSpaces) if (made.stubPaneId && !panes.has(made.stubPaneId)) panes.set(made.stubPaneId, id)
    const plan = planChatSpaces({ chats, records, workspaces, panes, live: this.liveChats })
    for (const sessionId of plan.forget) { delete records[sessionId]; changed = true }
    for (const { sessionId, workspaceId } of plan.close) {
      await this.closeSpaceByStudio(client, workspaceId)
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
        await this.closeSpaceByStudio(client, record.workspaceId)
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
      this.recentChatSpaces.set(record.workspaceId, { at: Date.now(), stubPaneId: record.stubPaneId })
      created.push(record.workspaceId)
      changed = true
    }
    const order = [...plan.order, ...created]
    if (order.length > 1) {
      // herdr's sidebar keeps Studio's folder order; other spaces stay above.
      const current = snapshot.workspaces.map(workspace => workspace.workspace_id).filter(id => order.includes(id))
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

  /**
   * Once per install, with herdr connected: move from "every chat is a herdr
   * space" to elevated chats (planSeparation). Chats whose agent runs in
   * herdr become elevated; the next steps of this sync close the waiting
   * spaces of the others. Chat history is in Studio and is not touched.
   * Without herdr this never runs, so it runs the next time herdr is there.
   */
  private async separateOnce(client: HerdrSocketClient, records: Record<string, ChatSpaceRecord>, workspaces: Set<string>): Promise<boolean> {
    const waiting = new Set<string>()
    for (const [sessionId, record] of Object.entries(records)) {
      if (!record.stubPaneId || this.liveChats.has(sessionId) || !workspaces.has(record.workspaceId)) continue
      if (await this.stubRunning(client, record.stubPaneId) && !await this.stubBusy(client, record.stubPaneId)) waiting.add(record.stubPaneId)
    }
    if (this.stopped || client !== this.client) return false
    const plan = planSeparation({ records, live: this.liveChats, workspaces, waiting })
    const at = Date.now()
    this.persisted.elevatedChats = { ...Object.fromEntries(plan.elevate.map(id => [id, at])), ...(this.persisted.elevatedChats || {}) }
    this.persisted.separatedAt = at
    if (Object.keys(records).length || plan.elevate.length) {
      this.log('info', '[herdr] chats are Studio-only now; chats with an agent running in herdr stay elevated', {
        elevated: plan.elevate, closingWaitingSpaces: plan.close.length, spaces: Object.keys(records).length,
      })
    }
    return true
  }

  /**
   * Bring an elevated chat back to Studio: its herdr space closes (its agent
   * stops the way closing a pane stops it), the chat keeps its history and
   * runs in Studio again. Panes in the space that are not the chat's (a
   * shell opened there) keep the space open; then only the chat's panes close.
   */
  async returnToStudio(sessionId: string): Promise<{ closed: boolean }> {
    const client = this.requireClient()
    this.returning.set(sessionId, Date.now())
    if (this.persisted.elevatedChats) delete this.persisted.elevatedChats[sessionId]
    const record = this.persisted.chatSpaces?.[sessionId]
    const link = this.links.get(sessionId)
    const workspaceId = record?.workspaceId || link?.workspaceId || ''
    const chatPanes = this.panes.filter(pane => pane.studioSessionId === sessionId).map(pane => pane.pane_id)
    if (record?.stubPaneId && !chatPanes.includes(record.stubPaneId)) chatPanes.push(record.stubPaneId)
    if (link && !chatPanes.includes(link.paneId)) chatPanes.push(link.paneId)
    const closePanes = async () => {
      for (const paneId of chatPanes) {
        this.studioClosing.set(paneId, Date.now())
        await client.request('pane.close', { pane_id: paneId }).catch(() => undefined)
      }
      return chatPanes.length > 0
    }
    let closed = false
    if (workspaceId && this.snapshot.workspaces.some(space => space.workspace_id === workspaceId)) {
      const others = this.snapshot.panes.filter(pane => pane.workspace_id === workspaceId && !chatPanes.includes(pane.pane_id))
      if (!others.length) {
        await this.closeSpaceByStudio(client, workspaceId)
        closed = true
      } else closed = await closePanes()
    } else closed = await closePanes()
    if (this.persisted.chatSpaces?.[sessionId]) delete this.persisted.chatSpaces[sessionId]
    for (const [paneId, pending] of this.pending) if (pending.sessionId === sessionId) this.pending.delete(paneId)
    if (this.links.delete(sessionId)) this.deps.setLink(sessionId, null)
    await this.savePersisted()
    this.log('info', '[herdr] chat returned to Studio', { sessionId, workspaceId, closed })
    this.emit()
    this.scheduleRefresh(0)
    return { closed }
  }

  /** Studio closes a chat space itself (a returned or deleted chat, a remade space): not a close by the user. */
  private async closeSpaceByStudio(client: HerdrSocketClient, workspaceId: string): Promise<void> {
    this.studioClosing.set(workspaceId, Date.now())
    await client.request('workspace.close', { workspace_id: workspaceId }).catch(() => undefined)
  }

  /**
   * Chats whose pane went away since the last look (closed in herdr: a pane, a
   * tab or a whole space) go on the closed-chats stack for "Reopen closed chat",
   * and return to Studio (no longer elevated); reopening one elevates it again.
   */
  private noteClosedChats(before: HerdrPaneView[], after: HerdrPaneView[], snapshot: HerdrSnapshot) {
    const now = Date.now()
    for (const [id, at] of this.studioClosing) if (now - at > 60_000) this.studioClosing.delete(id)
    const titles = new Map<string, string>()
    for (const pane of before) {
      if (!pane.studioSessionId || titles.has(pane.studioSessionId)) continue
      const title = this.deps.getSession(pane.studioSessionId)?.title
      if (title) titles.set(pane.studioSessionId, title)
    }
    const entries = closedChatEntries({
      before,
      after,
      workspaces: new Set(snapshot.workspaces.map(workspace => workspace.workspace_id)),
      studioClosed: new Set(this.studioClosing.keys()),
      titles,
      now,
    })
    if (!entries.length) return
    this.persisted.closedChats = pushClosedChats(this.persisted.closedChats || [], entries)
    // A chat closed in herdr is back in Studio; reopening it elevates it again.
    if (this.persisted.elevatedChats) for (const entry of entries) for (const chat of entry.chats) delete this.persisted.elevatedChats[chat.sessionId]
    for (const entry of entries) for (const chat of entry.chats) this.returning.set(chat.sessionId, now)
    this.log('info', '[herdr] chats closed in herdr', { chats: entries.flatMap(entry => entry.chats.map(chat => chat.sessionId)) })
    void this.savePersisted()
  }

  /** Closed entries remembered for "Reopen closed chat", oldest first. */
  closedChats(): ClosedChatEntry[] {
    return [...(this.persisted.closedChats || [])]
  }

  /** Whether a closed chat can come back: it still exists, is not archived, and is not open in herdr now. */
  private async reopenableChats(): Promise<(sessionId: string) => boolean> {
    const listed = this.deps.listChatSpaces ? new Set((await this.deps.listChatSpaces()).map(chat => chat.id)) : null
    return sessionId => {
      if (!this.deps.getSession(sessionId)) return false
      if (listed && !listed.has(sessionId)) return false
      const link = this.links.get(sessionId)
      return !link || !!link.waiting
    }
  }

  /**
   * Reopen the newest closed chats (one entry: a pane, or the chats of a
   * closed tab or space) whose chats still exist, are not archived and are not
   * open: each resumes its agent's native session in its own space, as
   * opening it in herdr does. Entries with nothing to reopen are dropped; the
   * next call goes further back.
   */
  reopenClosed(): Promise<{ reopened: Array<{ sessionId: string; title: string; link: HerdrLinkInfo }>; remaining: number }> {
    const run = this.reopening.catch(() => undefined).then(() => this.reopenNext())
    this.reopening = run
    return run
  }

  private async reopenNext(): Promise<{ reopened: Array<{ sessionId: string; title: string; link: HerdrLinkInfo }>; remaining: number }> {
    this.requireClient()
    const reopenable = await this.reopenableChats()
    const stack = [...(this.persisted.closedChats || [])]
    const reopened: Array<{ sessionId: string; title: string; link: HerdrLinkInfo }> = []
    while (stack.length && !reopened.length) {
      const entry = stack.pop()!
      const ids = [...new Set(entry.chats.map(chat => chat.sessionId))].filter(reopenable)
      if (!ids.length) continue
      // Off the stack first: a failed reopen must not stick at the top.
      this.persisted.closedChats = stack
      await this.savePersisted()
      for (const sessionId of ids) {
        try {
          const link = await this.openSession(sessionId)
          reopened.push({ sessionId, title: this.deps.getSession(sessionId)?.title || '', link })
        } catch (error) {
          this.log('warn', '[herdr] could not reopen a closed chat', { sessionId, error: String(error) })
        }
      }
      if (reopened.length > 1) await this.focusPane(reopened[0].link.paneId).catch(() => undefined)
    }
    if ((this.persisted.closedChats || []).length !== stack.length) {
      this.persisted.closedChats = stack
      await this.savePersisted()
    }
    return { reopened, remaining: stack.length }
  }

  /** A pane Studio launched an agent herdr cannot detect in, restored after a Studio restart. */
  private hostedPending(pane: HerdrPane): PendingLaunch | undefined {
    const hosted = this.persisted.hosted?.[pane.pane_id]
    if (!hosted) return undefined
    // Only while the pane still runs that agent (herdr can reuse pane ids after it restarts).
    if (studioAgentForHerdrAgent(pane.agent) !== hosted.agentId) return undefined
    this.pending.set(pane.pane_id, { ...hosted })
    return this.pending.get(pane.pane_id)
  }

  /**
   * herdr cannot detect this agent (CodeBuddy, ZCode): once it runs in the pane,
   * report the pane as that agent (herdr lists it, status 'unknown') and keep
   * the pane as its chat's across Studio restarts. Detected agents report themselves.
   */
  async hostUndetectedAgent(paneId: string, launch: Pick<HerdrInteractiveLaunch, 'agentId' | 'command'>, pending: PendingLaunch, options: { startMs?: number } = {}): Promise<boolean> {
    const kind = this.deps.herdrKindFor(launch.agentId)
    if (!kind || herdrDetectsKind(kind)) return false
    this.persisted.hosted = { ...(this.persisted.hosted || {}), [paneId]: { ...pending } }
    void this.savePersisted()
    const client = this.client
    if (!client) return false
    // herdr ignores an unknown agent name while a shell is in the foreground: wait for the agent.
    const name = launch.command.split(/[\\/]/).pop() || launch.command
    const deadline = Date.now() + (options.startMs ?? 30000)
    let running = false
    while (!running && Date.now() < deadline && !this.stopped) {
      const info = await client.request<any>('pane.process_info', { pane_id: paneId }).catch(() => null)
      const processes: Array<{ argv?: string[]; argv0?: string }> = info?.process_info?.foreground_processes || []
      running = processes.some(item => [item.argv0, ...(item.argv || [])].some(arg => typeof arg === 'string' && (arg === launch.command || arg.split(/[\\/]/).pop() === name)))
      if (!running) await new Promise(resolve => setTimeout(resolve, 400))
    }
    if (!running) return false
    try {
      await client.request('pane.report_agent', { pane_id: paneId, source: 'studio:chat', agent: kind, state: 'unknown' })
    } catch (error) {
      this.log('warn', '[herdr] could not report the agent to herdr', { paneId, agent: kind, error: String(error) })
      return false
    }
    this.scheduleRefresh(0)
    return true
  }

  /** The waiting pane's environment (also what herdr runs to bring it back). */
  private stubEnv(chat: ChatSpaceChat, pane: ChatPaneSetup): Record<string, string> {
    const kind = chat.hostable ? this.deps.herdrKindFor(chat.agent) || '' : ''
    return {
      ...pane.env,
      STUDIO_CHAT_KIND: kind,
      // What herdr's agent list calls the chat's agent (Ekko and Hermes chats show too).
      // A waiting pane's shell is in the foreground, where herdr only keeps names it knows.
      STUDIO_CHAT_AGENT: herdrDetectsKind(kind) ? kind : chatAgentLabel(chat.agent),
      STUDIO_CHAT_URL: `${pane.studioUrl}/#/hermes/session/${encodeURIComponent(chat.id)}`,
    }
  }

  /** Whether the pane still runs its waiting script (not a plain shell). */
  private async stubRunning(client: HerdrSocketClient, paneId: string): Promise<boolean> {
    const info = await client.request<any>('pane.process_info', { pane_id: paneId }).catch(() => null)
    const processes: Array<{ argv?: string[] }> = info?.process_info?.foreground_processes || []
    return processes.some(item => (item.argv || []).some(arg => arg.endsWith('studio-chat.sh')))
  }

  /** Whether the waiting pane already left its card (resuming its agent or running Studio's chat client). */
  private async stubBusy(client: HerdrSocketClient, paneId: string): Promise<boolean> {
    if (this.pending.has(paneId)) return true
    const info = await client.request<any>('pane.process_info', { pane_id: paneId }).catch(() => null)
    const processes: Array<{ argv?: string[] }> = info?.process_info?.foreground_processes || []
    // studio-herdr.mjs runs while the pane resumes the agent (`resume`) or talks to Studio (`chat`).
    return processes.some(item => (item.argv || []).some(arg => arg.endsWith('studio-herdr.mjs')))
  }

  private async createChatSpace(client: HerdrSocketClient, chat: ChatSpaceChat, pane: ChatPaneSetup): Promise<ChatSpaceRecord> {
    const label = chatSpaceLabel(chat)
    const cwd = await chatSpaceCwd(chat.workspace)
    if (chat.workspace && cwd !== chat.workspace) this.log('info', '[herdr] chat folder is gone; its space starts in the home folder', { sessionId: chat.id, workspace: chat.workspace })
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
    await this.refreshAgentAccess(true, row.profile)
    const launch = await this.deps.prepareSessionLaunch(sessionId)
    const pending: PendingLaunch = { sessionId, agentId: launch.agentId, provider: launch.provider, model: launch.model, title: row.title || '' }
    this.pending.set(paneId, pending)
    const hosting = launch.cleanRoom ? Promise.resolve(false) : this.hostUndetectedAgent(paneId, launch, pending)
    if (launch.afterRetryInput) this.afterRetryInputs.set(paneId, launch.afterRetryInput)
    else this.afterRetryInputs.delete(paneId)
    this.scheduleRefresh(500)
    // No agent session to resume (an old chat): the fresh session starts from the chat so far.
    // Hermes resumes the whole conversation by Studio's session id, so it needs no recap.
    const needsRecap = !row.agent_native_session_id && launch.agentId !== 'hermes' && row.agent !== 'hermes' && !!this.deps.chatRecap
    if (launch.cleanRoom) {
      // The agent's own herdr hooks cannot reach herdr from inside its container.
      void this.followCleanRoom(paneId, launch, { sessionId, nativeId: row.agent_native_session_id || '', recap: needsRecap })
    } else if (needsRecap) {
      void Promise.all([this.deps.chatRecap!(sessionId), hosting]).then(([recap, hosted]) => {
        if (!recap) return false
        this.markRecap(sessionId, recap)
        // An agent herdr cannot detect reports no session or status: type once its terminal is up.
        return hosted ? new Promise(resolve => setTimeout(resolve, UNDETECTED_START_MS)).then(() => this.sendToPane(paneId, recap)).then(() => true) : this.promptWhenAgentStarted(paneId, recap)
      }).catch(error => this.log('warn', '[herdr] could not give the agent the chat so far', { sessionId, error: String(error) }))
    }
    return launch
  }

  /**
   * A clean-room agent runs inside its container, out of reach of herdr's own
   * agent hooks: herdr sees it by the docker client's name (see
   * `cleanRoomTerminalDocker`), Studio reports the session it resumes, and the
   * chat so far is typed once the agent is up (there is no session report to
   * wait for). A fresh session is found by its transcript in the room's home
   * folder, recorded as the chat's agent session and reported to herdr, so the
   * next resume continues it and a Studio restart finds the pane live.
   */
  async followCleanRoom(paneId: string, launch: HerdrInteractiveLaunch, chat: { sessionId: string; nativeId: string; recap: boolean }, options: { startMs?: number; sessionMs?: number } = {}): Promise<boolean> {
    const since = Date.now()
    try {
      const client = this.requireClient()
      const deadline = Date.now() + (options.startMs ?? 60000)
      let running = false
      while (!running && Date.now() < deadline && !this.stopped) {
        const info = await client.request<any>('pane.process_info', { pane_id: paneId }).catch(() => null)
        const processes: Array<{ argv?: string[] }> = info?.process_info?.foreground_processes || []
        running = processes.some(item => item.argv?.[0] === launch.command)
        if (!running) await new Promise(resolve => setTimeout(resolve, 500))
      }
      if (!running) {
        this.log('warn', '[herdr] clean-room agent did not start', { paneId })
        return false
      }
      const agent = this.deps.herdrKindFor(launch.agentId)
      const report = (agentSessionId: string) => agent
        // As the agent's own herdr integration would (herdr keeps sessions only from it).
        ? client.request('pane.report_agent_session', { pane_id: paneId, source: `herdr:${agent}`, agent, agent_session_id: agentSessionId })
          .catch(error => this.log('warn', '[herdr] could not report the clean-room session', { paneId, error: String(error) }))
        : Promise.resolve()
      if (chat.nativeId) await report(chat.nativeId)
      await this.refresh()
      if (chat.recap && this.deps.chatRecap) {
        const recap = await this.deps.chatRecap(chat.sessionId)
        if (recap) { this.markRecap(chat.sessionId, recap); await this.promptWhenReady(paneId, recap) }
      }
      if (chat.nativeId || !launch.agentHome) return true
      // A fresh session: its transcript appears once it has its first turn.
      const watchUntil = Date.now() + (options.sessionMs ?? 30 * 60 * 1000)
      while (Date.now() < watchUntil && !this.stopped && this.snapshot.panes.some(pane => pane.pane_id === paneId)) {
        const found = await newTranscriptSince(launch.agentId, launch.agentHome, since, configHomeEnv(launch.env))
        if (found && !this.deps.findSessionByNativeId(found.id)) {
          this.deps.updateNativeSessionId(chat.sessionId, found.id)
          await report(found.id)
          this.scheduleRefresh(0)
          return true
        }
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      return true
    } catch (error) {
      this.log('warn', '[herdr] could not follow the clean-room agent', { paneId, error: String(error) })
      return false
    }
  }


  /** Remember the recap so the transcript mirror leaves it (and its answer) out. */
  private markRecap(sessionId: string, text: string) {
    this.persisted.recaps = { ...(this.persisted.recaps || {}), [sessionId]: { text, at: Date.now() } }
    void this.savePersisted()
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

  /** Elevate a chat: it is in herdr from now on (until it returns to Studio, is closed there or goes away). */
  private async markElevated(sessionId: string): Promise<void> {
    this.returning.delete(sessionId)
    // A space of this chat that herdr no longer has (closed there): forget it, so the
    // chat gets a new space instead of counting as "closed in herdr" again.
    const stale = this.persisted.chatSpaces?.[sessionId]
    if (stale && !this.recentChatSpaces.has(stale.workspaceId) && !this.snapshot.workspaces.some(space => space.workspace_id === stale.workspaceId)) {
      delete this.persisted.chatSpaces![sessionId]
      await this.savePersisted()
    }
    if (this.persisted.elevatedChats?.[sessionId] != null) return
    this.persisted.elevatedChats = { ...(this.persisted.elevatedChats || {}), [sessionId]: Date.now() }
    await this.savePersisted()
    this.emit()
  }

  /** Elevate a chat and make its herdr space now (see markElevated). */
  async elevateChat(sessionId: string): Promise<ChatSpaceRecord | null> {
    await this.markElevated(sessionId)
    // Run the sync now (after one already running), not on the usual delay.
    while (this.chatSync) await this.chatSync.catch(() => undefined)
    await this.runChatSync()
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
      profile: herdrChatProfile(this.settings),
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
      const read = await readTranscriptFrom(path, entry.offset)
      const offset = read.offset
      let messages = read.messages
      if (offset === entry.offset) return
      entry.offset = offset
      const recap = this.persisted.recaps?.[sessionId]
      if (recap && Date.now() - recap.at > RECAP_MIRROR_WINDOW_MS) delete this.persisted.recaps![sessionId]
      else if (recap && messages.length) {
        const kept = withoutRecap(messages, recap)
        messages = kept.messages
        if (kept.marker) this.persisted.recaps![sessionId] = { ...recap, ...kept.marker }
        else delete this.persisted.recaps![sessionId]
      }
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
      // Older Studios' hand-opened chats (openedChats) are not elevated by themselves: separateOnce decides.
      this.persisted.elevatedChats = elevatedChatsFrom(raw)
      if (typeof raw?.separatedAt === 'number') this.persisted.separatedAt = raw.separatedAt
      if (raw?.recaps && typeof raw.recaps === 'object') this.persisted.recaps = raw.recaps
      if (raw?.hosted && typeof raw.hosted === 'object') this.persisted.hosted = raw.hosted
      this.persisted.closedChats = validClosedEntries(raw?.closedChats)
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
    if (this.persisted.elevatedChats) delete this.persisted.elevatedChats[sessionId]
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
    if (!launch.cleanRoom) void this.hostUndetectedAgent(paneId, launch, pending)
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
    // Opening a chat in herdr elevates it (a chat that does not exist is
    // dropped again by the next chat sync).
    await this.markElevated(sessionId)
    let existing = this.links.get(sessionId)
    // A resume that never got its agent going (it exited at once) leaves the chat's waiting pane
    // marked as resuming; once that pane shows the chat's card again, it is waiting again.
    const stubPaneId = this.persisted.chatSpaces?.[sessionId]?.stubPaneId
    if (existing && !existing.waiting && existing.paneId === stubPaneId && this.pending.has(stubPaneId)
      && !this.snapshot.panes.find(pane => pane.pane_id === stubPaneId)?.agent) {
      const client = this.requireClient()
      const pending = this.pending.get(stubPaneId)!
      this.pending.delete(stubPaneId) // stubBusy counts a pending resume as busy
      if (await this.stubRunning(client, stubPaneId) && !await this.stubBusy(client, stubPaneId)) existing = { ...existing, waiting: true }
      else this.pending.set(stubPaneId, pending)
    }
    // A live agent pane is focused; a waiting pane is resumed below (as Enter there does).
    if (existing && !existing.waiting) {
      await this.focusPane(existing.paneId)
      return existing
    }
    const row = this.deps.getSession(sessionId)
    if (!row) throw Object.assign(new Error('Chat not found'), { status: 404 })
    // The chat waits in its own herdr space: resume it there, as Enter in that pane does.
    // A chat just elevated gets its space first.
    let record = this.persisted.chatSpaces?.[sessionId]
    let ready = !!record?.stubPaneId && this.snapshot.panes.some(pane => pane.pane_id === record!.stubPaneId)
    if (!ready && this.deps.listChatSpaces) {
      await this.elevateChat(sessionId)
      record = this.persisted.chatSpaces?.[sessionId]
      ready = !!record?.stubPaneId
    }
    if (record?.stubPaneId && ready) {
      const client = this.requireClient()
      await this.focusPane(record.stubPaneId).catch(() => undefined)
      // Enter only while the pane shows the chat's card: once the agent is starting (or
      // Studio's chat client runs there), Enter would land in it as input.
      if (!await this.stubBusy(client, record.stubPaneId)) {
        await client.request('pane.send_keys', { pane_id: record.stubPaneId, keys: ['Enter'] })
      }
      const link: HerdrLinkInfo = { paneId: record.stubPaneId, workspaceId: record.workspaceId, status: existing?.status ?? 'unknown', ...(existing?.waiting ? { waiting: true } : {}) }
      this.links.set(sessionId, link)
      this.deps.setLink(sessionId, link)
      return link
    }
    await this.refreshAgentAccess(true, row.profile)
    const launch = await this.deps.prepareSessionLaunch(sessionId)
    const link = await this.openLaunch(launch, row.title || this.deps.agentLabel(launch.agentId), {
      sessionId,
      agentId: launch.agentId,
      provider: launch.provider,
      model: launch.model,
      title: row.title || '',
    })
    if (launch.cleanRoom) void this.followCleanRoom(link.paneId, launch, { sessionId, nativeId: row.agent_native_session_id || '', recap: false })
    return link
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
    const launch = await this.deps.prepareAgentLaunch(agentId, { provider: input.provider, model: input.model, workspace, profile: herdrChatProfile(this.settings) })
    const title = input.title?.trim() || this.deps.agentLabel(launch.agentId)
    // herdr reports no session for an agent it cannot detect, so its Studio chat is made now.
    let sessionId: string | undefined
    if (!herdrDetectsKind(this.deps.herdrKindFor(launch.agentId))) {
      sessionId = herdrChatId(`studio-${randomUUID()}`)
      this.deps.createSession({
        id: sessionId,
        agent: launch.agentId,
        nativeId: '',
        title,
        workspace: launch.workspaceDir || null,
        profile: herdrChatProfile(this.settings),
        provider: launch.provider,
        model: launch.model,
        categoryId: folder?.categoryId ?? null,
      })
      this.deps.notifyUpdated(sessionId)
    }
    const link = await this.openLaunch(launch, title, {
      ...(sessionId ? { sessionId } : {}),
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
  private async refreshAgentAccess(force: boolean, chatProfile?: string | null): Promise<void> {
    if (!this.deps.grantAgentAccess) return
    // A chat's agent acts in the chat's own profile; new agents in herdr's.
    const profile = chatProfile || herdrChatProfile(this.settings)
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

  /**
   * One herdr socket API call, for the per-space view (tabs, pane layout) that
   * Studio's Herdr App layout draws itself. A herdr change refreshes the state.
   */
  async call<T = any>(method: string, params: Record<string, unknown> = {}, options: { refresh?: boolean } = {}): Promise<T> {
    const result = await this.requireClient().request<T>(method, params)
    if (options.refresh) this.scheduleRefresh(0)
    return result
  }

  /** Send a chat message into the live pane instead of starting a second process. */
  async promptSession(sessionId: string, text: string): Promise<{ paneId: string }> {
    const link = this.links.get(sessionId)
    if (!link) throw Object.assign(new Error('Chat is not open in herdr'), { status: 409 })
    if (link.waiting) throw Object.assign(new Error('The chat\'s agent is not running in herdr'), { status: 409, code: 'agent_not_running' })
    const body = String(text || '')
    if (!body.trim()) throw Object.assign(new Error('Message is empty'), { status: 400 })
    const paneId = link.paneId
    // A new message ends the pane's previous Studio turn (its context no longer applies).
    this.endPaneTurn(paneId, 'interrupted')
    let turn: HerdrPaneTurn | null = null
    let current = true
    try {
      // Studio's chat client (Ekko, Hermes without its CLI) runs each line as a Studio run,
      // which carries Studio's context itself: nothing to add.
      if (!await this.paneRunsStudioClient(paneId)) turn = await this.deps.paneTurn?.(sessionId, paneId, () => current, body) ?? null
    } catch (error) {
      this.log('warn', '[herdr] could not prepare Studio\'s context for the pane turn', { sessionId, error: String(error) })
    }
    const ending = turn
    const entry = ending ? { sessionId, working: false, end: (state: 'ended' | 'interrupted' | 'failed') => { current = false; ending.end(state) } } as PaneTurnEntry : null
    if (entry) this.paneTurns.set(paneId, entry)
    try {
      await this.sendToPane(paneId, turn?.append ? `${body}\n\n${turn.append}` : body)
    } catch (error) {
      this.endPaneTurn(paneId, 'failed')
      throw error
    }
    if (entry && this.paneTurns.get(paneId) === entry) {
      // An agent that never starts working on it (the text did not land) ends the turn.
      entry.timer = setTimeout(() => { if (!entry.working) this.endPaneTurn(paneId, 'interrupted', entry) }, PANE_TURN_START_MS)
      entry.timer.unref?.()
    }
    return { paneId }
  }

  /** Whether the pane runs Studio's chat client (`studio-herdr.mjs chat`), whose lines are Studio runs. */
  private async paneRunsStudioClient(paneId: string): Promise<boolean> {
    const info = await this.requireClient().request<any>('pane.process_info', { pane_id: paneId }).catch(() => null)
    const processes: Array<{ argv?: string[] }> = info?.process_info?.foreground_processes || []
    return processes.some(item => {
      const argv = item.argv || []
      const script = argv.findIndex(arg => arg.endsWith('studio-herdr.mjs'))
      return script >= 0 && argv[script + 1] === 'chat'
    })
  }

  /** The pane's agent status for a turn Studio typed: working starts it, idle or done after that ends it. */
  private trackPaneTurn(paneId: string, status: HerdrAgentStatus) {
    const turn = this.paneTurns.get(paneId)
    if (!turn) return
    if (status === 'working' || status === 'blocked') turn.working = true
    else if (turn.working && (status === 'idle' || status === 'done')) this.endPaneTurn(paneId, 'ended')
  }

  private endPaneTurn(paneId: string, state: 'ended' | 'interrupted' | 'failed', only?: PaneTurnEntry) {
    const turn = this.paneTurns.get(paneId)
    if (!turn || (only && only !== turn)) return
    this.paneTurns.delete(paneId)
    if (turn.timer) clearTimeout(turn.timer)
    try { turn.end(state) } catch (error) { this.log('warn', '[herdr] could not end the pane turn', { paneId, error: String(error) }) }
  }

  /**
   * The pane's agent refused its launch and runs its retry launch: type what Studio prepared
   * for that (Hermes: `/model <route>`) once it takes input. Only text Studio prepared is typed.
   */
  async afterRetry(paneId: string): Promise<boolean> {
    const text = this.afterRetryInputs.get(paneId)
    if (!text) return false
    this.afterRetryInputs.delete(paneId)
    void this.sendToPane(paneId, text, 60000).catch(error => this.log('warn', '[herdr] could not switch the resumed agent\'s model', { paneId, error: String(error) }))
    return true
  }

  /** Types a message into an agent's pane; a Hermes pane gets it once its terminal UI takes input. */
  private async sendToPane(paneId: string, body: string, waitMs = 30000): Promise<void> {
    const send = async () => {
      try {
        await this.requireClient().request('agent.prompt', { target: paneId, text: body }, 15000)
      } catch (error) {
        if (error instanceof HerdrRequestError && error.code === 'agent_blocked') {
          throw Object.assign(new Error('The agent is waiting on an approval or question in herdr'), { status: 409, code: 'agent_blocked' })
        }
        throw error
      }
    }
    // A pane that just started may not be in the last snapshot yet: ask herdr.
    const agent = this.panes.find(entry => entry.pane_id === paneId)?.agent
      ?? await this.requireClient().request<any>('pane.get', { pane_id: paneId }, 5000).then(result => result?.pane?.agent).catch(() => undefined)
    let before = agent === 'hermes' ? await this.readPane(paneId) : null
    if (before !== null && before && !hermesInputReady(before)) {
      // herdr reports a resumed Hermes idle before its terminal UI is drawn; what is typed
      // then never reaches the conversation. Wait for its input line (at most waitMs).
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && !this.stopped && !hermesInputReady(before)) {
        await new Promise(resolve => setTimeout(resolve, 500))
        before = await this.readPane(paneId)
      }
    }
    if (before === '') before = null // no screen to check against (older herdr): send once, as before
    await send()
    // Hermes's terminal UI drops input in its first seconds, although herdr already reports it
    // idle: the text can sit in its input line without the Enter, or not arrive at all.
    if (before !== null) {
      let resent = false
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const state = await this.promptState(paneId, body, before)
        if (state === 'submitted') break
        if (state === 'typed') {
          this.log('warn', '[herdr] Hermes kept the message in its input; pressing Enter', { paneId: paneId })
          await this.requireClient().request('pane.send_keys', { pane_id: paneId, keys: ['Enter'] })
        } else if (!resent) {
          this.log('warn', '[herdr] Hermes did not take the message; sending it again', { paneId: paneId })
          resent = true
          await send()
        } else break
      }
    }
  }

  private async readPane(paneId: string): Promise<string> {
    try {
      const result = await this.requireClient().request<any>('pane.read', { pane_id: paneId, source: 'recent', lines: 120 }, 5000)
      return String(result?.text ?? result?.read?.text ?? '')
    } catch { return '' }
  }

  /**
   * Where a prompt sent to a pane ended up: submitted (the text shows past its input line),
   * typed (still in the input line), or missing.
   */
  private async promptState(paneId: string, text: string, before: string, timeoutMs = 4000): Promise<'submitted' | 'typed' | 'missing'> {
    const squash = (value: string) => value.replace(/\s+/g, '')
    const needle = squash(text).slice(0, 24)
    const count = (value: string) => squash(value).split(needle).length - 1
    const seenBefore = count(before)
    const deadline = Date.now() + timeoutMs
    let state: 'typed' | 'missing' = 'missing'
    while (Date.now() < deadline && !this.stopped) {
      await new Promise(resolve => setTimeout(resolve, 400))
      // (herdr's own status turns "working" as soon as it types, so only the screen tells.)
      const now = await this.readPane(paneId)
      if (!now) return 'submitted' // cannot tell: never risk sending twice
      if (!hermesInputReady(now)) continue
      if (count(now) <= seenBefore) { state = 'missing'; continue }
      // The input line is the last prompt line (Hermes draws it as "❯ ...").
      const inputLine = now.split(/\r?\n/).filter(line => /^\s*❯/.test(line)).pop() || ''
      if (!squash(inputLine).includes(needle) || count(now) > seenBefore + 1) return 'submitted'
      state = 'typed'
    }
    return state
  }

  /**
   * A run limit stopped the chat's run (docs/agent-limits.md): its pane shows
   * blocked in herdr until the person continues or stops, then idle again.
   */
  async reportChatLimit(sessionId: string, blocked: boolean): Promise<boolean> {
    const client = this.client
    const link = this.links.get(sessionId)
    if (!client || !link) return false
    const pane = this.snapshot.panes.find(item => item.pane_id === link.paneId)
    const agent = pane?.agent || 'hermes'
    try {
      await client.request('pane.report_agent', { pane_id: link.paneId, source: 'studio:chat', agent, state: blocked ? 'blocked' : 'idle' })
    } catch (error) {
      this.log('warn', '[herdr] could not report a run limit to herdr', { paneId: link.paneId, error: String(error) })
      return false
    }
    this.scheduleRefresh(0)
    return true
  }

  async closeSessionPane(sessionId: string): Promise<boolean> {
    const link = this.links.get(sessionId)
    if (!link) return false
    await this.requireClient().request('pane.close', { pane_id: link.paneId })
    this.scheduleRefresh(0)
    return true
  }
}
