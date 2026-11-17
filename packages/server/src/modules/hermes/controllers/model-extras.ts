import type { Context } from 'koa'
import { addPoolKey, listKeyPools, removePoolKey } from '../../studio/public/provider-key-pools'
import { describeLocalProvider, syncHermesLocalProvider } from '../services/models/local-provider'
import { requestScopedProfileName } from './models'

function fail(ctx: Context, error: any) {
  ctx.status = Number(error?.status) || 500
  ctx.body = { error: error?.message || String(error) }
}

/** Models → Key pools: extra API keys on the account's Providers, rotated by the model gateway. */
export async function getKeyPools(ctx: Context) {
  try { ctx.body = { providers: await listKeyPools() } } catch (error) { fail(ctx, error) }
}

export async function postKeyPool(ctx: Context) {
  const body = (ctx.request.body || {}) as { provider?: string; api_key?: string; label?: string }
  try { await addPoolKey(String(body.provider || ''), String(body.api_key || ''), String(body.label || '')); ctx.body = { success: true } } catch (error) { fail(ctx, error) }
}

export async function deleteKeyPool(ctx: Context) {
  const index = Number((ctx.params as any).index)
  if (!Number.isSafeInteger(index) || index < 0) { ctx.status = 400; ctx.body = { error: 'Invalid key index' }; return }
  try { await removePoolKey(decodeURIComponent(String((ctx.params as any).provider || '')), index); ctx.body = { success: true } } catch (error) { fail(ctx, error) }
}

/** Models → Local models: Hermes's llama.cpp server as the gateway Provider `custom:hermes-local`. */
export async function getLocalProvider(ctx: Context) {
  try { ctx.body = await describeLocalProvider(requestScopedProfileName(ctx)) } catch (error) { fail(ctx, error) }
}

export async function postLocalProvider(ctx: Context) {
  const body = (ctx.request.body || {}) as { default_model?: string }
  const model = typeof body.default_model === 'string' ? body.default_model.trim() : ''
  try { ctx.body = await syncHermesLocalProvider(requestScopedProfileName(ctx), model || undefined) } catch (error) { fail(ctx, error) }
}
