import type { Context } from 'koa'
import { logger } from '../public/logging'
import { RepoPackError, listGithubRepos, packRepo } from '../services/repo-pack'

/** Add a repo to a chat (docs/repo-pack.md). */
export async function pack(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  try {
    const result = await packRepo({
      repo: String(body.repo || ''),
      ref: typeof body.ref === 'string' ? body.ref : undefined,
      include: typeof body.include === 'string' ? body.include : undefined,
      compress: body.compress !== false,
    })
    logger.info('[repo-pack] packed %s (%d bytes)', result.repo, result.bytes)
    ctx.body = result
  } catch (err: any) {
    ctx.status = err instanceof RepoPackError ? err.status : 500
    ctx.body = { error: err?.message || 'Packing failed' }
  }
}

export async function repos(ctx: Context) {
  try {
    ctx.body = await listGithubRepos()
  } catch (err: any) {
    ctx.status = err instanceof RepoPackError ? err.status : 502
    ctx.body = { error: err?.message || 'Could not list GitHub repos' }
  }
}
