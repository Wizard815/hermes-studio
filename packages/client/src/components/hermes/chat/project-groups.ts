import type { AgentDisplayStatus } from '../../../../../shared/session-state'
import type { Project, ProjectTask, ProjectThread, ProjectThreadStatus } from '@/api/studio/projects'

/** The thread groups of a project in the chat list, in the order they show. */
export type ThreadGroupKey = 'needsYou' | 'working' | 'done' | 'resolved'
export const THREAD_GROUPS: ThreadGroupKey[] = ['needsYou', 'working', 'done', 'resolved']

/** Agents a thread can run in herdr; the server checks the agent is installed. */
export const THREAD_AGENTS = ['claude-code', 'codex', 'hermes', 'opencode', 'pi', 'grok', 'cursor', 'copilot'] as const

export function threadGroup(thread: Pick<ProjectThread, 'resolved' | 'liveStatus'>): ThreadGroupKey {
  if (thread.resolved) return 'resolved'
  if (thread.liveStatus === 'blocked') return 'needsYou'
  if (thread.liveStatus === 'working' || thread.liveStatus === 'starting' || thread.liveStatus === 'unknown') return 'working'
  return 'done'
}

/** Threads by group, newest first in each. */
export function groupThreads(threads: ProjectThread[]): Record<ThreadGroupKey, ProjectThread[]> {
  const groups: Record<ThreadGroupKey, ProjectThread[]> = { needsYou: [], working: [], done: [], resolved: [] }
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) groups[threadGroup(thread)].push(thread)
  return groups
}

/** The chat list's status glyph for a thread (herdr's ◐ × ✓ ○ ·). */
export function threadDisplayStatus(status: ProjectThreadStatus): AgentDisplayStatus {
  if (status === 'starting') return 'working'
  if (status === 'gone') return 'idle'
  return status
}

/** The project a chat is in, as coordinator or thread. */
export function projectOfSession(projects: Project[], sessionId: string): { project: Project; role: 'coordinator' | 'thread' } | null {
  if (!sessionId) return null
  for (const project of projects) {
    if (project.coordinatorSessionId === sessionId) return { project, role: 'coordinator' }
    if (project.threads.some(thread => thread.sessionId === sessionId)) return { project, role: 'thread' }
  }
  return null
}

/** The badge words a collapsed project shows: what needs the person first. */
export function projectSummary(project: Pick<Project, 'counts'>): Array<{ key: 'needsYou' | 'working' | 'done'; count: number }> {
  return (['needsYou', 'working', 'done'] as const)
    .map(key => ({ key, count: project.counts[key] }))
    .filter(item => item.count > 0)
}

/** The project board's columns, left to right (docs/projects.md#board). */
export type BoardColumn = 'todo' | 'doing' | 'needsYou' | 'review' | 'done'
export const BOARD_COLUMNS: BoardColumn[] = ['todo', 'doing', 'needsYou', 'review', 'done']

export type BoardCard =
  | { kind: 'thread'; id: string; title: string; pr: string; column: BoardColumn; thread: ProjectThread; updatedAt: number }
  | { kind: 'task'; id: string; title: string; pr: string; column: BoardColumn; task: ProjectTask; updatedAt: number }

/** A thread's column comes from its status: working, needs you, finished (review) or resolved (done). */
export function threadColumn(thread: Pick<ProjectThread, 'resolved' | 'liveStatus'>): BoardColumn {
  const group = threadGroup(thread)
  return group === 'resolved' ? 'done' : group === 'needsYou' ? 'needsYou' : group === 'working' ? 'doing' : 'review'
}

/** Cards by column: threads, plus tasks that have no thread (a task started as a thread shows as that thread). */
export function boardCards(project: Pick<Project, 'threads' | 'tasks'>): Record<BoardColumn, BoardCard[]> {
  const columns: Record<BoardColumn, BoardCard[]> = { todo: [], doing: [], needsYou: [], review: [], done: [] }
  const threadIds = new Set(project.threads.map(thread => thread.id))
  const cards: BoardCard[] = [
    ...project.threads.map(thread => ({ kind: 'thread' as const, id: thread.id, title: thread.title, pr: thread.pr || '', column: threadColumn(thread), thread, updatedAt: thread.updatedAt })),
    ...(project.tasks || []).filter(task => !threadIds.has(task.threadId)).map(task => ({ kind: 'task' as const, id: task.id, title: task.title, pr: task.pr, column: task.column as BoardColumn, task, updatedAt: task.updatedAt })),
  ]
  for (const card of cards.sort((a, b) => b.updatedAt - a.updatedAt)) columns[card.column].push(card)
  return columns
}

/** Where a card may be moved: tasks to any column but Needs you; threads only in or out of Done (resolving). */
export function boardTargets(card: BoardCard): BoardColumn[] {
  if (card.kind === 'task') return BOARD_COLUMNS.filter(column => column !== 'needsYou')
  return card.column === 'done' ? [threadColumn({ ...card.thread, resolved: false })] : ['done']
}
