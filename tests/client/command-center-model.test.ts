import { describe, expect, it } from 'vitest'
import {
  BOARD_COLUMNS,
  buildBoard,
  buildInbox,
  collectAgents,
  contextMeter,
  folderName,
  formatAge,
  formatTokens,
  jobFailed,
  markSeen,
  readSeen,
  readSince,
  relativeIn,
  SEEN_STORAGE_KEY,
  trackSince,
  unseenCount,
  writeSeen,
  writeSince,
  type LiveAgent,
  type SessionStateView,
} from '@/mission/command-center/model'
import { canPreview, crumbs, formatSize, parentPath, sortEntries, tsvToCsv } from '@/mission/command-center/files'
import { COMMAND_TABS, DOCK_TABS, dockTabLabelKey, isCommandTab, nextDockTab } from '@/components/coding-agents/herdr/herdr-layout'
import type { AgentDisplayStatus } from '../../packages/shared/session-state'

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}
const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }

function states(map: Record<string, AgentDisplayStatus>, links: Record<string, { paneId: string; waiting?: boolean }> = {}): SessionStateView {
  return { statusOf: id => map[id] || 'idle', herdrLink: id => links[id], ids: () => Object.keys(map) }
}

const pane = (id: string, extra: Record<string, unknown> = {}) => ({
  pane_id: id, workspace_id: id.split(':')[0], studioAgent: null, studioSessionId: null, nativeSessionId: null, ...extra,
}) as any

describe('Command Center agents', () => {
  it('lists herdr agents (not shell panes) and Studio chats that are working, blocked or done', () => {
    const chats = new Map([['c1', { title: 'Fix login', agent: 'claude-code' }], ['c2', { title: 'Docs', agent: 'codex' }], ['c3', { title: 'Old', agent: 'hermes' }], ['c4', { title: 'Asleep' }]])
    const agents = collectAgents([
      pane('w1:p1', { agent: 'claude', studioAgent: 'claude-code', studioSessionId: 'c1', foreground_cwd: '/code/app' }),
      pane('w2:p1', { agent: 'pi', agent_status: 'working', label: 'scratch pi' }),
      pane('w3:p1', {}),
    ], chats, states({ c1: 'blocked', c2: 'done', c3: 'idle', c4: 'working' }, { c1: { paneId: 'w1:p1' } }))
    expect(agents.map(agent => [agent.key, agent.status, agent.live])).toEqual([
      ['chat:c1', 'blocked', true], ['chat:c4', 'working', false], ['pane:w2:p1', 'working', true], ['chat:c2', 'done', false],
    ])
    expect(agents[0]).toMatchObject({ title: 'Fix login', agent: 'claude-code', cwd: '/code/app', paneId: 'w1:p1' })
  })

  it('remembers when each agent entered its state, across reloads', () => {
    const one: LiveAgent = { key: 'chat:c1', title: 'a', agent: 'x', status: 'working', cwd: '', live: true }
    let since = trackSince({}, [one], 100)
    since = trackSince(since, [one], 200)
    expect(since['chat:c1']).toEqual({ status: 'working', since: 100 })
    since = trackSince(since, [{ ...one, status: 'done' }], 300)
    expect(since['chat:c1']).toEqual({ status: 'done', since: 300 })
    const store = memoryStore()
    writeSince(since, store)
    expect(readSince(store)).toEqual(since)
    expect(readSince(throwing)).toEqual({})
    expect(() => writeSince(since, throwing)).not.toThrow()
  })
})

describe('Command Center inbox', () => {
  const agents: LiveAgent[] = [
    { key: 'chat:c1', sessionId: 'c1', paneId: 'w1:p1', title: 'Fix login', agent: 'claude-code', status: 'blocked', cwd: '', live: true },
    { key: 'chat:c2', sessionId: 'c2', title: 'Docs', agent: 'codex', status: 'done', cwd: '', live: false },
    { key: 'chat:c3', sessionId: 'c3', title: 'Busy', agent: 'codex', status: 'working', cwd: '', live: true },
  ]
  const work = [
    { id: 'w1', title: 'Ship it', status: 'awaiting_approval', agent: 'codex', sessionId: 'c3', summary: 'ready', updatedAt: 500 },
    { id: 'w2', title: 'Queued', status: 'queued', agent: 'codex', sessionId: '', summary: '', updatedAt: 400 },
  ] as any
  const jobs = [
    { job_id: 'j1', name: 'Nightly', last_status: 'error', last_error: 'boom', last_run_at: '2026-11-20T10:00:00Z' },
    { job_id: 'j2', name: 'Fine', last_status: 'ok', last_error: null, last_run_at: '2026-11-20T10:00:00Z' },
  ] as any
  const github = { enabled: true, available: true, signedIn: true, repos: [], checkedAt: 0, items: [{ id: 'review:a/b#1', kind: 'review', repo: 'a/b', title: 'Look', url: 'u', number: 1, at: 50 }] } as any
  const since = { 'chat:c1': { status: 'blocked' as const, since: 300 }, 'chat:c2': { status: 'done' as const, since: 200 } }

  it('puts approvals and blocked agents first, then failures, reviews and done agents', () => {
    const items = buildInbox({ agents, since, work, jobs, github, seen: {} })
    expect(items.map(item => [item.kind, item.title])).toEqual([
      ['approval', 'Ship it'], ['blocked', 'Fix login'], ['job', 'Nightly'], ['review', 'Look'], ['done', 'Docs'],
    ])
    expect(items[1]).toMatchObject({ paneId: 'w1:p1', sessionId: 'c1', at: 300 })
    expect(items[0]).toMatchObject({ workId: 'w1', sessionId: 'c3' })
    expect(unseenCount(items)).toBe(5)
  })

  it('leaves GitHub out when it is off or signed out', () => {
    expect(buildInbox({ agents: [], since: {}, work: [], jobs: [], github: { ...github, signedIn: false }, seen: {} })).toEqual([])
    expect(buildInbox({ agents: [], since: {}, work: [], jobs: [], github: { ...github, enabled: false }, seen: {} })).toEqual([])
  })

  it('marks items seen until something newer happens', () => {
    const items = buildInbox({ agents, since, work, jobs, github, seen: {} })
    const seen = markSeen({}, items.filter(item => item.kind === 'done' || item.kind === 'blocked'))
    let next = buildInbox({ agents, since, work, jobs, github, seen })
    expect(unseenCount(next)).toBe(3)
    // The blocked agent got blocked again later: it is new again.
    next = buildInbox({ agents, since: { ...since, 'chat:c1': { status: 'blocked', since: 900 } }, work, jobs, github, seen })
    expect(next.find(item => item.kind === 'blocked')?.seen).toBe(false)
  })

  it('keeps seen marks in browser storage, and survives storage that throws', () => {
    const store = memoryStore()
    writeSeen({ a: 1, b: 2 }, store)
    expect(readSeen(store)).toEqual({ a: 1, b: 2 })
    expect(readSeen(memoryStore({ [SEEN_STORAGE_KEY]: '{bad' }))).toEqual({})
    expect(readSeen(memoryStore({ [SEEN_STORAGE_KEY]: '{"a":"x","b":3}' }))).toEqual({ b: 3 })
    expect(readSeen(throwing)).toEqual({})
    expect(() => writeSeen({ a: 1 }, throwing)).not.toThrow()
  })

  it('knows a failed job', () => {
    expect(jobFailed({ last_status: 'error', last_error: null })).toBe(true)
    expect(jobFailed({ last_status: 'ok', last_error: '' })).toBe(false)
    expect(jobFailed({ last_status: null, last_error: null })).toBe(false)
    expect(jobFailed({ last_status: 'ok', last_error: 'delivery failed' })).toBe(true)
  })
})

describe('Command Center board', () => {
  it('shows Agent work, open Orb tasks and live agents as columns without duplicates', () => {
    const agents: LiveAgent[] = [
      { key: 'chat:c3', sessionId: 'c3', paneId: 'w3:p1', title: 'Busy', agent: 'codex', status: 'working', cwd: '', live: true },
      { key: 'chat:c4', sessionId: 'c4', title: 'Stuck', agent: 'claude-code', status: 'blocked', cwd: '', live: true },
      { key: 'chat:c5', sessionId: 'c5', title: 'Idle', agent: 'pi', status: 'idle', cwd: '', live: true },
    ]
    const work = [
      { id: 'w1', title: 'Ship it', status: 'awaiting_approval', agent: 'codex', sessionId: 'c3', summary: '', updatedAt: 5 },
      { id: 'w2', title: 'Later', status: 'queued', agent: '', sessionId: '', summary: '', updatedAt: 4 },
      { id: 'w3', title: 'Nope', status: 'rejected', agent: '', sessionId: '', summary: '', updatedAt: 3 },
    ] as any
    const orbTasks = [
      { title: 'Write tests', list: 'work', due: '', done: false, priority: '' },
      { title: 'Deploy', list: 'work', due: '', done: false, inProgress: true, priority: '' },
      { title: 'Old', list: 'work', due: '', done: true, priority: '' },
    ] as any
    const board = buildBoard({ work, orbTasks, agents })
    const titles = Object.fromEntries(BOARD_COLUMNS.map(column => [column, board[column].map(card => card.title)]))
    expect(titles).toEqual({ queued: ['Later', 'Write tests'], working: ['Deploy'], blocked: ['Stuck'], approval: ['Ship it'], done: ['Nope'] })
    expect(board.approval[0]).toMatchObject({ live: 'working', paneId: 'w3:p1', workId: 'w1' })
    expect(board.done[0].detail).toBe('rejected')
  })
})

describe('Command Center helpers', () => {
  it('meters context and formats numbers and ages', () => {
    expect(contextMeter(53_500, 200_000)).toEqual({ percent: 26.8, level: 'ok' })
    expect(contextMeter(130_000, 200_000).level).toBe('warn')
    expect(contextMeter(190_000, 200_000).level).toBe('bad')
    expect(contextMeter(null, 200_000).percent).toBeNull()
    expect(contextMeter(10, 0).percent).toBeNull()
    expect([formatTokens(999), formatTokens(53_500), formatTokens(200_000), formatTokens(1_200_000)]).toEqual(['999', '53.5k', '200k', '1.2M'])
    expect([formatAge(0, 10), formatAge(1000, 30_000), formatAge(0 + 1, 5 * 60_000), formatAge(1, 3 * 3_600_000), formatAge(1, 2 * 86_400_000 + 5)]).toEqual(['', 'now', '4m', '2h', '2d'])
    expect(folderName('/code/app/')).toBe('app')
    expect(relativeIn('/code/app', '/code/app/src/lib')).toBe('src/lib')
    expect(relativeIn('/code/app', '/code/application')).toBe('')
    expect(relativeIn('/code/app', '/code/app')).toBe('')
  })

  it('lists files folders first, filters hidden ones and previews TSV as CSV', () => {
    const entries = [
      { name: 'b.md', path: 'b.md', isDir: false, size: 1, modTime: '' },
      { name: '.env', path: '.env', isDir: false, size: 1, modTime: '' },
      { name: 'src', path: 'src', isDir: true, size: 0, modTime: '' },
      { name: 'a.ts', path: 'a.ts', isDir: false, size: 1, modTime: '' },
    ]
    expect(sortEntries(entries).map(entry => entry.name)).toEqual(['src', 'a.ts', 'b.md'])
    expect(sortEntries(entries, { hidden: true, query: 'e' }).map(entry => entry.name)).toEqual(['.env'])
    expect(crumbs('src/lib', 'app')).toEqual([{ name: 'app', path: '' }, { name: 'src', path: 'src' }, { name: 'lib', path: 'src/lib' }])
    expect(parentPath('src/lib')).toBe('src')
    expect(tsvToCsv('a\tb,c\n1\t"2"')).toBe('a,"b,c"\n1,"""2"""')
    expect(['x.md', 'x.png', 'x.pdf', 'x.csv', 'x.tsv', 'x.json', 'x.ts'].every(canPreview)).toBe(true)
    expect(canPreview('x.bin')).toBe(false)
    expect([formatSize(12), formatSize(2048), formatSize(3 * 1024 * 1024)]).toEqual(['12 B', '2.0 KB', '3.0 MB'])
  })

  it('has Command Center tabs first, with arrow keys over all tabs', () => {
    expect(DOCK_TABS.slice(0, COMMAND_TABS.length)).toEqual(['inbox', 'agents', 'files', 'board', 'skills'])
    expect(isCommandTab('inbox')).toBe(true)
    expect(isCommandTab('chats')).toBe(false)
    expect(dockTabLabelKey('board')).toBe('commandCenter.tabs.board')
    expect(dockTabLabelKey('tasks')).toBe('mission.sources.tasks')
    expect(nextDockTab('skills', 'ArrowRight')).toBe('chats')
    expect(nextDockTab('inbox', 'ArrowLeft')).toBe('control')
    expect(nextDockTab('control', 'ArrowRight')).toBe('inbox')
    expect(nextDockTab('board', 'Home')).toBe('inbox')
    expect(nextDockTab('board', 'End')).toBe('control')
    expect(nextDockTab('board', 'a')).toBeNull()
  })
})
