import type { AgentDisplayStatus } from '../../../../../shared/session-state'
import type { Project, ProjectThread, ProjectThreadStatus } from '@/api/studio/projects'

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
