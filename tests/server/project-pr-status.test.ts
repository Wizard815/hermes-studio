import { describe, expect, it, vi } from 'vitest'
import { PrStatusReader, githubPr, summarizeChecks } from '../../packages/server/src/modules/studio/services/projects/pr-status'

describe('TestProjects_prStatus', () => {
  it('reads github.com pull request links only', () => {
    expect(githubPr('https://github.com/Wizard815/hermes-studio/pull/2')).toEqual({ owner: 'Wizard815', repo: 'hermes-studio', number: 2 })
    expect(githubPr('https://github.com/o/r/pull/7/files')).toEqual({ owner: 'o', repo: 'r', number: 7 })
    expect(githubPr('https://gitlab.com/o/r/-/merge_requests/3')).toBeNull()
    expect(githubPr('https://github.com/o/r/issues/3')).toBeNull()
  })

  it('sums check runs up: a failure fails, anything running is pending', () => {
    expect(summarizeChecks([])).toBe('none')
    expect(summarizeChecks([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }])).toBe('passing')
    expect(summarizeChecks([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }])).toBe('pending')
    expect(summarizeChecks([{ status: 'in_progress' }, { status: 'completed', conclusion: 'failure' }])).toBe('failing')
  })

  it('fetches state and checks with the token, caches a minute, and explains failures', async () => {
    let now = 1_000
    const calls: Array<[string, any]> = []
    const fetch = vi.fn(async (url: string, init?: any) => {
      calls.push([url, init?.headers])
      if (url.endsWith('/pulls/2')) return { ok: true, status: 200, json: async () => ({ state: 'open', draft: false, merged_at: null, mergeable_state: 'dirty', title: 'Projects', updated_at: 'x', head: { sha: 'abc' } }) }
      if (url.endsWith('/pulls/3')) return { ok: true, status: 200, json: async () => ({ state: 'closed', merged_at: '2026-11-26', head: { sha: 'def' } }) }
      if (url.includes('/commits/abc/')) return { ok: true, status: 200, json: async () => ({ check_runs: [{ status: 'completed', conclusion: 'failure' }] }) }
      if (url.includes('/commits/def/')) return { ok: true, status: 200, json: async () => ({ check_runs: [] }) }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    const reader = new PrStatusReader({ fetch, token: async () => 'tok', now: () => now })
    const statuses = await reader.readAll(['https://github.com/o/r/pull/2', 'https://github.com/o/r/pull/3', 'https://github.com/o/r/pull/9', 'https://gitlab.com/o/r/-/merge_requests/1', 'https://github.com/o/r/pull/2'])
    expect(statuses['https://github.com/o/r/pull/2']).toEqual({ state: 'open', checks: 'failing', mergeable: 'dirty', title: 'Projects', updatedAt: 'x' })
    expect(statuses['https://github.com/o/r/pull/3']).toMatchObject({ state: 'merged', checks: 'none' })
    expect(statuses['https://github.com/o/r/pull/9']).toEqual({ error: expect.stringContaining('no such pull request') })
    expect(statuses['https://gitlab.com/o/r/-/merge_requests/1']).toEqual({ error: expect.stringContaining('Only github.com') })
    expect(calls[0]).toEqual(['https://api.github.com/repos/o/r/pulls/2', expect.objectContaining({ Authorization: 'Bearer tok' })])
    const count = fetch.mock.calls.length
    await reader.read('https://github.com/o/r/pull/2')
    expect(fetch.mock.calls.length).toBe(count)
    now += 61_000
    await reader.read('https://github.com/o/r/pull/2')
    expect(fetch.mock.calls.length).toBe(count + 2)
  })
})
