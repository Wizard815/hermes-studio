import type { Context } from 'koa'
import { logger } from '../public/logging'
import { RepoPackError, listForgeRepos, listGithubRepos, packRepo } from '../services/repo-pack'

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
  // Each source fails on its own: a forge that is down still leaves the GitHub list, and the other way round.
  const [github, forge] = await Promise.all([
    listGithubRepos().catch((err: any) => ({ connected: false, repos: [], error: err?.message || 'Could not list GitHub repos' })),
    listForgeRepos().catch((err: any) => ({ configured: true, connected: false, url: '', repos: [], error: err?.message || 'Could not list forge repos' })),
  ])
  ctx.body = { ...github, forge }
}
