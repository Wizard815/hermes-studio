import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { forgeConfig, forgeGet, forgePr, type ForgeConfig } from '../forge'

/**
 * Live status of the pull requests on a project's board, on GitHub or the
 * homelab forge (Forgejo/Gitea, FORGE_URL; docs/forge.md): open, draft,
 * merged or closed, and how its checks are doing (docs/projects.md#board).
 * Uses GH_TOKEN or GITHUB_TOKEN, else `gh auth token`, else no token (public
 * repos only, with GitHub's low anonymous rate limit). Results are cached for
 * a minute so the board's polling stays well inside the limit.
 */
export interface PrStatus {
  state: 'open' | 'draft' | 'merged' | 'closed'
  checks: 'passing' | 'failing' | 'pending' | 'none'
  /** GitHub's mergeable_state: clean, dirty (conflicts), blocked, behind, unstable… */
  mergeable: string
  title: string
  updatedAt: string
}

export type PrResult = PrStatus | { error: string }

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

const CACHE_MS = 60_000
const run = promisify(execFile)

/** owner, repo and number of a github.com pull request link, else null. */
export function githubPr(link: string): { owner: string; repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(link.trim())
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null
}

/** Check runs to one word: any failure fails, anything unfinished is pending. */
export function summarizeChecks(runs: Array<{ status?: string; conclusion?: string | null }>): PrStatus['checks'] {
  if (!runs.length) return 'none'
  if (runs.some(item => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(String(item.conclusion)))) return 'failing'
  if (runs.some(item => item.status !== 'completed')) return 'pending'
  return 'passing'
}

export class PrStatusReader {
  private readonly cache = new Map<string, { at: number; result: PrResult }>()
  private token: Promise<string> | null = null

  constructor(private readonly deps: { fetch?: Fetch; token?: () => Promise<string>; now?: () => number; forge?: ForgeConfig | null } = {}) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now() }

  private async authToken(): Promise<string> {
    if (!this.token) {
      this.token = (this.deps.token ?? defaultToken)().catch(() => '')
    }
    return this.token
  }

  async read(link: string): Promise<PrResult> {
    const cached = this.cache.get(link)
    if (cached && this.now() - cached.at < CACHE_MS) return cached.result
    const result = await this.fetchStatus(link).catch((error: any) => ({ error: String(error?.message || error) }))
    this.cache.set(link, { at: this.now(), result })
    return result
  }

  async readAll(links: string[]): Promise<Record<string, PrResult>> {
    const unique = [...new Set(links.filter(Boolean))].slice(0, 50)
    const results = await Promise.all(unique.map(link => this.read(link)))
    return Object.fromEntries(unique.map((link, index) => [link, results[index]]))
  }

  private async fetchStatus(link: string): Promise<PrResult> {
    const fetcher: Fetch = this.deps.fetch ?? (globalThis.fetch as unknown as Fetch)
    const forge = this.deps.forge !== undefined ? this.deps.forge : forgeConfig()
    const onForge = forgePr(link, forge)
    if (onForge && forge) return this.forgeStatus(forge, onForge, fetcher)
    const pr = githubPr(link)
    if (!pr) return { error: forge ? 'Only github.com and forge pull requests show live status' : 'Only github.com pull requests show live status (set FORGE_URL for your own forge)' }
    const token = await this.authToken()
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'hermes-studio', 'X-GitHub-Api-Version': '2022-11-28' }
    if (token) headers.Authorization = `Bearer ${token}`
    const api = `https://api.github.com/repos/${pr.owner}/${pr.repo}`
    const response = await fetcher(`${api}/pulls/${pr.number}`, { headers })
    if (!response.ok) {
      return { error: response.status === 404 ? 'GitHub has no such pull request, or it is private and Studio has no token for it' : response.status === 403 ? 'GitHub refused: rate limited or no access. Set GH_TOKEN on the Studio host.' : `GitHub answered ${response.status}` }
    }
    const data = await response.json()
    const state: PrStatus['state'] = data.merged_at ? 'merged' : data.state === 'closed' ? 'closed' : data.draft ? 'draft' : 'open'
    let checks: PrStatus['checks'] = 'none'
    if (data.head?.sha) {
      const runs = await fetcher(`${api}/commits/${data.head.sha}/check-runs?per_page=100`, { headers })
      if (runs.ok) checks = summarizeChecks((await runs.json())?.check_runs || [])
    }
    return { state, checks, mergeable: String(data.mergeable_state || ''), title: String(data.title || ''), updatedAt: String(data.updated_at || '') }
  }

  /** Forgejo/Gitea: the PR, then its head commit's combined status (Forgejo Actions reports there). */
  private async forgeStatus(forge: ForgeConfig, pr: { owner: string; repo: string; number: number }, fetcher: Fetch): Promise<PrResult> {
    const api = `/repos/${pr.owner}/${pr.repo}`
    const data = await forgeGet(forge, `${api}/pulls/${pr.number}`, fetcher)
    const title = String(data.title || '')
    const state: PrStatus['state'] = data.merged ? 'merged' : data.state === 'closed' ? 'closed' : data.draft || /^\s*(wip|\[wip\])\s*:?/i.test(title) ? 'draft' : 'open'
    let checks: PrStatus['checks'] = 'none'
    if (data.head?.sha) {
      try {
        checks = forgeChecks(await forgeGet(forge, `${api}/commits/${data.head.sha}/status`, fetcher))
      } catch { /* no status yet: none */ }
    }
    const mergeable = data.merged || data.state === 'closed' ? '' : data.mergeable === false ? 'dirty' : data.mergeable === true ? 'clean' : ''
    return { state, checks, mergeable, title, updatedAt: String(data.updated_at || '') }
  }
}

/** A forge commit's combined status to one word. */
export function forgeChecks(status: { state?: string; total_count?: number } | null | undefined): PrStatus['checks'] {
  if (!status || !status.total_count) return 'none'
  if (status.state === 'failure' || status.state === 'error') return 'failing'
  if (status.state === 'pending') return 'pending'
  return 'passing'
}

export async function defaultToken(): Promise<string> {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (env) return env.trim()
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { timeout: 5_000 })
    return stdout.trim()
  } catch {
    return ''
  }
}
