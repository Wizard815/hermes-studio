import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Add a repo to a chat (docs/repo-pack.md): repomix packs a GitHub repo into one
 * Markdown file on the Studio host, and the chat attaches that file like any
 * upload. A GitHub token (GH_TOKEN, GITHUB_TOKEN or `gh auth token`) lets it
 * reach private repos and list the person's own; the token goes to git through
 * the environment, never the command line.
 */

export const REPOMIX_VERSION = '1.19.0'
export const MAX_PACK_BYTES = 20 * 1024 * 1024
const PACK_TIMEOUT_MS = 5 * 60_000

export interface RepoPackRequest {
  repo: string
  ref?: string
  include?: string
  compress?: boolean
}

export interface RepoPackResult { name: string; content: string; bytes: number; repo: string }

export class RepoPackError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

/** `owner/repo`, a github.com link (tree/blob paths and .git allowed) or another https git URL, else null. */
export function normalizeRepo(input: string): { url: string; label: string; github?: { owner: string; repo: string; ref?: string } } | null {
  const text = input.trim()
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(text)
  const gh = short || /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/?#]+))?\/?(?:[?#].*)?$/i.exec(text)
  if (gh) {
    const owner = gh[1]
    const repo = gh[2].replace(/\.git$/, '')
    if (!repo || owner.startsWith('.') || repo.startsWith('.')) return null
    return { url: `https://github.com/${owner}/${repo}`, label: `${owner}/${repo}`, github: { owner, repo, ref: gh[3] } }
  }
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    const label = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
    return label ? { url: url.toString(), label } : null
  } catch {
    return null
  }
}

const SAFE_REF = /^[\w./-]{1,200}$/
const SAFE_INCLUDE = /^[\w*?.,/{}\[\] -]{1,500}$/

export function repomixArgs(request: RepoPackRequest, url: string, output: string): string[] {
  const args = ['-y', `repomix@${REPOMIX_VERSION}`, '--remote', url, '--style', 'markdown', '--output', output, '--no-file-summary']
  if (request.ref) {
    if (!SAFE_REF.test(request.ref) || request.ref.startsWith('-')) throw new RepoPackError('That branch, tag or commit name has characters Studio does not accept.')
    args.push('--remote-branch', request.ref)
  }
  if (request.include?.trim()) {
    if (!SAFE_INCLUDE.test(request.include.trim())) throw new RepoPackError('The include pattern has characters Studio does not accept. Use globs like src/**,docs/**.')
    args.push('--include', request.include.trim())
  }
  if (request.compress !== false) args.push('--compress')
  return args
}

/** Env for git so it can read a private github.com repo with the token, without the token in argv. */
export function githubGitEnv(token: string): Record<string, string> {
  if (!token) return {}
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function githubToken(): Promise<string> {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (env) return env.trim()
  try {
    return (await run('gh', ['auth', 'token'], process.env, 5_000)).stdout.trim()
  } catch {
    return ''
  }
}

export interface RepoPackDeps {
  token?: () => Promise<string>
  runner?: typeof run
}

export async function packRepo(request: RepoPackRequest, deps: RepoPackDeps = {}): Promise<RepoPackResult> {
  const target = normalizeRepo(String(request.repo || ''))
  if (!target) throw new RepoPackError('Give a GitHub repo as owner/name or a link, or another https git URL.')
  const ref = request.ref?.trim() || target.github?.ref
  const dir = await mkdtemp(join(tmpdir(), 'studio-repo-pack-'))
  const fileName = `${target.label.replace(/[^\w.-]+/g, '_')}${ref ? `@${ref.replace(/[^\w.-]+/g, '_')}` : ''}.repomix.md`
  const output = join(dir, fileName)
  try {
    const args = repomixArgs({ ...request, ref }, target.url, output)
    const token = target.github ? await (deps.token || githubToken)() : ''
    const env = { ...process.env, ...githubGitEnv(token), NO_COLOR: '1' }
    try {
      await (deps.runner || run)('npx', args, env, PACK_TIMEOUT_MS)
    } catch (err: any) {
      const detail = String(err?.stderr || err?.stdout || err?.message || '').split('\n').map(line => line.trim()).filter(Boolean).slice(-3).join(' ')
      if (err?.code === 'ENOENT') throw new RepoPackError('Node.js (npx) is not installed on the Studio host, so repomix cannot run.', 500)
      if (err?.killed) throw new RepoPackError('Packing took longer than 5 minutes. Try an include pattern for just the folders you need.', 504)
      if (/not found|could not read|authentication|403|404/i.test(detail)) {
        throw new RepoPackError(token ? `git could not read ${target.label}. Check the name and that the token can see it.` : `git could not read ${target.label}. If it is private, set GH_TOKEN on the Studio host.`, 404)
      }
      throw new RepoPackError(`repomix failed: ${detail.slice(0, 300) || 'no output'}`, 502)
    }
    const size = (await stat(output).catch(() => null))?.size ?? -1
    if (size < 0) throw new RepoPackError('repomix finished but wrote no file.', 502)
    if (size > MAX_PACK_BYTES) throw new RepoPackError(`The packed repo is ${Math.round(size / 1024 / 1024)} MB, more than 20 MB. Use an include pattern for just the folders you need.`, 413)
    return { name: fileName, content: await readFile(output, 'utf8'), bytes: size, repo: target.label }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface GithubRepoSummary { fullName: string; private: boolean; description: string; pushedAt: string; defaultBranch: string }

/** The person's own repos (most recently pushed first), when Studio has a GitHub token. */
export async function listGithubRepos(deps: { token?: () => Promise<string>; fetcher?: typeof fetch } = {}): Promise<{ connected: boolean; repos: GithubRepoSummary[] }> {
  const token = await (deps.token || githubToken)()
  if (!token) return { connected: false, repos: [] }
  const res = await (deps.fetcher || fetch)('https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hermes-studio', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new RepoPackError(res.status === 401 ? 'GitHub did not accept the token on the Studio host.' : `GitHub answered ${res.status}`, 502)
  const data = await res.json() as any[]
  return {
    connected: true,
    repos: data.map(repo => ({
      fullName: String(repo.full_name), private: !!repo.private, description: String(repo.description || ''),
      pushedAt: String(repo.pushed_at || ''), defaultBranch: String(repo.default_branch || ''),
    })),
  }
}
