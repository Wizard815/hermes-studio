import type { Context } from 'koa'
import { DAILY_SECTIONS, getLlmWikiClient, LlmWikiError, type DailySection } from '../services/llmwiki/client'

function fail(ctx: Context, error: unknown) {
  ctx.status = error instanceof LlmWikiError ? error.status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

export async function status(ctx: Context) {
  try { ctx.body = await getLlmWikiClient().status() } catch (error) { fail(ctx, error) }
}

export async function saveSettings(ctx: Context) {
  try { ctx.body = await getLlmWikiClient().save((ctx.request.body || {}) as any) } catch (error) { fail(ctx, error) }
}

/** Semantic search over wiki/ (long-term memory). */
export async function search(ctx: Context) {
  try {
    const query = String((ctx.request.body as any)?.query || ctx.query.q || '').trim()
    if (!query) { ctx.status = 400; ctx.body = { error: 'query is required' }; return }
    ctx.body = { result: await getLlmWikiClient().search(query) }
  } catch (error) { fail(ctx, error) }
}

/** One wiki page by path (as query_wiki returns it). */
export async function read(ctx: Context) {
  try {
    const path = String((ctx.request.body as any)?.path || ctx.query.path || '').trim()
    if (!path) { ctx.status = 400; ctx.body = { error: 'path is required' }; return }
    ctx.body = { result: await getLlmWikiClient().read(path) }
  } catch (error) { fail(ctx, error) }
}

/** Adds to today's daily note (short-term memory); never to wiki/. */
export async function note(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const section = String(body.section || 'facts') as DailySection
    if (!(section in DAILY_SECTIONS)) { ctx.status = 400; ctx.body = { error: `section must be one of ${Object.keys(DAILY_SECTIONS).join(', ')}` }; return }
    const lines = Array.isArray(body.lines) ? body.lines.map(String) : [String(body.text || '')]
    ctx.body = await getLlmWikiClient().addToDaily(section, lines.slice(0, 20))
  } catch (error) { fail(ctx, error) }
}
