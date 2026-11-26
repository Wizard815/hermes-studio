import { describe, expect, it } from 'vitest'
import { boardCards, boardTargets, groupThreads, projectOfSession, projectSummary, threadDisplayStatus } from '../../packages/client/src/components/hermes/chat/project-groups'
import type { Project, ProjectTask, ProjectThread } from '../../packages/client/src/api/studio/projects'

const thread = (id: string, liveStatus: ProjectThread['liveStatus'], extra: Partial<ProjectThread> = {}): ProjectThread => ({
  id, title: id, agent: 'codex', brief: '', paneId: '', sessionId: `chat-${id}`, status: liveStatus, liveStatus, resolved: false, pr: '', workspace: '', branch: '', createdAt: 1, updatedAt: 1, ...extra,
})

describe('TestProjects_groups', () => {
  it('threads waiting on the person come first, resolved ones last, newest first in each', () => {
    const groups = groupThreads([
      thread('a', 'working', { updatedAt: 1 }), thread('b', 'blocked'), thread('c', 'done'), thread('d', 'starting', { updatedAt: 5 }),
      thread('e', 'gone'), thread('f', 'working', { resolved: true }),
    ])
    expect(groups.needsYou.map(item => item.id)).toEqual(['b'])
    expect(groups.working.map(item => item.id)).toEqual(['d', 'a'])
    expect(groups.done.map(item => item.id)).toEqual(['c', 'e'])
    expect(groups.resolved.map(item => item.id)).toEqual(['f'])
  })

  it('shows herdr\'s glyph states, summarizes a project and finds a chat\'s project', () => {
    expect(threadDisplayStatus('starting')).toBe('working')
    expect(threadDisplayStatus('gone')).toBe('idle')
    const project = { id: 'p', coordinatorSessionId: 'coord', threads: [thread('a', 'blocked')], counts: { needsYou: 1, working: 0, done: 2, resolved: 0 } } as unknown as Project
    expect(projectSummary(project)).toEqual([{ key: 'needsYou', count: 1 }, { key: 'done', count: 2 }])
    expect(projectOfSession([project], 'coord')?.role).toBe('coordinator')
    expect(projectOfSession([project], 'chat-a')?.role).toBe('thread')
    expect(projectOfSession([project], 'x')).toBeNull()
  })
})

describe('TestProjects_board', () => {
  const task = (id: string, column: ProjectTask['column'], extra: Partial<ProjectTask> = {}): ProjectTask => ({ id, title: id, notes: '', column, pr: '', threadId: '', createdAt: 1, updatedAt: 1, ...extra })

  it('threads go by status, tasks by column, and a started task shows only as its thread', () => {
    const cards = boardCards({
      threads: [thread('w', 'working'), thread('b', 'blocked'), thread('d', 'idle', { pr: 'https://x/pull/1' }), thread('r', 'done', { resolved: true })],
      tasks: [task('k1', 'todo'), task('k2', 'review'), task('k3', 'doing', { threadId: 'w' }), task('k4', 'doing', { threadId: 'gone-thread' })],
    })
    const ids = Object.fromEntries(Object.entries(cards).map(([column, list]) => [column, list.map(card => card.id)]))
    expect(ids).toEqual({ todo: ['k1'], doing: ['w', 'k4'], needsYou: ['b'], review: ['d', 'k2'], done: ['r'] })
    expect(cards.review[0].pr).toBe('https://x/pull/1')
  })

  it('tasks move anywhere but Needs you; threads only in or out of Done', () => {
    const cards = boardCards({ threads: [thread('b', 'blocked'), thread('r', 'done', { resolved: true })], tasks: [task('k1', 'todo')] })
    expect(boardTargets(cards.todo[0])).toEqual(['todo', 'doing', 'review', 'done'])
    expect(boardTargets(cards.needsYou[0])).toEqual(['done'])
    expect(boardTargets(cards.done[0])).toEqual(['review'])
  })
})
