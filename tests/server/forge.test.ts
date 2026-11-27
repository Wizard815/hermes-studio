import { describe, expect, it, vi } from 'vitest'
import { forgeConfig, forgeGitEnv, forgePr, onForge } from '../../packages/server/src/modules/studio/services/forge'
import { PrStatusReader, forgeChecks } from '../../packages/server/src/modules/studio/services/projects/pr-status'
import { failedForgeRuns, forgeInbox, GithubFeed } from '../../packages/server/src/modules/studio/services/command-center/github'
import { normalizeRepos, normalizeSettings } from '../../packages/server/src/modules/studio/services/command-center/settings'
import { forgeLine, threadPrompt } from '../../packages/server/src/modules/studio/services/projects/service'
import { normalizeProject } from '../../packages/server/src/modules/studio/services/projects/store'

const env = { FORGE_URL: 'http://192.168.20.5:3030/', FORGE_TOKEN: 'ftok', FORGE_HOSTS: 'forgejo:3000' }
const config = forgeConfig(env)!

const reply = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })

describe('TestForge_config', () => {
  it('reads FORGE_URL and FORGE_HOSTS, and is off without a URL', () => {
    expect(config.url).toBe('http://192.168.20.5:3030')
    expect([...config.hosts].sort()).toEqual(['192.168.20.5:3030', 'forgejo:3000'])
    expect(forgeConfig({})).toBeNull()
    expect(forgeConfig({ FORGE_URL: 'forgejo:3000' })).toBeNull()
  })

  it('knows the forge under each address, and nothing else', () => {
    expect(onForge('http://192.168.20.5:3030/w/r.git', config)).toBe(true)
    expect(onForge('http://forgejo:3000/w/r.git', config)).toBe(true)
    expect(onForge('ssh://git@192.168.20.5:2224/w/r.git', config)).toBe(true)
    expect(onForge('git@forgejo:w/r.git', config)).toBe(true)
    expect(onForge('http://192.168.20.5:8080/w/r.git', config)).toBe(false)
    expect(onForge('https://github.com/w/r.git', config)).toBe(false)
    expect(onForge('http://forgejo:3000/w/r.git', null)).toBe(false)
  })

  it('reads forge PR links', () => {
    expect(forgePr('http://192.168.20.5:3030/wizard/argos/pulls/12', config)).toEqual({ owner: 'wizard', repo: 'argos', number: 12 })
    expect(forgePr('http://forgejo:3000/wizard/argos/pulls/12/files', config)).toEqual({ owner: 'wizard', repo: 'argos', number: 12 })
    expect(forgePr('http://192.168.20.5:3030/wizard/argos/issues/12', config)).toBeNull()
    expect(forgePr('https://github.com/wizard/argos/pull/12', config)).toBeNull()
    const proxied = forgeConfig({ FORGE_URL: 'https://lab.example/git' })
    expect(forgePr('https://lab.example/git/w/r/pulls/3', proxied)).toEqual({ owner: 'w', repo: 'r', number: 3 })
  })

  it('sends the token to forge addresses only', () => {
    const git = forgeGitEnv(config)
    const keys = Object.entries(git).filter(([key]) => key.startsWith('GIT_CONFIG_KEY_')).map(([, value]) => value)
    expect(keys).toContain('http.http://forgejo:3000/.extraheader')
    expect(keys.some(key => key.includes('github.com'))).toBe(false)
    expect(git.GIT_CONFIG_VALUE_0).toBe('Authorization: token ftok')
    expect(forgeGitEnv({ ...config, token: '' })).toEqual({})
  })
})

describe('TestForge_prStatus', () => {
  it('reads a forge PR and its commit status with the forge token', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/repos/w/r/pulls/5')) return reply({ state: 'open', merged: false, mergeable: false, title: 'Feature', updated_at: 'u', head: { sha: 'abc' } })
      if (url.endsWith('/repos/w/r/pulls/6')) return reply({ state: 'closed', merged: true, title: 'Done', head: { sha: 'def' } })
      if (url.endsWith('/commits/abc/status')) return reply({ state: 'failure', total_count: 2 })
      if (url.endsWith('/commits/def/status')) return reply({ state: '', total_count: 0 })
      return reply({}, 404)
    })
    const reader = new PrStatusReader({ fetch, token: async () => 'gh', forge: config })
    const out = await reader.readAll(['http://192.168.20.5:3030/w/r/pulls/5', 'http://forgejo:3000/w/r/pulls/6', 'http://forgejo:3000/w/r/pulls/9'])
    expect(out['http://192.168.20.5:3030/w/r/pulls/5']).toEqual({ state: 'open', checks: 'failing', mergeable: 'dirty', title: 'Feature', updatedAt: 'u' })
    expect(out['http://forgejo:3000/w/r/pulls/6']).toMatchObject({ state: 'merged', checks: 'none' })
    expect(out['http://forgejo:3000/w/r/pulls/9']).toEqual({ error: expect.stringContaining('no such item') })
    expect(fetch.mock.calls[0]).toEqual(['http://192.168.20.5:3030/api/v1/repos/w/r/pulls/5', { headers: expect.objectContaining({ Authorization: 'token ftok' }) }])
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('api.github.com'))).toBe(true)
  })

  it('sums a combined status up', () => {
    expect(forgeChecks({ state: 'success', total_count: 3 })).toBe('passing')
    expect(forgeChecks({ state: 'pending', total_count: 1 })).toBe('pending')
    expect(forgeChecks({ state: 'error', total_count: 1 })).toBe('failing')
    expect(forgeChecks({ state: 'success', total_count: 0 })).toBe('none')
  })
})

describe('TestForge_inbox', () => {
  const forgeFetch = vi.fn(async (url: string) => {
    if (url.endsWith('/user')) return reply({ login: 'wizard' })
    if (url.includes('review_requested=true')) return reply([{ number: 3, title: 'Look', html_url: 'http://forge/w/r/pulls/3', updated_at: '2026-11-26T10:00:00Z', user: { login: 'hermes' }, repository: { full_name: 'w/r' } }])
    if (url.includes('created=true')) return reply([{ number: 4, title: 'Mine', html_url: 'http://forge/w/r/pulls/4', updated_at: '2026-11-26T11:00:00Z', repository: { full_name: 'w/r' } }])
    if (url.endsWith('/repos/w/r/pulls/4')) return reply({ head: { sha: 'zz' } })
    if (url.endsWith('/commits/zz/status')) return reply({ state: 'failure', total_count: 1 })
    if (url.includes('/repos/w/r/actions/tasks')) return reply({ workflow_runs: [
      { id: 2, workflow_id: 'ci.yml', head_branch: 'main', status: 'failure', display_title: 'Break', created_at: '2026-11-26T12:00:00Z', url: 'http://forge/w/r/actions/runs/2' },
      { id: 1, workflow_id: 'ci.yml', head_branch: 'main', status: 'success', created_at: '2026-11-26T09:00:00Z' },
      { id: 3, workflow_id: 'ci.yml', head_branch: 'dev', status: 'running', created_at: '2026-11-26T13:00:00Z' },
    ] })
    return reply({}, 404)
  })

  it('gets review requests, failing PRs and failed runs from the forge', async () => {
    const { login, items } = await forgeInbox(config, ['w/r'], forgeFetch)
    expect(login).toBe('wizard')
    expect(items.map(item => [item.kind, item.id, item.source])).toEqual([
      ['review', 'review:forge:w/r#3', 'forge'],
      ['ci', 'ci:forge-pr:w/r#4', 'forge'],
      ['ci', 'ci:forge-run:w/r:2', 'forge'],
    ])
  })

  it('keeps only runs whose latest finished run failed', () => {
    expect(failedForgeRuns('w/r', [{ id: 5, workflow_id: 'a', head_branch: 'm', status: 'success', created_at: '2026-11-27' }, { id: 4, workflow_id: 'a', head_branch: 'm', status: 'failure', created_at: '2026-11-26' }], 'http://forge')).toEqual([])
  })

  it('adds forge items to the GitHub inbox, even with gh missing', async () => {
    const missing = async () => ({ code: 127, stdout: '', stderr: '', missing: true })
    const feed = new GithubFeed(missing as any, () => 1, 60_000, () => config, forgeFetch)
    const inbox = await feed.inbox(normalizeSettings({ github: { enabled: true, repos: ['forge:w/r'] } }))
    expect(inbox.available).toBe(false)
    expect(inbox.forge).toEqual({ url: config.url, login: 'wizard' })
    expect(inbox.items.length).toBe(3)
    const noToken = new GithubFeed(missing as any, () => 1, 60_000, () => ({ ...config, token: '' }), forgeFetch)
    expect((await noToken.inbox(normalizeSettings({}))).forge?.error).toMatch(/FORGE_TOKEN/)
  })

  it('accepts forge:owner/repo and the forge URL in the watched repos', () => {
    const before = process.env.FORGE_URL
    process.env.FORGE_URL = 'http://192.168.20.5:3030'
    try {
      expect(normalizeRepos('forge:w/r, http://192.168.20.5:3030/w/s.git, o/p')).toEqual(['forge:w/r', 'forge:w/s', 'o/p'])
    } finally {
      if (before === undefined) delete process.env.FORGE_URL
      else process.env.FORGE_URL = before
    }
  })
})

describe('TestForge_projects', () => {
  it('keeps a project forge choice and tells threads where to push', () => {
    expect(normalizeProject({ id: 'p', name: 'P', forge: 'forge' })?.forge).toBe('forge')
    expect(normalizeProject({ id: 'p', name: 'P', forge: 'gitlab' })?.forge).toBe('')
    expect(normalizeProject({ id: 'p', name: 'P' })?.forge).toBe('')
    expect(forgeLine({ forge: '' })).toBe('')
    expect(forgeLine({ forge: 'github' })).toMatch(/GitHub/)
    const prompt = threadPrompt({ name: 'P', instructions: '', forge: 'forge' }, { title: 'T', brief: 'B' })
    expect(prompt).toMatch(/homelab's own Git forge/)
    expect(prompt).toMatch(/don't create or push to GitHub repos/)
  })
})
