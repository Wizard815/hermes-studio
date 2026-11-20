import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliOptions, CliResult } from '../../packages/server/src/modules/studio/services/command-center/cli'
import { failure, lastLine } from '../../packages/server/src/modules/studio/services/command-center/cli'
import { GithubFeed, failedRuns, parseGraphql } from '../../packages/server/src/modules/studio/services/command-center/github'
import { CommandCenterSettingsFile, normalizeRepos, normalizeSettings } from '../../packages/server/src/modules/studio/services/command-center/settings'
import { Skillshare, buildOverview, installOutcome, updateOutcome } from '../../packages/server/src/modules/studio/services/command-center/skillshare'
import { codexPlanLimits, parseRolloutLimits } from '../../packages/server/src/modules/studio/services/command-center/codex-limits'
import { contextFromUsage, gitBranch } from '../../packages/server/src/modules/studio/services/command-center/agents'
import { confirmed } from '../../packages/server/src/modules/studio/controllers/command-center'

type Call = { bin: string; args: string[]; options?: CliOptions }

/** A fake program runner: answers by the joined argument list's prefix. */
function fakeRunner(answers: Array<[string, Partial<CliResult>]>) {
  const calls: Call[] = []
  const run = async (bin: string, args: string[], options?: CliOptions): Promise<CliResult> => {
    calls.push({ bin, args, options })
    const line = [bin, ...args].join(' ')
    const hit = answers.find(([prefix]) => line.startsWith(prefix))
    return { code: 0, stdout: '', stderr: '', ...(hit ? hit[1] : { code: 1, stderr: `unexpected: ${line}` }) }
  }
  return { run, calls }
}

const temps: string[] = []
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-test-'))
  temps.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('command center settings', () => {
  it('keeps owner/repo names only, deduplicated', () => {
    expect(normalizeRepos('a/b, https://github.com/c/d.git  a/b bad x/y/z')).toEqual(['a/b', 'c/d'])
    expect(normalizeSettings({})).toEqual({ github: { enabled: true, repos: [] } })
    expect(normalizeSettings({ github: { enabled: false, repos: ['o/r'] } })).toEqual({ github: { enabled: false, repos: ['o/r'] } })
  })

  it('saves partial changes in Studio’s own home', async () => {
    const path = join(await temp(), 'command-center', 'settings.json')
    const file = new CommandCenterSettingsFile(path)
    expect(await file.load()).toEqual({ github: { enabled: true, repos: [] } })
    await file.save({ github: { repos: 'me/app' } })
    expect(await file.save({ github: { enabled: false } })).toEqual({ github: { enabled: false, repos: ['me/app'] } })
    expect(JSON.parse(await readFile(path, 'utf8')).github.repos).toEqual(['me/app'])
  })
})

describe('GitHub inbox through gh', () => {
  const graph = {
    data: {
      viewer: {
        login: 'me',
        pullRequests: { nodes: [
          { number: 4, title: 'Red', url: 'https://github.com/me/app/pull/4', updatedAt: '2026-11-20T10:00:00Z', repository: { nameWithOwner: 'me/app' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } },
          { number: 5, title: 'Green', url: 'https://github.com/me/app/pull/5', updatedAt: '2026-11-20T11:00:00Z', repository: { nameWithOwner: 'me/app' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } },
          { number: 6, title: 'Other repo', url: 'https://github.com/me/lib/pull/6', updatedAt: '2026-11-20T09:00:00Z', repository: { nameWithOwner: 'me/lib' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] } },
        ] },
      },
      reviews: { nodes: [{ number: 9, title: 'Please look', url: 'https://github.com/team/svc/pull/9', updatedAt: '2026-11-19T08:00:00Z', author: { login: 'robin' }, repository: { nameWithOwner: 'team/svc' } }] },
    },
  }

  it('lists failed checks on own pull requests and review requests', () => {
    const { login, items } = parseGraphql(graph)
    expect(login).toBe('me')
    expect(items.map(item => [item.kind, item.repo, item.number])).toEqual([['ci', 'me/app', 4], ['ci', 'me/lib', 6], ['review', 'team/svc', 9]])
    expect(items[2].detail).toBe('from robin')
    expect(parseGraphql(graph, ['me/app']).items.map(item => item.number)).toEqual([4])
  })

  it('reports a workflow only while its latest run on a branch failed', () => {
    const runs = [
      { databaseId: 3, workflowName: 'CI', headBranch: 'main', status: 'completed', conclusion: 'success', createdAt: '2026-11-20T12:00:00Z' },
      { databaseId: 2, workflowName: 'CI', headBranch: 'main', status: 'completed', conclusion: 'failure', createdAt: '2026-11-20T11:00:00Z' },
      { databaseId: 1, workflowName: 'Release', headBranch: 'main', status: 'completed', conclusion: 'failure', displayTitle: 'v1', url: 'u', createdAt: '2026-11-20T10:00:00Z' },
      { databaseId: 4, workflowName: 'Release', headBranch: 'dev', status: 'in_progress', conclusion: '', createdAt: '2026-11-20T13:00:00Z' },
    ]
    expect(failedRuns('me/app', runs).map(item => item.id)).toEqual(['ci:run:me/app:1'])
  })

  it('is off when gh is missing, and says why when it is signed out', async () => {
    const missing = fakeRunner([['gh auth', { code: 127, missing: true }]])
    expect(await new GithubFeed(missing.run).inbox(normalizeSettings({}))).toMatchObject({ available: false, signedIn: false, items: [] })
    const out = fakeRunner([['gh auth', { code: 1, stderr: 'You are not logged into any GitHub hosts.' }]])
    expect(await new GithubFeed(out.run).inbox(normalizeSettings({}))).toMatchObject({ available: true, signedIn: false, error: 'You are not logged into any GitHub hosts.' })
  })

  it('asks GitHub only when enabled, adds watched repos’ failed runs, and caches for a minute', async () => {
    let now = 1_000_000
    const fake = fakeRunner([
      ['gh auth', { code: 0 }],
      ['gh api graphql', { stdout: JSON.stringify(graph) }],
      ['gh run list -R me/app', { stdout: JSON.stringify([{ databaseId: 7, workflowName: 'CI', headBranch: 'main', status: 'completed', conclusion: 'failure', createdAt: '2026-11-20T13:00:00Z' }]) }],
    ])
    const feed = new GithubFeed(fake.run, () => now)
    const off = await feed.inbox(normalizeSettings({ github: { enabled: false } }))
    expect(off).toMatchObject({ enabled: false, signedIn: true, items: [] })
    expect(fake.calls.some(call => call.args[0] === 'api')).toBe(false)

    const settings = normalizeSettings({ github: { repos: ['me/app'] } })
    const inbox = await feed.inbox(settings)
    expect(inbox.items.map(item => item.id)).toEqual(['ci:run:me/app:7', 'ci:pr:me/app#4'])
    expect(fake.calls.every(call => Array.isArray(call.args))).toBe(true)
    const count = fake.calls.length
    now += 30_000
    await feed.inbox(settings)
    expect(fake.calls.length).toBe(count)
    await feed.inbox(settings, { refresh: true })
    expect(fake.calls.length).toBeGreaterThan(count)
  })
})

describe('skillshare', () => {
  const raw = {
    status: { version: '0.20.1', source: { path: '/home/me/.config/skillshare/skills' }, targets: [{ name: 'claude', path: '/home/me/.claude/skills' }, { name: 'codex', path: '/home/me/.codex/skills' }] },
    list: [
      { name: 'code-review', kind: 'skill', relPath: 'code-review' },
      { name: 'tdd', kind: 'skill', relPath: 'tdd', source: 'https://github.com/acme/skills.git' },
      { name: 'old', kind: 'skill', relPath: 'old', disabled: true },
      { name: 'reviewer.md', kind: 'agent', relPath: 'reviewer.md' },
    ],
    diff: { targets: [
      { name: 'claude', items: [{ action: 'add', name: 'code-review', kind: 'skill', reason: 'source only', is_sync: true }, { action: 'modify', name: 'reviewer.md', kind: 'agent', is_sync: true }] },
      { name: 'codex', items: [{ action: 'add', name: 'code-review', kind: 'skill', is_sync: true }, { action: 'keep', name: 'x', is_sync: false }] },
    ] },
    mcp: { changes: [{ name: 'files', target: 'claude', action: 'add' }] },
    plugins: { packages: { lint: { source: 'acme/lint', bindings: { claude: { sync: true } } } } },
    extras: [{ name: 'rules', file: 'AGENTS.md', targets: [{ path: '/home/me/.claude', status: 'synced' }] }],
    check: { skills: [{ name: 'tdd', status: 'update_available', source: 'github.com/acme/skills' }], tracked_repos: [] },
  }

  it('builds the overview: what waits per target, kinds and the library', () => {
    const overview = buildOverview(raw, 42)
    expect(overview.version).toBe('0.20.1')
    expect(overview.targets).toEqual([{ name: 'claude', path: '/home/me/.claude/skills', waiting: 2 }, { name: 'codex', path: '/home/me/.codex/skills', waiting: 1 }])
    expect(Object.fromEntries(overview.items.map(item => [item.key, item.state]))).toEqual({
      'skills:code-review': 'missing', 'skills:tdd': 'update', 'skills:old': 'off', 'agents:reviewer': 'sync',
      'mcp:files': 'sync', 'plugins:lint': 'ok', 'extras:rules': 'ok',
    })
    expect(overview.items.find(item => item.key === 'skills:code-review')?.targets).toEqual(['claude', 'codex'])
    expect(overview.kinds.find(kind => kind.kind === 'skills')).toEqual({ kind: 'skills', total: 3, needsSync: 1, updates: 1 })
    expect(overview.checked).toBe(true)
  })

  it('has an empty state when the CLI is not installed', async () => {
    const fake = fakeRunner([['skillshare status', { code: 127, missing: true }]])
    expect(await new Skillshare(fake.run).overview()).toMatchObject({ installed: false, items: [] })
  })

  it('reads every inventory as JSON in global scope and keeps update checks', async () => {
    const fake = fakeRunner([
      ['skillshare status', { stdout: JSON.stringify(raw.status) }],
      ['skillshare list', { stdout: JSON.stringify(raw.list) }],
      ['skillshare diff', { stdout: JSON.stringify(raw.diff) }],
      ['skillshare mcp', { stdout: JSON.stringify(raw.mcp) }],
      ['skillshare plugin', { stdout: JSON.stringify(raw.plugins) }],
      ['skillshare extras', { stdout: JSON.stringify(raw.extras) }],
      ['skillshare check agents', { stdout: '[]' }],
      ['skillshare check', { stdout: JSON.stringify(raw.check) }],
    ])
    const cli = new Skillshare(fake.run)
    expect((await cli.overview()).checked).toBe(false)
    const checked = await cli.checkUpdates()
    expect(checked.checked).toBe(true)
    expect(checked.items.find(item => item.name === 'tdd')?.state).toBe('update')
    expect(fake.calls.every(call => call.args.includes('--json') && call.args.includes('-g'))).toBe(true)
  })

  it('runs sync, update and install as argument arrays and reports the audit', async () => {
    const fake = fakeRunner([
      ['skillshare sync', { code: 0, stdout: '{}' }],
      ['skillshare update agents reviewer', { code: 0, stdout: JSON.stringify({ agents: [{ name: 'reviewer', status: 'updated' }] }) }],
      ['skillshare update tdd', { code: 1, stdout: JSON.stringify({ items: [{ name: 'tdd', status: 'security_blocked' }] }) }],
      ['skillshare install acme/skills', { code: 0, stdout: JSON.stringify({ skills: ['tdd'] }) }],
    ])
    const cli = new Skillshare(fake.run)
    expect(await cli.sync()).toEqual({ ok: true, message: 'Synced every target' })
    expect(await cli.update({ kind: 'agents', name: 'reviewer' })).toEqual({ ok: true, message: 'Updated 1. Targets get it on the next sync.' })
    expect((await cli.update({ name: 'tdd' })).message).toMatch(/audit blocked tdd/)
    expect((await cli.install('acme/skills')).ok).toBe(true)
    expect(await cli.install('--upload-pack=evil x')).toEqual({ ok: false, message: 'Give a GitHub owner/repo or a git URL' })
    expect((await cli.update({ name: '-rf' })).ok).toBe(false)
    expect(fake.calls.map(call => call.args.join(' '))).toEqual([
      'sync --all --json -g', 'update agents reviewer --json -g', 'update tdd --json -g', 'install acme/skills --json -g',
    ])
  })

  it('reads install and update results like the panel does', () => {
    expect(installOutcome({ code: 1, stdout: '', stderr: 'boom' }).message).toMatch(/boom.*exited with 1/)
    expect(installOutcome({ code: 0, stdout: JSON.stringify({ skills: [], failed: ['bad'] }), stderr: '' }).ok).toBe(false)
    expect(updateOutcome({ code: 0, stdout: JSON.stringify({ updated: 0 }), stderr: '' }).message).toBe('Already up to date')
  })
})

describe('agent details', () => {
  it('counts cached input in a coding agent’s context', () => {
    const latest = { input_tokens: 1000, cache_read_tokens: 50000, cache_write_tokens: 2000, output_tokens: 500 }
    expect(contextFromUsage(latest, true)).toBe(53500)
    expect(contextFromUsage(latest, false)).toBe(1500)
    expect(contextFromUsage(undefined, true)).toBeNull()
  })

  it('reads a folder’s branch with git -C, never a shell', async () => {
    const fake = fakeRunner([['git -C /code/app symbolic-ref', { stdout: 'feature/x\n' }]])
    expect(await gitBranch('/code/app', fake.run)).toBe('feature/x')
    const detached = fakeRunner([['git -C /code/app symbolic-ref', { code: 1 }], ['git -C /code/app rev-parse', { stdout: 'abc1234\n' }]])
    expect(await gitBranch('/code/app', detached.run)).toBe('@abc1234')
    expect(await gitBranch('relative/path', fake.run)).toBe('')
  })
})

describe('Codex plan limits', () => {
  const line = (at: string, primary: number, secondary: number) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: primary, window_minutes: 300, resets_at: 1_800_000_000 }, secondary: { used_percent: secondary, window_minutes: 10080, resets_in_seconds: 60 } } } })

  it('takes the last rate-limit report in a rollout', () => {
    const text = [line('2026-11-20T10:00:00Z', 10, 3), '{"type":"other"}', line('2026-11-20T11:00:00Z', 42, 12.5), ''].join('\n')
    const limits = parseRolloutLimits(text)!
    expect(limits.primary).toEqual({ usedPercent: 42, windowMinutes: 300, resetsAt: 1_800_000_000_000 })
    expect(limits.secondary?.usedPercent).toBe(12.5)
    expect(limits.secondary?.resetsAt).toBe(Date.parse('2026-11-20T11:00:00Z') + 60_000)
    expect(parseRolloutLimits('nothing here')).toBeNull()
  })

  it('finds the newest rollout across Codex homes', async () => {
    const root = await temp()
    const older = join(root, 'a', 'sessions', '2026', '11', '19')
    const newer = join(root, 'b', 'sessions', '2026', '11', '20')
    await mkdir(older, { recursive: true })
    await mkdir(newer, { recursive: true })
    await writeFile(join(older, 'rollout-1.jsonl'), `${line('2026-11-19T10:00:00Z', 5, 1)}\n`)
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(join(newer, 'rollout-2.jsonl'), `${line('2026-11-20T10:00:00Z', 77, 30)}\n`)
    expect((await codexPlanLimits([join(root, 'a'), join(root, 'b'), join(root, 'none')]))?.primary?.usedPercent).toBe(77)
    expect(await codexPlanLimits([join(root, 'none')])).toBeNull()
  })
})

describe('command center CLI helpers and routes', () => {
  it('reads errors from JSON or the last output line', () => {
    expect(failure({ code: 1, stdout: '{"error":"no config"}', stderr: '' }, 'x')).toBe('no config')
    expect(failure({ code: 2, stdout: '', stderr: '' }, 'skillshare sync')).toBe('skillshare sync exited with 2')
    expect(lastLine('\x1b[31mfirst\x1b[0m\nlast\n\n')).toBe('last')
  })

  it('refuses writes that were not confirmed', () => {
    const ctx: any = { request: { body: {} }, status: 200, body: null }
    expect(confirmed(ctx)).toBe(false)
    expect(ctx.status).toBe(400)
    expect(confirmed({ request: { body: { confirm: true } } } as any)).toBe(true)
  })
})
