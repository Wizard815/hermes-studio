import type { Context } from 'koa'
import { join } from 'node:path'
import { getWebUiHome } from '../public/config'
import { CommitSummaryStore, ProjectCommitReader } from '../services/projects/commits'
import { projectStore } from '../services/projects/service'

/** The commits a project's threads and PRs are working on, with caveman summaries (docs/project-commits.md). */
let reader: ProjectCommitReader | null = null
function commits(): ProjectCommitReader {
  reader ??= new ProjectCommitReader({ summaries: new CommitSummaryStore(join(getWebUiHome(), 'projects', 'commit-summaries.json')) })
  return reader
}

function fail(ctx: Context, error: unknown) {
  const status = Number((error as { status?: number })?.status)
  ctx.status = status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

const param = (ctx: Context, name: string) => String((ctx.params as Record<string, string>)[name] || '')
const query = (ctx: Context, name: string) => {
  const value = (ctx.query as Record<string, unknown>)[name]
  return String(Array.isArray(value) ? value[0] ?? '' : value ?? '')
}

async function project(ctx: Context) {
  const found = await projectStore().find(param(ctx, 'id'))
  if (!found) throw Object.assign(new Error('Project not found'), { status: 404 })
  return found
}

export async function list(ctx: Context) {
  try { ctx.body = await commits().list(await project(ctx)) } catch (error) { fail(ctx, error) }
}

export async function summary(ctx: Context) {
  try {
    const thread = query(ctx, 'thread')
    const pr = query(ctx, 'pr')
    ctx.body = { summary: await commits().summary(await project(ctx), param(ctx, 'sha'), thread ? { thread } : { pr }) }
  } catch (error) { fail(ctx, error) }
}
