import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { forgeConfig, forgeGet, forgePr, type ForgeConfig } from '../forge'
import { defaultToken, githubPr } from './pr-status'
import type { Project } from './store'

/**
 * The commits a project's threads and pull requests are working on, and a
 * short caveman summary of each one (docs/project-commits.md).
 *
 * A thread with its own worktree lists the commits on its branch that no
 * other branch has. A pull request lists its commits from GitHub or the
 * homelab forge. Summaries come from a cheap model through Argos (ARGOS_URL,
 * model STUDIO_COMMIT_SUMMARY_MODEL) and are kept per commit SHA, so each
 * commit is summarized once.
 */
export interface ProjectCommit {
  sha: string
  short: string
  subject: string
  author: string
  /** ISO time the commit was authored. */
  date: string
  /** The commit on GitHub or the forge, '' for a local-only commit. */
  url: string
  /** The caveman summary when one is saved already, else ''. */
  summary: string
}

export type CommitList = { commits: ProjectCommit[]; more: boolean } | { error: string }

export interface ProjectCommits {
  /** By thread id: threads with a branch only. */
  threads: Record<string, CommitList>
  /** By pull request link. */
  prs: Record<string, CommitList>
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

export const COMMITS_LIMIT = 30
const PR_CACHE_MS = 60_000
const SUMMARY_MAX = 280
const DETAILS_MAX = 6_000
const SUMMARY_TIMEOUT_MS = 45_000
/** A failed summary is not asked again for this long (hovering again should not hammer Argos). */
const SUMMARY_RETRY_MS = 5 * 60_000
const SUMMARIES_KEPT = 5_000
const SHA = /^[0-9a-f]{7,40}$/i
const run = promisify(execFile)

export const COMMIT_SUMMARY_PROMPT = [
  'You explain one git commit to a busy person who does not read code.',
  'Talk like a smart caveman: short words, no filler, no "this commit". Every fact stays.',
  'Say what changed and what it does for the person. One or two short sentences, at most 30 words.',
  'Output only the summary. No markdown, no quotes, no commit hash.',
  '',
  'Example: "Board show commits now. Hover one, get short summary. Summary saved, so model asked once."',
].join('\n')

/** Where commit summaries come from: Argos's OpenAI-compatible API. Null when ARGOS_URL is unset. */
export interface SummaryModel { url: string; model: string; apiKey: string }

export function summaryModel(env: NodeJS.ProcessEnv = process.env): SummaryModel | null {
  const url = String(env.STUDIO_COMMIT_SUMMARY_URL || env.ARGOS_URL || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return null
  return {
    url,
    model: String(env.STUDIO_COMMIT_SUMMARY_MODEL || 'studio-caveman').trim(),
    apiKey: String(env.STUDIO_COMMIT_SUMMARY_API_KEY || env.ARGOS_API_KEY || '').trim(),
  }
}

/** A model reply to one clean line: no thinking block, quotes or markdown, at most SUMMARY_MAX characters. */
export function cleanSummary(raw: unknown): string {
  let text = String(raw ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, ' ')
  text = text.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim()
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  text = text.replace(/^(summary|caveman)\s*[:：]\s*/i, '').trim()
  if (text.length <= SUMMARY_MAX) return text
  const cut = text.slice(0, SUMMARY_MAX)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '))
  return (stop > SUMMARY_MAX / 2 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : SUMMARY_MAX)}…`).trim()
}

async function git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 20_000, maxBuffer })
  return stdout
}

const FIELD = '\x1f'
const RECORD = '\x1e'

/** `git log` output in the format branchCommits asks for, as commits. */
export function parseLog(out: string): ProjectCommit[] {
  return out.split(RECORD).map(item => item.trim()).filter(Boolean).map(line => {
    const [sha, short, subject, author, date] = line.split(FIELD)
    return { sha, short, subject: subject || '', author: author || '', date: date || '', url: '', summary: '' }
  }).filter(item => SHA.test(item.sha || ''))
}

/**
 * The commits on `branch` that no other local or remote branch has: the
 * thread's own work, newest first. Once the work is merged (and fetched),
 * main has them and the list empties; the PR's list still shows them.
 */
export async function branchCommits(cwd: string, branch: string, limit = COMMITS_LIMIT): Promise<{ commits: ProjectCommit[]; more: boolean }> {
  if (!branch || branch.startsWith('-') || /[\s~^:?*[\\]/.test(branch)) throw new Error('Not a branch name')
  const out = await git(cwd, [
    'log', `-n${limit + 1}`, `--format=%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%aI${RECORD}`,
    `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches', `--exclude=*/${branch}`, '--remotes', '--',
  ])
  const commits = parseLog(out)
  return { commits: commits.slice(0, limit), more: commits.length > limit }
}

/** What the model reads about a local commit: its message, the files and the start of the diff. */
async function localDetails(cwd: string, sha: string): Promise<string> {
  const out = await git(cwd, ['show', '--no-color', '--stat', '--patch', '-M', '--format=%B', sha, '--'], 16 * 1024 * 1024).catch((error: any) => {
    // A huge diff overflows maxBuffer: the message and file list are enough.
    if (String(error?.code) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return git(cwd, ['show', '--no-color', '--stat', '--format=%B', sha, '--'])
    throw error
  })
  return out.slice(0, DETAILS_MAX)
}

interface SavedSummary { summary: string; at: number }

/** Summaries by SHA, kept in one JSON file under the Studio state folder. */
export class CommitSummaryStore {
  private data: Record<string, SavedSummary> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, SavedSummary>> {
    if (this.data) return this.data
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      this.data = raw && typeof raw === 'object' && raw.summaries && typeof raw.summaries === 'object' ? raw.summaries : {}
    } catch {
      this.data = {}
    }
    return this.data!
  }

  async get(sha: string): Promise<string> {
    return (await this.load())[sha.toLowerCase()]?.summary || ''
  }

  async getMany(shas: string[]): Promise<Record<string, string>> {
    const data = await this.load()
    return Object.fromEntries(shas.map(sha => [sha, data[sha.toLowerCase()]?.summary || '']))
  }

  async set(sha: string, summary: string, now = Date.now()): Promise<void> {
    const data = await this.load()
    data[sha.toLowerCase()] = { summary, at: now }
    const keys = Object.keys(data)
    if (keys.length > SUMMARIES_KEPT) {
      for (const key of keys.sort((a, b) => data[a].at - data[b].at).slice(0, keys.length - SUMMARIES_KEPT)) delete data[key]
    }
    const body = JSON.stringify({ version: 1, summaries: data })
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, body)
      await rename(temp, this.file)
    }).catch(() => { /* the summary still shows; it is asked again after a restart */ })
    await this.writing
  }
}

export interface CommitDeps {
  summaries: Pick<CommitSummaryStore, 'get' | 'getMany' | 'set'>
  fetch?: Fetch
  token?: () => Promise<string>
  now?: () => number
  forge?: ForgeConfig | null
  /** The model for summaries; default from the environment. */
  model?: () => SummaryModel | null
}

export class ProjectCommitReader {
  private readonly prCache = new Map<string, { at: number; result: CommitList }>()
  private readonly failed = new Map<string, { at: number; error: string }>()
  private readonly inFlight = new Map<string, Promise<string>>()
  private token: Promise<string> | null = null

  constructor(private readonly deps: CommitDeps) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now() }
  private fetcher(): Fetch { return this.deps.fetch ?? (globalThis.fetch as unknown as Fetch) }
  private forge(): ForgeConfig | null { return this.deps.forge !== undefined ? this.deps.forge : forgeConfig() }

  private async githubHeaders(): Promise<Record<string, string>> {
    this.token ??= (this.deps.token ?? defaultToken)().catch(() => '')
    const token = await this.token
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'hermes-studio', 'X-GitHub-Api-Version': '2022-11-28' }
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  /** Every thread branch's and every board PR's commits, with saved summaries filled in. */
  async list(project: Project): Promise<ProjectCommits> {
    const threads: Record<string, CommitList> = {}
    await Promise.all(project.threads.filter(thread => thread.branch).slice(0, 50).map(async thread => {
      try {
        threads[thread.id] = await branchCommits(thread.workspace || project.folder, thread.branch)
      } catch {
        // The worktree is gone: the branch is still in the project's repo.
        try { threads[thread.id] = await branchCommits(project.folder, thread.branch) } catch (error: any) {
          threads[thread.id] = { error: gitError(error) }
        }
      }
    }))
    const links = [...new Set([...project.threads.map(item => item.pr), ...project.tasks.map(item => item.pr)].filter(Boolean))].slice(0, 50)
    const prs: Record<string, CommitList> = {}
    await Promise.all(links.map(async link => { prs[link] = await this.prCommits(link) }))
    const shas = [...Object.values(threads), ...Object.values(prs)].flatMap(item => 'commits' in item ? item.commits.map(commit => commit.sha) : [])
    const saved = await this.deps.summaries.getMany([...new Set(shas)])
    for (const item of [...Object.values(threads), ...Object.values(prs)]) {
      if ('commits' in item) item.commits = item.commits.map(commit => ({ ...commit, summary: saved[commit.sha] || '' }))
    }
    return { threads, prs }
  }

  /** A pull request's commits, oldest last like the branch list (cached a minute). */
  async prCommits(link: string): Promise<CommitList> {
    const cached = this.prCache.get(link)
    if (cached && this.now() - cached.at < PR_CACHE_MS) return cached.result
    const result = await this.fetchPrCommits(link).catch((error: any) => ({ error: String(error?.message || error) }))
    this.prCache.set(link, { at: this.now(), result })
    return result
  }

  private async fetchPrCommits(link: string): Promise<CommitList> {
    const forge = this.forge()
    const onForge = forgePr(link, forge)
    let rows: any[]
    let web: string
    if (onForge && forge) {
      rows = await forgeGet(forge, `/repos/${onForge.owner}/${onForge.repo}/pulls/${onForge.number}/commits?limit=100`, this.fetcher())
      web = `${forge.url}/${onForge.owner}/${onForge.repo}/commit/`
    } else {
      const pr = githubPr(link)
      if (!pr) return { error: 'Only github.com and forge pull requests list their commits' }
      const response = await this.fetcher()(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/commits?per_page=100`, { headers: await this.githubHeaders() })
      if (!response.ok) return { error: response.status === 404 ? 'GitHub has no such pull request, or Studio has no token for it' : `GitHub answered ${response.status}` }
      rows = await response.json()
      web = `https://github.com/${pr.owner}/${pr.repo}/commit/`
    }
    const commits = (Array.isArray(rows) ? rows : []).map((row: any): ProjectCommit => {
      const sha = String(row?.sha || '')
      const message = String(row?.commit?.message || '')
      return {
        sha,
        short: sha.slice(0, 7),
        subject: message.split('\n')[0].trim(),
        author: String(row?.commit?.author?.name || row?.author?.login || ''),
        date: String(row?.commit?.author?.date || ''),
        url: String(row?.html_url || (sha ? web + sha : '')),
        summary: '',
      }
    }).filter(item => SHA.test(item.sha)).reverse()
    return { commits: commits.slice(0, COMMITS_LIMIT), more: commits.length > COMMITS_LIMIT }
  }

  /** What the model reads about a pull request's commit: message and changed files (with the start of their diffs on GitHub). */
  private async remoteDetails(link: string, sha: string): Promise<string> {
    const forge = this.forge()
    const onForge = forgePr(link, forge)
    let data: any
    if (onForge && forge) {
      data = await forgeGet(forge, `/repos/${onForge.owner}/${onForge.repo}/git/commits/${sha}`, this.fetcher())
    } else {
      const pr = githubPr(link)
      if (!pr) throw new Error('Not a pull request Studio can read')
      const response = await this.fetcher()(`https://api.github.com/repos/${pr.owner}/${pr.repo}/commits/${sha}`, { headers: await this.githubHeaders() })
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
      data = await response.json()
    }
    const files = (Array.isArray(data?.files) ? data.files : []).slice(0, 60)
    const list = files.map((file: any) => `${file.filename} | +${file.additions ?? '?'} -${file.deletions ?? '?'}`).join('\n')
    const patches = files.map((file: any) => file.patch ? `--- ${file.filename}\n${file.patch}` : '').filter(Boolean).join('\n')
    return `${String(data?.commit?.message || '')}\n\n${list}\n\n${patches}`.slice(0, DETAILS_MAX)
  }

  /**
   * The caveman summary of one commit of a thread branch (`thread`) or a PR
   * (`pr`). The commit must be in that list, so a request can't make Studio
   * read anything else. Saved per SHA; a failure is not retried for 5 minutes.
   */
  async summary(project: Project, sha: string, source: { thread?: string; pr?: string }): Promise<string> {
    const key = String(sha || '').toLowerCase()
    if (!SHA.test(key)) fail('Not a commit SHA', 400)
    const saved = await this.deps.summaries.get(key)
    if (saved) return saved
    const model = (this.deps.model ?? summaryModel)()
    if (!model) fail('No summary model: set ARGOS_URL on the Studio host (and STUDIO_COMMIT_SUMMARY_MODEL for a model other than studio-caveman).', 503)
    const failed = this.failed.get(key)
    if (failed && this.now() - failed.at < SUMMARY_RETRY_MS) fail(failed.error, 502)

    let details: () => Promise<string>
    if (source.thread) {
      const thread = project.threads.find(item => item.id === source.thread)
      if (!thread?.branch) fail('No such thread with a branch in this project', 404)
      const cwd = thread.workspace || project.folder
      const listed = await branchCommits(cwd, thread.branch).catch(() => branchCommits(project.folder, thread.branch))
      const commit = listed.commits.find(item => item.sha.toLowerCase().startsWith(key))
      if (!commit) fail('That commit is not on the thread\'s branch', 404)
      details = () => localDetails(cwd, commit.sha).catch(() => localDetails(project.folder, commit.sha))
    } else if (source.pr) {
      const link = source.pr
      if (![...project.threads.map(item => item.pr), ...project.tasks.map(item => item.pr)].includes(link)) fail('That pull request is not on this project\'s board', 404)
      const listed = await this.prCommits(link)
      if ('error' in listed) fail(listed.error, 502)
      const commit = listed.commits.find(item => item.sha.toLowerCase().startsWith(key))
      if (!commit) fail('That commit is not in the pull request', 404)
      details = () => this.remoteDetails(link, commit.sha)
    } else {
      fail('Say which thread or pull request the commit is from', 400)
    }

    let pending = this.inFlight.get(key)
    if (!pending) {
      pending = (async () => {
        const summary = await this.askModel(model, await details())
        await this.deps.summaries.set(key, summary, this.now())
        return summary
      })()
      this.inFlight.set(key, pending)
      pending.catch((error: any) => { this.failed.set(key, { at: this.now(), error: String(error?.message || error) }) })
        .finally(() => { this.inFlight.delete(key) })
    }
    return pending
  }

  private async askModel(model: SummaryModel, details: string): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`
    let response
    try {
      response = await this.fetcher()(`${model.url}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model.model,
          messages: [{ role: 'system', content: COMMIT_SUMMARY_PROMPT }, { role: 'user', content: details }],
          max_tokens: 400,
          temperature: 0.2,
          stream: false,
        }),
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      })
    } catch {
      throw new Error(`Argos isn't answering at ${model.url}. Check that it is running and ARGOS_URL is right.`)
    }
    if (!response.ok) throw new Error(response.status === 404 ? `Argos has no model ${model.model}. Add it in Argos or set STUDIO_COMMIT_SUMMARY_MODEL.` : `Argos answered ${response.status}`)
    const data = await response.json()
    const summary = cleanSummary(data?.choices?.[0]?.message?.content)
    if (!summary) throw new Error('The model gave an empty summary')
    return summary
  }
}

function gitError(error: any): string {
  return String(error?.stderr || error?.message || error).trim().split('\n')[0] || 'git failed'
}

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status })
}
