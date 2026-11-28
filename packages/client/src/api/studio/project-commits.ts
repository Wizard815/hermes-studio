import { request } from '../client'

/** One commit a thread or pull request is working on (docs/project-commits.md). */
export interface ProjectCommit {
  sha: string
  short: string
  subject: string
  author: string
  date: string
  /** On GitHub or the forge; '' for a commit only on the Studio host. */
  url: string
  /** The caveman summary when it is saved already, else ''. */
  summary: string
}

export type CommitList = { commits: ProjectCommit[]; more: boolean } | { error: string }

export interface ProjectCommits {
  threads: Record<string, CommitList>
  prs: Record<string, CommitList>
}

/** Where a commit came from: a thread's branch or a board PR. */
export type CommitSource = { thread: string } | { pr: string }

const base = (id: string) => `/api/studio/projects/${encodeURIComponent(id)}/commits`

export const getProjectCommits = (id: string) => request<ProjectCommits>(base(id))

export const getCommitSummary = async (id: string, sha: string, source: CommitSource) => {
  const query = 'thread' in source ? `thread=${encodeURIComponent(source.thread)}` : `pr=${encodeURIComponent(source.pr)}`
  return (await request<{ summary: string }>(`${base(id)}/${encodeURIComponent(sha)}/summary?${query}`)).summary
}
