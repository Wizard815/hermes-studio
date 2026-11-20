import type { HerdrPaneView } from '@/api/coding-agents/herdr'
import type { AgentWork } from '@/api/studio/agent-work'
import type { Job } from '@/api/hermes/jobs'
import type { OrbTask } from '@/api/studio/orb'
import type { GithubInbox } from '@/api/studio/command-center'
import type { AgentDisplayStatus } from '../../../../shared/session-state'

/**
 * Command Center for the herdr page's Tools dock: the pure part (no Vue, no
 * requests). Ideas from Herdr App add-ons (digitaltracer's Command Center,
 * carstenlucke's Roundup); rebuilt for Studio's own data.
 */

/** One running or recent agent: a herdr pane, a Studio chat, or both. */
export interface LiveAgent {
  key: string
  paneId?: string
  sessionId?: string
  title: string
  agent: string
  status: AgentDisplayStatus
  cwd: string
  /** Running in a herdr pane now. */
  live: boolean
  /** The pane only waits for input (its agent is not running). */
  waiting?: boolean
}

export interface ChatInfo { title?: string | null; agent?: string; model?: string; source?: string }

export interface SessionStateView {
  statusOf: (id: string) => AgentDisplayStatus
  herdrLink: (id: string) => { paneId: string; waiting?: boolean } | undefined
  /** Chat ids the session-state stream knows. */
  ids: () => string[]
}

const STATUS_ORDER: Record<AgentDisplayStatus, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 }

/** Every agent herdr runs (shell panes left out) and Studio chats that are working, blocked or done. */
export function collectAgents(panes: HerdrPaneView[], chats: Map<string, ChatInfo>, states: SessionStateView): LiveAgent[] {
  const out = new Map<string, LiveAgent>()
  for (const pane of panes) {
    const sessionId = pane.studioSessionId || ''
    if (!sessionId && !pane.agent) continue
    const chat = sessionId ? chats.get(sessionId) : undefined
    const key = sessionId ? `chat:${sessionId}` : `pane:${pane.pane_id}`
    if (out.has(key)) continue
    out.set(key, {
      key,
      paneId: pane.pane_id,
      ...(sessionId ? { sessionId } : {}),
      title: chat?.title || pane.label || pane.terminal_title_stripped || pane.pane_id,
      agent: pane.studioAgent || pane.agent || chat?.agent || '',
      status: sessionId ? states.statusOf(sessionId) : (pane.agent_status || 'unknown'),
      cwd: pane.foreground_cwd || pane.cwd || '',
      live: true,
      ...(sessionId && states.herdrLink(sessionId)?.waiting ? { waiting: true } : {}),
    })
  }
  for (const id of states.ids()) {
    const key = `chat:${id}`
    if (out.has(key)) continue
    const status = states.statusOf(id)
    if (status !== 'working' && status !== 'blocked' && status !== 'done') continue
    const chat = chats.get(id)
    if (!chat) continue
    out.set(key, { key, sessionId: id, title: chat.title || id, agent: chat.agent || chat.source || '', status, cwd: '', live: false })
  }
  return [...out.values()].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.title.localeCompare(b.title))
}

export type SinceMap = Record<string, { status: AgentDisplayStatus; since: number }>

/** When each agent entered its current state (as this viewer saw it). */
export function trackSince(previous: SinceMap, agents: LiveAgent[], now: number): SinceMap {
  const next: SinceMap = {}
  for (const agent of agents) {
    const known = previous[agent.key]
    next[agent.key] = known && known.status === agent.status ? known : { status: agent.status, since: now }
  }
  return next
}

export const SINCE_STORAGE_KEY = 'studio_herdr_agent_since_v1'

/** The since-marks survive a reload, so an agent that stayed done keeps its time (and stays seen). */
export function readSince(store: StorageLike | null = storage()): SinceMap {
  try {
    const value = JSON.parse(store?.getItem(SINCE_STORAGE_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: SinceMap = {}
    for (const [key, entry] of Object.entries<any>(value)) {
      if (entry && typeof entry.status === 'string' && typeof entry.since === 'number') out[key] = { status: entry.status, since: entry.since }
    }
    return out
  } catch { return {} }
}

export function writeSince(since: SinceMap, store: StorageLike | null = storage()): void {
  try { store?.setItem(SINCE_STORAGE_KEY, JSON.stringify(since)) } catch { /* private mode */ }
}

export type InboxKind = 'approval' | 'blocked' | 'job' | 'ci' | 'review' | 'done'

export interface InboxItem {
  key: string
  kind: InboxKind
  title: string
  detail: string
  at: number
  seen: boolean
  agent?: string
  paneId?: string
  sessionId?: string
  workId?: string
  jobId?: string
  url?: string
}

const KIND_ORDER: Record<InboxKind, number> = { approval: 0, blocked: 1, job: 2, ci: 3, review: 4, done: 5 }

const OK_STATUS = /^(ok|success|succeeded|completed|done|skipped|running|scheduled)?$/i

export function jobFailed(job: Pick<Job, 'last_status' | 'last_error'>): boolean {
  return !OK_STATUS.test(String(job.last_status || '').trim()) || !!String(job.last_error || '').trim()
}

export interface InboxInput {
  agents: LiveAgent[]
  since: SinceMap
  work: AgentWork[]
  jobs: Job[]
  github: GithubInbox | null
  seen: Record<string, number>
}

/** What needs the user now (Command Center's inbox), most urgent first. */
export function buildInbox(input: InboxInput): InboxItem[] {
  const items: InboxItem[] = []
  const seen = (key: string, at: number) => Object.prototype.hasOwnProperty.call(input.seen, key) && input.seen[key] >= at
  const add = (item: Omit<InboxItem, 'seen'>) => items.push({ ...item, seen: seen(item.key, item.at) })
  for (const agent of input.agents) {
    if (agent.status !== 'blocked' && agent.status !== 'done') continue
    const at = input.since[agent.key]?.since || 0
    add({
      key: `${agent.status}:${agent.key}`,
      kind: agent.status,
      title: agent.title,
      detail: agent.agent,
      at,
      agent: agent.agent,
      ...(agent.paneId ? { paneId: agent.paneId } : {}),
      ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    })
  }
  for (const work of input.work) {
    if (work.status !== 'awaiting_approval' && work.status !== 'blocked') continue
    add({
      key: `${work.status === 'blocked' ? 'work-blocked' : 'approval'}:${work.id}`,
      kind: work.status === 'blocked' ? 'blocked' : 'approval',
      title: work.title,
      detail: work.summary || work.agent,
      at: work.updatedAt,
      agent: work.agent,
      workId: work.id,
      ...(work.sessionId ? { sessionId: work.sessionId } : {}),
    })
  }
  for (const job of input.jobs) {
    if (!jobFailed(job)) continue
    const at = Date.parse(job.last_run_at || '') || 0
    add({ key: `job:${job.job_id || job.id}`, kind: 'job', title: job.name || job.job_id, detail: job.last_error || job.last_status || '', at, jobId: job.job_id || job.id })
  }
  if (input.github?.enabled && input.github.signedIn) {
    for (const item of input.github.items) {
      add({ key: `gh:${item.id}`, kind: item.kind, title: item.title, detail: [item.repo + (item.number ? `#${item.number}` : ''), item.detail].filter(Boolean).join(' · '), at: item.at, url: item.url })
    }
  }
  return items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.at - a.at)
}

export function unseenCount(items: InboxItem[]): number {
  return items.filter(item => !item.seen).length
}

export const SEEN_STORAGE_KEY = 'studio_herdr_inbox_seen_v1'
const MAX_SEEN = 400

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function storage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** This viewer's "seen" marks (key → time of the event they saw). */
export function readSeen(store: StorageLike | null = storage()): Record<string, number> {
  try {
    const value = JSON.parse(store?.getItem(SEEN_STORAGE_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === 'number' && Number.isFinite(at))) as Record<string, number>
  } catch { return {} }
}

export function writeSeen(seen: Record<string, number>, store: StorageLike | null = storage()): void {
  const entries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN)
  try { store?.setItem(SEEN_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries))) } catch { /* private mode */ }
}

export function markSeen(seen: Record<string, number>, items: Array<Pick<InboxItem, 'key' | 'at'>>): Record<string, number> {
  const next = { ...seen }
  for (const item of items) next[item.key] = Math.max(next[item.key] || 0, item.at || 0)
  return next
}

export type BoardColumn = 'queued' | 'working' | 'blocked' | 'approval' | 'done'
export const BOARD_COLUMNS: BoardColumn[] = ['queued', 'working', 'blocked', 'approval', 'done']

export interface BoardCard {
  key: string
  column: BoardColumn
  source: 'work' | 'orb' | 'agent'
  title: string
  detail: string
  at: number
  agent?: string
  paneId?: string
  sessionId?: string
  workId?: string
  /** A live agent's status on a work card it is doing. */
  live?: AgentDisplayStatus
}

const WORK_COLUMN: Record<AgentWork['status'], BoardColumn> = {
  queued: 'queued', working: 'working', blocked: 'blocked', awaiting_approval: 'approval', done: 'done', rejected: 'done',
}

/** All work as columns (Command Center's board): Agent work, Orb tasks and live agents, without duplicates. */
export function buildBoard(input: { work: AgentWork[]; orbTasks: OrbTask[]; agents: LiveAgent[]; since?: SinceMap; doneLimit?: number }): Record<BoardColumn, BoardCard[]> {
  const columns: Record<BoardColumn, BoardCard[]> = { queued: [], working: [], blocked: [], approval: [], done: [] }
  const bySession = new Map(input.agents.filter(agent => agent.sessionId).map(agent => [agent.sessionId!, agent]))
  const claimed = new Set<string>()
  for (const work of input.work) {
    const agent = work.sessionId ? bySession.get(work.sessionId) : undefined
    if (agent) claimed.add(agent.key)
    columns[WORK_COLUMN[work.status] || 'queued'].push({
      key: `work:${work.id}`,
      column: WORK_COLUMN[work.status] || 'queued',
      source: 'work',
      title: work.title,
      detail: work.status === 'rejected' ? 'rejected' : work.summary || '',
      at: work.updatedAt,
      agent: work.agent,
      workId: work.id,
      ...(work.sessionId ? { sessionId: work.sessionId } : {}),
      ...(agent?.paneId ? { paneId: agent.paneId } : {}),
      ...(agent ? { live: agent.status } : {}),
    })
  }
  for (const task of input.orbTasks) {
    if (task.done) continue
    const column: BoardColumn = task.agentStatus === 'blocked' ? 'blocked' : task.agentStatus === 'working' || task.inProgress ? 'working' : task.agentStatus === 'done' ? 'done' : 'queued'
    columns[column].push({ key: `orb:${task.list}:${task.title}`, column, source: 'orb', title: task.title, detail: [task.list, task.due].filter(Boolean).join(' · '), at: Date.parse(task.due || '') || 0 })
  }
  for (const agent of input.agents) {
    if (claimed.has(agent.key)) continue
    const column: BoardColumn | null = agent.status === 'working' ? 'working' : agent.status === 'blocked' ? 'blocked' : agent.status === 'done' ? 'done' : null
    if (!column) continue
    columns[column].push({
      key: `agent:${agent.key}`, column, source: 'agent', title: agent.title, detail: '', at: input.since?.[agent.key]?.since || 0,
      agent: agent.agent, ...(agent.paneId ? { paneId: agent.paneId } : {}), ...(agent.sessionId ? { sessionId: agent.sessionId } : {}), live: agent.status,
    })
  }
  for (const column of BOARD_COLUMNS) columns[column].sort((a, b) => b.at - a.at)
  columns.done = columns.done.slice(0, input.doneLimit ?? 12)
  return columns
}

export interface Meter { percent: number | null; level: 'ok' | 'warn' | 'bad' }

/** Context meter: tokens used of the context window. */
export function contextMeter(tokens: number | null | undefined, window: number | null | undefined): Meter {
  if (tokens == null || !window || window <= 0) return { percent: null, level: 'ok' }
  const percent = Math.max(0, Math.min(100, Math.round((tokens / window) * 1000) / 10))
  return { percent, level: percent >= 85 ? 'bad' : percent >= 60 ? 'warn' : 'ok' }
}

export function formatTokens(value: number | null | undefined): string {
  const n = Number(value || 0)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

/** "now", "5m", "3h", "2d". */
export function formatAge(at: number, now: number): string {
  if (!at) return ''
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function folderName(path: string): string {
  const clean = String(path || '').replace(/\/+$/, '')
  return clean.split('/').pop() || clean || ''
}

/** A pane's folder inside a chat's workspace, as a path the workspace file API takes ('' when outside). */
export function relativeIn(root: string | undefined, cwd: string): string {
  const base = String(root || '').replace(/\/+$/, '')
  const dir = String(cwd || '').replace(/\/+$/, '')
  if (!base || !dir || dir === base) return ''
  return dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : ''
}
