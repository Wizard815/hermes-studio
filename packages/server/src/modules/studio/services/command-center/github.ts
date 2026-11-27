import { failure, parseJson, runCli, type CliRunner } from './cli'
import type { CommandCenterSettings } from './settings'
import { forgeConfig, forgeGet, type ForgeConfig, type ForgeFetch } from '../forge'

/**
 * GitHub for the Inbox, through the `gh` CLI the server is signed in with
 * (Command Center's idea; Studio reads it, it never stores a token): open
 * pull requests of the signed-in account whose checks failed, review requests,
 * and, for repositories named in the settings, workflows whose latest run on
 * a branch failed. Off when `gh` is missing or signed out.
 *
 * The homelab forge (Forgejo/Gitea, FORGE_URL + FORGE_TOKEN; docs/forge.md)
 * adds the same three kinds of item from its API, for repositories named in
 * the settings as `forge:owner/repo`.
 */

export interface GithubItem {
  id: string
  kind: 'ci' | 'review'
  repo: string
  title: string
  url: string
  number?: number
  /** Milliseconds since the epoch. */
  at: number
  detail?: string
  /** Where it lives; absent means GitHub. */
  source?: 'github' | 'forge'
}

export interface GithubInbox {
  enabled: boolean
  /** `gh` is on the server's PATH. */
  available: boolean
  signedIn: boolean
  login?: string
  repos: string[]
  items: GithubItem[]
  error?: string
  checkedAt: number
  /** The homelab forge, when FORGE_URL is set on the Studio host. */
  forge?: { url: string; login?: string; error?: string }
}

const QUERY = `query($n: Int!) {
  viewer {
    login
    pullRequests(first: $n, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title url updatedAt repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
  }
  reviews: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: $n) {
    nodes { ... on PullRequest { number title url updatedAt author { login } repository { nameWithOwner } } }
  }
}`

const time = (value: unknown) => {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : 0
}

const inRepos = (repos: string[], repo: string) => !repos.length || repos.some(item => item.toLowerCase() === repo.toLowerCase())

/** Failed CI on the account's own open pull requests, and review requests. */
export function parseGraphql(body: any, repos: string[] = []): { login: string; items: GithubItem[] } {
  const data = body?.data || {}
  const items: GithubItem[] = []
  for (const pr of data.viewer?.pullRequests?.nodes || []) {
    const state = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
    const repo = String(pr?.repository?.nameWithOwner || '')
    if (!repo || !inRepos(repos, repo) || (state !== 'FAILURE' && state !== 'ERROR')) continue
    items.push({ id: `ci:pr:${repo}#${pr.number}`, kind: 'ci', repo, title: String(pr.title || ''), url: String(pr.url || ''), number: pr.number, at: time(pr.updatedAt), detail: 'checks failed' })
  }
  for (const pr of data.reviews?.nodes || []) {
    const repo = String(pr?.repository?.nameWithOwner || '')
    if (!repo || !pr.url || !inRepos(repos, repo)) continue
    items.push({ id: `review:${repo}#${pr.number}`, kind: 'review', repo, title: String(pr.title || ''), url: String(pr.url), number: pr.number, at: time(pr.updatedAt), detail: pr.author?.login ? `from ${pr.author.login}` : undefined })
  }
  return { login: String(data.viewer?.login || ''), items }
}

/**
 * Workflow runs of one repository (`gh run list --json`, newest first): a
 * workflow and branch whose latest finished run failed. A later green run
 * clears it.
 */
export function failedRuns(repo: string, runs: any[]): GithubItem[] {
  const latest = new Map<string, any>()
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run?.status && run.status !== 'completed') continue
    const key = `${run?.workflowName || ''}|${run?.headBranch || ''}`
    const known = latest.get(key)
    if (!known || time(run.createdAt) > time(known.createdAt)) latest.set(key, run)
  }
  return [...latest.values()]
    .filter(run => ['failure', 'timed_out', 'startup_failure'].includes(String(run.conclusion || '')))
    .map(run => ({
      id: `ci:run:${repo}:${run.databaseId}`,
      kind: 'ci' as const,
      repo,
      title: String(run.displayTitle || run.workflowName || 'Workflow run'),
      url: String(run.url || ''),
      at: time(run.createdAt),
      detail: [run.workflowName, run.headBranch].filter(Boolean).join(' · '),
    }))
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])

/**
 * Forgejo Actions runs of one forge repository (`/actions/tasks`, newest
 * first): a workflow and branch whose latest finished run failed.
 */
export function failedForgeRuns(repo: string, runs: any[], forgeUrl: string): GithubItem[] {
  const latest = new Map<string, any>()
  for (const run of Array.isArray(runs) ? runs : []) {
    if (['running', 'waiting', 'blocked'].includes(String(run?.status || ''))) continue
    const key = `${run?.workflow_id || run?.name || ''}|${run?.head_branch || ''}`
    const known = latest.get(key)
    if (!known || time(run.created_at) > time(known.created_at)) latest.set(key, run)
  }
  return [...latest.values()]
    .filter(run => FAILED.has(String(run.status || '')))
    .map(run => ({
      id: `ci:forge-run:${repo}:${run.id}`,
      kind: 'ci' as const,
      repo,
      title: String(run.display_title || run.name || 'Workflow run'),
      url: String(run.url || `${forgeUrl}/${repo}/actions`),
      at: time(run.created_at),
      detail: [run.workflow_id || run.name, run.head_branch].filter(Boolean).join(' · '),
      source: 'forge' as const,
    }))
}

/** Review requests and the account's own open PRs whose checks failed, from the forge. */
export async function forgeInbox(forge: ForgeConfig, repos: string[], fetcher?: ForgeFetch): Promise<{ login: string; items: GithubItem[] }> {
  const me = await forgeGet(forge, '/user', fetcher)
  const items: GithubItem[] = []
  const issue = (pr: any) => ({ repo: String(pr?.repository?.full_name || ''), number: Number(pr?.number), title: String(pr?.title || ''), url: String(pr?.html_url || ''), at: time(pr?.updated_at) })
  const reviews = await forgeGet(forge, '/repos/issues/search?type=pulls&state=open&review_requested=true&limit=30', fetcher)
  for (const raw of Array.isArray(reviews) ? reviews : []) {
    const pr = issue(raw)
    if (!pr.repo || !pr.url) continue
    items.push({ id: `review:forge:${pr.repo}#${pr.number}`, kind: 'review', ...pr, detail: raw?.user?.login ? `from ${raw.user.login}` : undefined, source: 'forge' })
  }
  const mine = await forgeGet(forge, '/repos/issues/search?type=pulls&state=open&created=true&limit=15', fetcher)
  for (const raw of Array.isArray(mine) ? mine : []) {
    const pr = issue(raw)
    if (!pr.repo) continue
    try {
      const full = await forgeGet(forge, `/repos/${pr.repo}/pulls/${pr.number}`, fetcher)
      const status = full?.head?.sha ? await forgeGet(forge, `/repos/${pr.repo}/commits/${full.head.sha}/status`, fetcher) : null
      if (status?.total_count && (status.state === 'failure' || status.state === 'error')) {
        items.push({ id: `ci:forge-pr:${pr.repo}#${pr.number}`, kind: 'ci', ...pr, detail: 'checks failed', source: 'forge' })
      }
    } catch { /* one PR the token can't read doesn't hide the rest */ }
  }
  for (const repo of repos) {
    try {
      const runs = await forgeGet(forge, `/repos/${repo}/actions/tasks?limit=30`, fetcher)
      items.push(...failedForgeRuns(repo, runs?.workflow_runs || [], forge.url))
    } catch { /* a repo without Actions, or out of reach */ }
  }
  return { login: String(me?.login || ''), items }
}

export class GithubFeed {
  private cache: { key: string; value: GithubInbox } | null = null

  constructor(
    private readonly run: CliRunner = runCli,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
    private readonly forge: () => ForgeConfig | null = forgeConfig,
    private readonly forgeFetch?: ForgeFetch,
  ) {}

  async inbox(settings: CommandCenterSettings, options: { refresh?: boolean } = {}): Promise<GithubInbox> {
    const { enabled, repos } = settings.github
    const key = JSON.stringify(settings.github)
    if (!options.refresh && this.cache?.key === key && this.now() - this.cache.value.checkedAt < this.ttlMs) return this.cache.value
    const gh = repos.filter(repo => !repo.startsWith('forge:'))
    const onForge = repos.filter(repo => repo.startsWith('forge:')).map(repo => repo.slice('forge:'.length))
    const value = await this.withForge(await this.load(enabled, gh), enabled, onForge)
    this.cache = { key, value }
    return value
  }

  private async withForge(inbox: GithubInbox, enabled: boolean, repos: string[]): Promise<GithubInbox> {
    const forge = this.forge()
    if (!forge || !enabled) return inbox
    if (!forge.token) return { ...inbox, forge: { url: forge.url, error: 'Set FORGE_TOKEN on the Studio host to see the forge in the Inbox' } }
    try {
      const { login, items } = await forgeInbox(forge, repos, this.forgeFetch)
      return { ...inbox, forge: { url: forge.url, login }, items: [...inbox.items, ...items].sort((a, b) => b.at - a.at) }
    } catch (error: any) {
      return { ...inbox, forge: { url: forge.url, error: String(error?.message || error) } }
    }
  }

  private async load(enabled: boolean, repos: string[]): Promise<GithubInbox> {
    const base: GithubInbox = { enabled, available: false, signedIn: false, repos, items: [], checkedAt: this.now() }
    const auth = await this.run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 10_000, env: { GH_PROMPT_DISABLED: '1' } })
    if (auth.missing) return base
    base.available = true
    if (auth.code !== 0) return { ...base, error: failure(auth, 'gh auth status') }
    base.signedIn = true
    if (!enabled) return base
    const graph = await this.run('gh', ['api', 'graphql', '-f', `query=${QUERY}`, '-F', 'n=30'], { timeoutMs: 20_000, env: { GH_PROMPT_DISABLED: '1' } })
    const body = parseJson(graph.stdout)
    if (graph.code !== 0 || !body) return { ...base, error: failure(graph, 'gh api graphql') }
    const { login, items } = parseGraphql(body, repos)
    const runs = await Promise.all(repos.map(async repo => {
      const result = await this.run('gh', ['run', 'list', '-R', repo, '--limit', '30', '--json', 'databaseId,displayTitle,workflowName,headBranch,status,conclusion,url,createdAt'], { timeoutMs: 20_000, env: { GH_PROMPT_DISABLED: '1' } })
      return result.code === 0 ? failedRuns(repo, parseJson<any[]>(result.stdout) || []) : []
    }))
    const all = [...items, ...runs.flat()].sort((a, b) => b.at - a.at)
    return { ...base, login, items: all }
  }
}
