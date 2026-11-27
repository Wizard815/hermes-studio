import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  REPOMIX_VERSION, RepoPackError, githubGitEnv, listForgeRepos, listGithubRepos, normalizeRepo, packRepo, repomixArgs,
} from '../../packages/server/src/modules/studio/services/repo-pack'
import { forgeOrigin } from '../../packages/server/src/modules/studio/services/repo-pack/forge'

const FORGE = { url: 'http://192.168.20.5:3030', token: 'forge-secret', hosts: ['forgejo:3000'] }
const noForge = async () => null

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
    const result = await packRepo({ repo: 'https://github.com/a/b/tree/main' }, { token: async () => 'tok123', runner, forge: noForge })
    expect(result).toMatchObject({ name: 'a_b@main.repomix.md', content: '# Directory Structure\n', repo: 'a/b' })
    expect(runner.mock.calls[0][0]).toBe('npx')
  })

  it('says to set GH_TOKEN when a repo cannot be read without one', async () => {
    const runner = vi.fn(async () => { throw Object.assign(new Error('x'), { stderr: 'remote: Repository not found.' }) })
    await expect(packRepo({ repo: 'a/private' }, { token: async () => '', runner, forge: noForge })).rejects.toThrow(/set GH_TOKEN/)
  })

  it('says when npx is missing', async () => {
    const runner = vi.fn(async () => { throw Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }) })
    await expect(packRepo({ repo: 'a/b' }, { token: async () => '', runner, forge: noForge })).rejects.toThrow(/Node.js \(npx\) is not installed/)
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

describe('the family forge (Forgejo)', () => {
  it('knows forge URLs by address or FORGE_HOSTS, and never takes github.com for it', () => {
    expect(forgeOrigin(new URL('http://192.168.20.5:3030/fam/app'), FORGE)).toBe('http://192.168.20.5:3030')
    expect(forgeOrigin(new URL('http://forgejo:3000/fam/app'), FORGE)).toBe('http://forgejo:3000')
    expect(forgeOrigin(new URL('http://192.168.20.5:9999/fam/app'), FORGE)).toBeNull()
    expect(forgeOrigin(new URL('https://github.com/fam/app'), { ...FORGE, hosts: ['github.com'] })).toBeNull()
  })

  it('accepts plain http only for the forge, and turns a branch link into repo + ref', () => {
    expect(normalizeRepo('http://192.168.20.5:3030/fam/app/src/branch/dev', FORGE)).toMatchObject({ url: 'http://192.168.20.5:3030/fam/app.git', label: 'fam/app', forge: 'http://192.168.20.5:3030', forgeRef: 'dev' })
    expect(normalizeRepo('http://192.168.20.5:3030/fam/app', null)).toBeNull()
    expect(normalizeRepo('http://other.lan/fam/app', FORGE)).toBeNull()
  })

  it('sends FORGE_TOKEN only to the forge, as a git header, and masks it in errors', async () => {
    const seen: NodeJS.ProcessEnv[] = []
    const runner = vi.fn(async (_cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
      seen.push(env)
      expect(args.join(' ')).not.toContain('forge-secret')
      throw Object.assign(new Error('x'), { stderr: 'fatal: Authorization: token forge-secret rejected, repository not found' })
    })
    await expect(packRepo({ repo: 'http://forgejo:3000/fam/app' }, { forge: async () => FORGE, token: async () => 'gh-tok', runner })).rejects.toThrow(/could not read fam\/app/)
    expect(seen[0].GIT_CONFIG_KEY_0).toBe('http.http://forgejo:3000/.extraheader')
    expect(seen[0].GIT_CONFIG_VALUE_0).toBe('Authorization: token forge-secret')
    const other = vi.fn(async (_cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
      expect(JSON.stringify(env)).not.toContain('forge-secret')
      writeFileSync(args[args.indexOf('--output') + 1], 'x')
      return { stdout: '', stderr: '' }
    })
    await packRepo({ repo: 'a/b' }, { forge: async () => FORGE, token: async () => 'gh-tok', runner: other })
    expect(other).toHaveBeenCalled()
  })

  it('never shows the token when git output contains it', async () => {
    const runner = vi.fn(async () => { throw Object.assign(new Error('x'), { stderr: 'boom forge-secret boom' }) })
    const err = await packRepo({ repo: 'http://forgejo:3000/fam/app' }, { forge: async () => FORGE, runner }).catch(e => e)
    expect(String(err.message)).not.toContain('forge-secret')
    expect(String(err.message)).toContain('***')
  })

  it('lists forge repos with the token, and says when there is no forge', async () => {
    expect(await listForgeRepos({ forge: noForge })).toMatchObject({ configured: false, repos: [] })
    const fetcher = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('http://192.168.20.5:3030/api/v1/user/repos?limit=50')
      expect(init.headers.Authorization).toBe('token forge-secret')
      return new Response(JSON.stringify([{ full_name: 'fam/app', private: true, html_url: 'http://192.168.20.5:3030/fam/app' }]))
    })
    expect(await listForgeRepos({ forge: async () => FORGE, fetcher: fetcher as any })).toEqual({ configured: true, connected: true, url: FORGE.url, repos: [{ fullName: 'fam/app', private: true, url: 'http://192.168.20.5:3030/fam/app' }] })
  })
})
