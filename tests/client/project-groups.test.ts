import { describe, expect, it } from 'vitest'
import { groupThreads, projectOfSession, projectSummary, threadDisplayStatus } from '../../packages/client/src/components/hermes/chat/project-groups'
import type { Project, ProjectThread } from '../../packages/client/src/api/studio/projects'

const thread = (id: string, liveStatus: ProjectThread['liveStatus'], extra: Partial<ProjectThread> = {}): ProjectThread => ({
  id, title: id, agent: 'codex', brief: '', paneId: '', sessionId: `chat-${id}`, status: liveStatus, liveStatus, resolved: false, createdAt: 1, updatedAt: 1, ...extra,
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
