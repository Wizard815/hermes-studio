import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CommitSummaryStore,
  ProjectCommitReader,
  branchCommits,
  cleanSummary,
  parseLog,
  summaryModel,
} from '../../packages/server/src/modules/studio/services/projects/commits'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()

let dir = ''
let repo = ''
let mine: string[] = []
let other = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-commits-'))
  repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Start')
  git(repo, 'checkout', '-qb', 'studio/board-t1')
  writeFileSync(join(repo, 'board.txt'), 'commits\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Board lists commits')
  writeFileSync(join(repo, 'board.txt'), 'commits and summaries\n')
  git(repo, 'commit', '-qam', 'Hover shows a summary')
  mine = git(repo, 'log', '--format=%H', '-n2').split('\n')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'checkout', '-qb', 'studio/other-t2')
  writeFileSync(join(repo, 'other.txt'), 'x\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Other thread work')
  other = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  // The thread pushed its first commit: origin's copy of its own branch must not hide it.
  git(repo, 'update-ref', 'refs/remotes/origin/studio/board-t1', mine[1])
})

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const project = () => ({
  id: 'p1', name: 'P', folder: repo, repo: '', instructions: '', coordinatorSessionId: '', categoryId: '', profile: '', defaultAgent: 'claude-code', defaultModel: '', worktrees: true, wakeCoordinator: true, forge: '',
  threads: [
    { id: 't1', title: 'Board', agent: 'claude-code', model: '', provider: '', brief: '', paneId: '', sessionId: '', workspace: repo, branch: 'studio/board-t1', status: 'working', resolved: false, pr: '', createdAt: 0, updatedAt: 0 },
    { id: 't3', title: 'No branch', agent: 'hermes', model: '', provider: '', brief: '', paneId: '', sessionId: '', workspace: repo, branch: '', status: 'idle', resolved: false, pr: 'https://github.com/o/r/pull/7', createdAt: 0, updatedAt: 0 },
  ],
  tasks: [], memory: [], artifacts: [], createdAt: 0, updatedAt: 0,
}) as any

function modelFetch(reply = '<think>hmm</think>Board show commits. Hover one, get caveman summary.') {
  return vi.fn(async (url: string, init?: any) => {
    if (url === 'http://argos:8080/v1/chat/completions') {
      const sent = JSON.parse(init.body)
      expect(sent.model).toBe('studio-caveman')
      expect(init.headers.Authorization).toBe('Bearer k')
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }], details: sent.messages[1].content }) }
    }
    if (url.endsWith('/pulls/7/commits?per_page=100')) {
      return { ok: true, status: 200, json: async () => [
        { sha: 'a'.repeat(40), html_url: 'https://github.com/o/r/commit/aaa', commit: { message: 'First on PR\n\nbody', author: { name: 'Ann', date: '2026-11-27T10:00:00Z' } } },
        { sha: 'b'.repeat(40), commit: { message: 'Second on PR', author: { name: 'Bo', date: '2026-11-27T11:00:00Z' } } },
      ] }
    }
    if (url.endsWith(`/commits/${'b'.repeat(40)}`)) {
      return { ok: true, status: 200, json: async () => ({ commit: { message: 'Second on PR' }, files: [{ filename: 'x.ts', additions: 3, deletions: 1, patch: '+x' }] }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  })
}

const model = () => ({ url: 'http://argos:8080/v1', model: 'studio-caveman', apiKey: 'k' })

describe('TestProjects_commits', () => {
  it('lists only the commits on the thread branch, newest first', async () => {
    const result = await branchCommits(repo, 'studio/board-t1')
    expect(result.commits.map(item => item.sha)).toEqual(mine)
    expect(result.commits.map(item => item.subject)).toEqual(['Hover shows a summary', 'Board lists commits'])
    expect(result.commits.map(item => item.sha)).not.toContain(other)
    expect(result.more).toBe(false)
    expect((await branchCommits(repo, 'studio/board-t1', 1)).more).toBe(true)
    await expect(branchCommits(repo, '--all')).rejects.toThrow('Not a branch name')
  })

  it('parses log records and cleans model replies to one short line', () => {
    expect(parseLog(`${'c'.repeat(40)}\x1fccccccc\x1fSubject\x1fAnn\x1f2026-11-27T10:00:00Z\x1e\nnot a sha\x1e`)).toHaveLength(1)
    expect(cleanSummary('<think>long thoughts</think>\n"**Summary:** Fix login.\nToken check use <=."')).toBe('Fix login. Token check use <=.')
    expect(cleanSummary('<think>never closed')).toBe('')
    expect(cleanSummary('word '.repeat(100)).length).toBeLessThanOrEqual(281)
  })

  it('takes the model from ARGOS_URL, with its own override and default name', () => {
    expect(summaryModel({})).toBeNull()
    expect(summaryModel({ ARGOS_URL: 'http://argos:8080/v1/', ARGOS_API_KEY: 'k' })).toEqual({ url: 'http://argos:8080/v1', model: 'studio-caveman', apiKey: 'k' })
    expect(summaryModel({ ARGOS_URL: 'http://argos:8080/v1', STUDIO_COMMIT_SUMMARY_URL: 'http://other/v1', STUDIO_COMMIT_SUMMARY_MODEL: 'tiny' })).toMatchObject({ url: 'http://other/v1', model: 'tiny' })
    expect(summaryModel({ ARGOS_URL: 'file:///etc' })).toBeNull()
  })

  it('summarizes a branch commit once, saves it per SHA and refuses commits off the branch', async () => {
    const file = join(dir, 'summaries.json')
    const fetch = modelFetch()
    const reader = new ProjectCommitReader({ summaries: new CommitSummaryStore(file), fetch, model, token: async () => '' })
    const [first, second] = await Promise.all([
      reader.summary(project(), mine[0], { thread: 't1' }),
      reader.summary(project(), mine[0], { thread: 't1' }),
    ])
    expect(first).toBe('Board show commits. Hover one, get caveman summary.')
    expect(second).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)
    const asked = JSON.parse(fetch.mock.calls[0][1].body).messages[1].content
    expect(asked).toContain('Hover shows a summary')
    expect(asked).toContain('board.txt')

    // A new reader (Studio restarted) reads it from the file, without the model.
    const later = new ProjectCommitReader({ summaries: new CommitSummaryStore(file), fetch: vi.fn(), model })
    expect(await later.summary(project(), mine[0], { thread: 't1' })).toBe(first)
    expect(JSON.parse(readFileSync(file, 'utf8')).summaries[mine[0]].summary).toBe(first)
    const listed = await later.list(project())
    expect('commits' in listed.threads.t1 && listed.threads.t1.commits[0].summary).toBe(first)

    await expect(reader.summary(project(), other, { thread: 't1' })).rejects.toMatchObject({ status: 404 })
    await expect(reader.summary(project(), 'not-a-sha', { thread: 't1' })).rejects.toMatchObject({ status: 400 })
    await expect(reader.summary(project(), mine[1], {})).rejects.toMatchObject({ status: 400 })
  })

  it('says how to set the model up when there is none, and does not retry a failure at once', async () => {
    const none = new ProjectCommitReader({ summaries: new CommitSummaryStore(join(dir, 'none.json')), model: () => null })
    await expect(none.summary(project(), mine[1], { thread: 't1' })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('ARGOS_URL') })

    let now = 1_000
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const reader = new ProjectCommitReader({ summaries: new CommitSummaryStore(join(dir, 'down.json')), fetch: down as any, model, now: () => now })
    await expect(reader.summary(project(), mine[1], { thread: 't1' })).rejects.toThrow("Argos isn't answering")
    await expect(reader.summary(project(), mine[1], { thread: 't1' })).rejects.toMatchObject({ status: 502 })
    expect(down).toHaveBeenCalledTimes(1)
    now += 6 * 60_000
    await expect(reader.summary(project(), mine[1], { thread: 't1' })).rejects.toThrow("Argos isn't answering")
    expect(down).toHaveBeenCalledTimes(2)
  })

  it('lists a board PR\'s commits from GitHub and summarizes them from the commit\'s files', async () => {
    const fetch = modelFetch('Second thing done.')
    const reader = new ProjectCommitReader({ summaries: new CommitSummaryStore(join(dir, 'pr.json')), fetch, model, token: async () => 'tok', forge: null })
    const listed = await reader.list(project())
    expect(Object.keys(listed.threads)).toEqual(['t1'])
    const pr = listed.prs['https://github.com/o/r/pull/7']
    expect('commits' in pr && pr.commits.map(item => [item.short, item.subject, item.url])).toEqual([
      ['bbbbbbb', 'Second on PR', `https://github.com/o/r/commit/${'b'.repeat(40)}`],
      ['aaaaaaa', 'First on PR', 'https://github.com/o/r/commit/aaa'],
    ])
    expect(await reader.summary(project(), 'b'.repeat(40), { pr: 'https://github.com/o/r/pull/7' })).toBe('Second thing done.')
    const asked = JSON.parse(fetch.mock.calls.find(call => String(call[0]).includes('chat/completions'))![1].body).messages[1].content
    expect(asked).toContain('x.ts | +3 -1')
    await expect(reader.summary(project(), 'c'.repeat(40), { pr: 'https://github.com/o/r/pull/7' })).rejects.toMatchObject({ status: 404 })
    await expect(reader.summary(project(), 'a'.repeat(40), { pr: 'https://github.com/o/r/pull/8' })).rejects.toMatchObject({ status: 404 })
  })
})
