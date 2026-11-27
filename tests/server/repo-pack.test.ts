import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  REPOMIX_VERSION, RepoPackError, githubGitEnv, listGithubRepos, normalizeRepo, packRepo, repomixArgs,
} from '../../packages/server/src/modules/studio/services/repo-pack'

describe('which repos can be packed', () => {
  it('accepts owner/name, github links with a tree ref, and other https git URLs', () => {
    expect(normalizeRepo('Wizard815/argos')).toMatchObject({ url: 'https://github.com/Wizard815/argos', label: 'Wizard815/argos' })
    expect(normalizeRepo('https://github.com/yamadashy/repomix.git')?.label).toBe('yamadashy/repomix')
    expect(normalizeRepo('https://github.com/a/b/tree/dev')?.github?.ref).toBe('dev')
    expect(normalizeRepo('https://gitlab.com/group/project')).toMatchObject({ label: 'group/project' })
  })

  it('refuses plain http, URLs with credentials, flags and dot-names', () => {
    for (const bad of ['http://github.com/a/b', 'https://me:pw@gitlab.com/a/b', '--help', '../etc', 'a/.git', 'file:///etc/passwd']) {
      expect(normalizeRepo(bad), bad).toBeNull()
    }
  })
})

describe('the repomix command', () => {
  it('is pinned, Markdown, compressed by default, and passes ref and include as separate arguments', () => {
    const args = repomixArgs({ repo: 'a/b', ref: 'v1.2', include: 'src/**,docs/**' }, 'https://github.com/a/b', '/tmp/out.md')
    expect(args.slice(0, 4)).toEqual(['-y', `repomix@${REPOMIX_VERSION}`, '--remote', 'https://github.com/a/b'])
    expect(args).toEqual(expect.arrayContaining(['--style', 'markdown', '--remote-branch', 'v1.2', '--include', 'src/**,docs/**', '--compress']))
    expect(repomixArgs({ repo: 'a/b', compress: false }, 'u', 'o')).not.toContain('--compress')
  })

  it('refuses refs and patterns that could act as options or shell', () => {
    expect(() => repomixArgs({ repo: 'a/b', ref: '--upload-pack=x' }, 'u', 'o')).toThrow(RepoPackError)
    expect(() => repomixArgs({ repo: 'a/b', include: 'src;rm -rf /' }, 'u', 'o')).toThrow(RepoPackError)
  })

  it('gives git the token in the environment only', () => {
    const env = githubGitEnv('ghp_secret')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.split(' ').pop()!, 'base64').toString()).toBe('x-access-token:ghp_secret')
    expect(githubGitEnv('')).toEqual({})
  })
})

describe('packing', () => {
  it('returns the packed Markdown with a file name, and never puts the token in argv', async () => {
    const runner = vi.fn(async (_cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
      expect(args.join(' ')).not.toContain('tok123')
      expect(env.GIT_CONFIG_VALUE_0).toContain('basic ')
      writeFileSync(args[args.indexOf('--output') + 1], '# Directory Structure\n')
      return { stdout: '', stderr: '' }
    })
    const result = await packRepo({ repo: 'https://github.com/a/b/tree/main' }, { token: async () => 'tok123', runner })
    expect(result).toMatchObject({ name: 'a_b@main.repomix.md', content: '# Directory Structure\n', repo: 'a/b' })
    expect(runner.mock.calls[0][0]).toBe('npx')
  })

  it('says to set GH_TOKEN when a repo cannot be read without one', async () => {
    const runner = vi.fn(async () => { throw Object.assign(new Error('x'), { stderr: 'remote: Repository not found.' }) })
    await expect(packRepo({ repo: 'a/private' }, { token: async () => '', runner })).rejects.toThrow(/set GH_TOKEN/)
  })

  it('says when npx is missing', async () => {
    const runner = vi.fn(async () => { throw Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }) })
    await expect(packRepo({ repo: 'a/b' }, { token: async () => '', runner })).rejects.toThrow(/Node.js \(npx\) is not installed/)
  })
})

describe('your GitHub repos', () => {
  it('is empty and not connected without a token', async () => {
    expect(await listGithubRepos({ token: async () => '' })).toEqual({ connected: false, repos: [] })
  })

  it('lists repos with the token', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([{ full_name: 'a/b', private: true, description: null, pushed_at: '2026-11-01', default_branch: 'main' }])))
    const result = await listGithubRepos({ token: async () => 't', fetcher: fetcher as any })
    expect(result).toEqual({ connected: true, repos: [{ fullName: 'a/b', private: true, description: '', pushedAt: '2026-11-01', defaultBranch: 'main' }] })
  })
})
