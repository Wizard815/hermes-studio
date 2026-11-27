import { request } from '../client'

/** Add a repo to a chat (docs/repo-pack.md): repomix packs it on the Studio host. */
export interface RepoPackResult { name: string; content: string; bytes: number; repo: string }
export interface GithubRepoSummary { fullName: string; private: boolean; description: string; pushedAt: string; defaultBranch: string }

export const packRepo = (body: { repo: string; ref?: string; include?: string; compress?: boolean }) =>
  request<RepoPackResult>('/api/studio/repo-pack', { method: 'POST', body: JSON.stringify(body) })

export interface ForgeRepoSummary { fullName: string; private: boolean; url: string }
export interface RepoLists {
  connected: boolean
  repos: GithubRepoSummary[]
  /** The family Forgejo (skills.config.forgejo.url + FORGE_TOKEN in the Hermes profile). */
  forge?: { configured: boolean; connected: boolean; url: string; repos: ForgeRepoSummary[]; error?: string }
}

export const fetchGithubRepos = () => request<RepoLists>('/api/studio/repo-pack/repos')

/** The packed file as an attachment: Markdown, so every model can read it. */
export function packedRepoFile(result: RepoPackResult): File {
  return new File([result.content], result.name, { type: 'text/markdown' })
}
