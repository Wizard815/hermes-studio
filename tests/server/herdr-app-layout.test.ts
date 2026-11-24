import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeLayout, normalizeTabs, processName, readSpaceView } from '../../packages/server/src/modules/coding-agents/services/herdr/space-view'
import { parseNumstat, parsePorcelain, readSpaceChanges, readSpaceDiff, safeRepoPath } from '../../packages/server/src/modules/coding-agents/services/herdr/space-changes'
import { paneStream } from '../../packages/server/src/modules/coding-agents/services/herdr/pane-stream'
import { createStatusClock } from '../../packages/server/src/modules/coding-agents/services/herdr/client-state'

/** What herdr 0.9.5 answers for a tab with one pane and a right/down split (captured from a real server). */
const LAYOUT = {
  layout: {
    area: { height: 40, width: 120, x: 0, y: 0 },
    focused_pane_id: 'w1:p3',
    panes: [
      { focused: false, pane_id: 'w1:p1', rect: { height: 40, width: 60, x: 0, y: 0 } },
      { focused: false, pane_id: 'w1:p2', rect: { height: 20, width: 60, x: 60, y: 0 } },
      { focused: true, pane_id: 'w1:p3', rect: { height: 20, width: 60, x: 60, y: 20 } },
    ],
    tab_id: 'w1:t1',
    workspace_id: 'w1',
    zoomed: false,
  },
  type: 'pane_layout',
}
const TABS = {
  tabs: [
    { agent_status: 'unknown', focused: true, label: '1', number: 1, pane_count: 3, tab_id: 'w1:t1', workspace_id: 'w1' },
    { agent_status: 'working', focused: false, label: '', number: 2, pane_count: 1, tab_id: 'w1:t2', workspace_id: 'w1' },
  ],
  type: 'tab_list',
}

describe('the Herdr App layout: a space\'s tabs and panes from herdr', () => {
  it('reads tabs in herdr\'s order, numbering unnamed ones', () => {
    expect(normalizeTabs(TABS).map(tab => [tab.tab_id, tab.label, tab.focused])).toEqual([['w1:t1', '1', true], ['w1:t2', '2', false]])
    expect(normalizeTabs({})).toEqual([])
  })

  it('turns herdr\'s pane rects into fractions of the tab, and a zoomed tab into its one pane', () => {
    const layout = normalizeLayout(LAYOUT)
    expect(layout.focusedPaneId).toBe('w1:p3')
    expect(layout.panes.map(pane => [pane.pane_id, pane.rect])).toEqual([
      ['w1:p1', { x: 0, y: 0, width: 0.5, height: 1 }],
      ['w1:p2', { x: 0.5, y: 0, width: 0.5, height: 0.5 }],
      ['w1:p3', { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }],
    ])
    const zoomed = normalizeLayout({ layout: { ...LAYOUT.layout, zoomed: true } })
    expect(zoomed.panes).toEqual([{ pane_id: 'w1:p3', focused: true, rect: { x: 0, y: 0, width: 1, height: 1 } }])
  })

  it('names the program in front ("bash") from pane.process_info', () => {
    expect(processName({ process_info: { foreground_processes: [{ name: 'bash', pid: 1 }] } })).toBe('bash')
    expect(processName(null)).toBe('')
  })

  it('asks herdr for the tabs, the active tab\'s layout and each pane\'s program', async () => {
    const calls: Array<[string, any]> = []
    const call = async (method: string, params: any = {}) => {
      calls.push([method, params])
      if (method === 'tab.list') return TABS
      if (method === 'pane.layout') return LAYOUT
      if (method === 'pane.process_info') return { process_info: { foreground_processes: [{ name: params.pane_id === 'w1:p3' ? 'codex' : 'bash' }] } }
      if (method === 'pane.list') return { panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }] }
      throw new Error(method)
    }
    const view = await readSpaceView(call as any, 'w1', () => '')
    expect(view.activeTabId).toBe('w1:t1')
    expect(view.panes.map(pane => pane.process)).toEqual(['bash', 'bash', 'codex'])
    // With no pane of the tab in Studio's state, it looks one up.
    expect(calls.slice(0, 3).map(([method]) => method)).toEqual(['tab.list', 'pane.list', 'pane.layout'])
    expect(calls[2][1]).toEqual({ pane_id: 'w1:p1' })
  })

  it('notes when each agent took its status, for the Agents list\'s time in state', () => {
    let now = 1000
    const clock = createStatusClock(() => now)
    const pane = (id: string, status: any) => ({ pane_id: id, workspace_id: 'w1', agent_status: status, studioAgent: null, studioSessionId: null, nativeSessionId: null })
    expect(clock([pane('a', 'idle'), pane('b', 'working')]).map(p => p.status_since)).toEqual([1000, 1000])
    now = 5000
    expect(clock([pane('a', 'idle'), pane('b', 'done')]).map(p => p.status_since)).toEqual([1000, 5000])
    now = 9000
    clock([pane('b', 'done')])
    expect(clock([pane('a', 'idle')])[0].status_since).toBe(9000)
  })
})

describe('the Herdr App layout: Changes', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'herdr-changes-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reads git\'s porcelain and numstat (renames, untracked)', () => {
    expect(parsePorcelain(' M a.ts\0R  new.ts\0old.ts\0?? notes.md\0D  gone.ts\0')).toEqual([
      { path: 'a.ts', status: 'M' }, { path: 'new.ts', status: 'R' }, { path: 'notes.md', status: '??' }, { path: 'gone.ts', status: 'D' },
    ])
    const counts = parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n2\t0\tsrc/{old => new}/x.ts\n')
    expect(counts.get('a.ts')).toEqual({ added: 3, removed: 1 })
    expect(counts.get('img.png')).toEqual({ added: 0, removed: 0 })
    expect(counts.get('src/new/x.ts')).toEqual({ added: 2, removed: 0 })
  })

  it('keeps diff paths inside the repo', () => {
    expect(safeRepoPath('src/a.ts')).toBe('src/a.ts')
    expect(safeRepoPath('../etc/passwd')).toBeNull()
    expect(safeRepoPath('/etc/passwd')).toBeNull()
    expect(safeRepoPath('a/../../b')).toBeNull()
  })

  it('lists a repo\'s uncommitted changes and shows a file\'s diff', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    git('init', '-q', '-b', 'main')
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
    git('add', '.')
    git('commit', '-qm', 'first')
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
    await writeFile(join(dir, 'new.txt'), 'hello\n')
    const changes = await readSpaceChanges(dir)
    expect(changes?.branch).toBe('main')
    expect(changes?.changes).toEqual([
      { path: 'a.txt', status: 'M', added: 2, removed: 1 },
      { path: 'new.txt', status: '??', added: 0, removed: 0 },
    ])
    expect((await readSpaceDiff(dir, 'a.txt'))?.diff).toContain('+TWO')
    expect((await readSpaceDiff(dir, 'new.txt'))?.diff).toContain('+hello')
    expect(await readSpaceDiff(dir, '../x')).toBeNull()
    expect(await readSpaceChanges(tmpdir())).toBeNull()
  })
})

describe('the Herdr App layout: one pane as a terminal', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'herdr-pane-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('runs `herdr terminal session control <pane>`, passes frames on and sends input, size and scroll', async () => {
    // A stand-in herdr: records its arguments and stdin, sends one frame.
    const fake = join(dir, 'herdr')
    const log = join(dir, 'log')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(JSON.stringify({ type: 'terminal.frame', seq: 1, encoding: 'ansi', width: 80, height: 24, full: true, bytes: Buffer.from('hi').toString('base64') }) + '\\n')
process.stdin.on('data', chunk => fs.appendFileSync(${JSON.stringify(log)}, chunk))
process.stdin.on('end', () => process.exit(0))
`)
    await chmod(fake, 0o755)
    const frames: string[] = []
    let closed = ''
    const stream = paneStream(fake, { session: 'work' }, 'control', 'w1:p2', 80, 24, true, bytes => frames.push(bytes), reason => { closed = reason })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(frames).toEqual([Buffer.from('hi').toString('base64')])
    stream.write('ls\r')
    stream.resize(100, 30)
    stream.scroll('up', 3)
    await new Promise(resolve => setTimeout(resolve, 300))
    stream.close()
    expect(closed).toBe('closed_by_client')
    const lines = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0]).toEqual(['--session', 'work', 'terminal', 'session', 'control', 'w1:p2', '--cols', '80', '--rows', '24', '--takeover'])
    expect(lines.slice(1, 4)).toEqual([
      { type: 'terminal.input', text: 'ls\r' },
      { type: 'terminal.resize', cols: 100, rows: 30 },
      { type: 'terminal.scroll', direction: 'up', lines: 3 },
    ])
  })
})
