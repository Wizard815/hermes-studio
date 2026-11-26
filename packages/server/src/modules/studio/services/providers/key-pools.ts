import { randomBytes } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { safeFileStore } from '../../public/safe-file-store'
import { importAccountProviders, providerAccountHome, providerAccountId } from './account-store'
import { pooledApiKeyEntries } from './account-pool'

/**
 * API key pools on Studio's account Providers (Models → Key pools).
 *
 * Extra keys live in the account's `auth.json` `credential_pool`, the same
 * shape Hermes Agent used for its own pools, so pools imported from a Hermes
 * profile keep working. The model gateway rotates a Provider's own key and its
 * pooled keys per request, so Hermes, Ekko, coding agents and herdr panes
 * (which all call models through the gateway) share one pool.
 */

export interface PoolEntryView {
  index: number
  id: string
  label: string
  auth_type: string
  source: string
  last_status: string | null
  request_count: number
  token_preview: string
}

const authPath = () => join(providerAccountHome(), 'auth.json')
const preview = (token: string) => token.length <= 8 ? '••••' : `${token.slice(0, 4)}…${token.slice(-4)}`

/** Pool entries that carry their own API key (OAuth and main-key metadata entries do not). */
export const pooledKeyEntries = pooledApiKeyEntries

async function readAuth(): Promise<Record<string, any>> {
  await importAccountProviders()
  try { return JSON.parse(await safeFileStore.readText(authPath()) || '{}') } catch { return {} }
}

async function updateAuth(update: (auth: Record<string, any>) => void): Promise<void> {
  await importAccountProviders()
  const path = authPath()
  await safeFileStore.updateTexts([path], current => {
    const auth = JSON.parse(current[path] || '{}')
    update(auth)
    return { files: { [path]: JSON.stringify(auth, null, 2) }, result: undefined }
  }, { backup: true })
  await chmod(path, 0o600)
}

export async function listKeyPools(): Promise<Array<{ provider: string; entries: PoolEntryView[] }>> {
  const auth = await readAuth()
  const pool = auth.credential_pool && typeof auth.credential_pool === 'object' ? auth.credential_pool : {}
  return Object.entries(pool).flatMap(([provider, entries]) => {
    const list = Array.isArray(entries) ? entries : []
    const views = list.flatMap((entry: any, index: number) => pooledKeyEntries([entry]).length ? [{
      index,
      id: String(entry.id || index),
      label: String(entry.label || ''),
      auth_type: 'api_key',
      source: String(entry.source || ''),
      last_status: entry.last_status ?? null,
      request_count: Number(entry.request_count || 0),
      token_preview: preview(String(entry.access_token)),
    }] : [])
    return views.length ? [{ provider, entries: views }] : []
  })
}

export async function addPoolKey(provider: string, apiKey: string, label = ''): Promise<void> {
  const id = String(provider || '').trim()
  const key = String(apiKey || '').trim()
  if (!id || !key || /[\r\n]/.test(key)) throw Object.assign(new Error('A provider and an API key are required'), { status: 400 })
  await updateAuth(auth => {
    auth.credential_pool = auth.credential_pool && typeof auth.credential_pool === 'object' ? auth.credential_pool : {}
    const entries = Array.isArray(auth.credential_pool[id]) ? auth.credential_pool[id] : []
    if (pooledKeyEntries(entries).some(entry => entry.access_token === key)) throw Object.assign(new Error('This key is already in the pool'), { status: 409 })
    entries.push({ id: randomBytes(4).toString('hex'), label: label.trim() || `key ${pooledKeyEntries(entries).length + 1}`,
      auth_type: 'api_key', source: 'studio-pool', access_token: key, last_status: null, request_count: 0 })
    auth.credential_pool[id] = entries
  })
}

export async function removePoolKey(provider: string, index: number): Promise<void> {
  await updateAuth(auth => {
    const entries = auth.credential_pool?.[provider]
    if (!Array.isArray(entries) || !pooledKeyEntries([entries[index]]).length) throw Object.assign(new Error('Pool key not found'), { status: 404 })
    entries.splice(index, 1)
    if (!entries.length) delete auth.credential_pool[provider]
  })
}

const cursors = new Map<string, number>()
/** The Provider's own key, per account and provider (the gateway passes it on every turn). */
const mainKeys = new Map<string, string>()
/** Keys that hit a rate limit rest until this time (ms), per account and provider. */
const resting = new Map<string, number>()
const restKey = (account: number, provider: string, key: string) => `${account}:${provider}:${key}`

/** How long a rate-limited key rests: the provider's Retry-After, else a minute (capped at 10). */
export function restMs(retryAfter: string | null | undefined, now = Date.now()): number {
  const value = String(retryAfter || '').trim()
  if (/^\d+(\.\d+)?$/.test(value)) return Math.min(600_000, Math.max(1_000, Number(value) * 1000))
  const date = value ? Date.parse(value) : NaN
  if (!Number.isNaN(date)) return Math.min(600_000, Math.max(1_000, date - now))
  return 60_000
}

async function poolKeys(provider: string, apiKey: string | undefined, profile?: string): Promise<{ account: number; keys: string[] } | null> {
  let account: number
  try { account = providerAccountId(profile) } catch { return null }
  let auth: Record<string, any>
  try { auth = JSON.parse(await safeFileStore.readText(join(providerAccountHome(account), 'auth.json')) || '{}') } catch { return null }
  const pooled = pooledKeyEntries(auth.credential_pool?.[provider]).map(entry => String(entry.access_token).trim())
  if (!pooled.length) return null
  // The Provider's own key stays in the pool even when the key that failed was a pooled one.
  const main = mainKeys.get(`${account}:${provider}`)
  return { account, keys: [...new Set([...(main ? [main] : []), ...(apiKey ? [apiKey] : []), ...pooled])] }
}

/**
 * A key hit a rate limit: rest it, and return another pooled key that is not
 * resting and not in `tried` (or undefined when the pool has none left).
 */
export async function failoverPooledApiKey(provider: string, apiKey: string, profile: string | undefined, retryAfter?: string | null, now = Date.now(), tried: ReadonlySet<string> = new Set()): Promise<string | undefined> {
  const pool = await poolKeys(provider, apiKey, profile)
  if (!pool) return undefined
  resting.set(restKey(pool.account, provider, apiKey), now + restMs(retryAfter, now))
  return pool.keys.find(key => key !== apiKey && !tried.has(key) && (resting.get(restKey(pool.account, provider, key)) ?? 0) <= now)
}

/** When the pool's keys are all resting: how many there are and when the first is free again. */
export async function pooledKeysResting(provider: string, apiKey: string, profile?: string, now = Date.now()): Promise<{ keys: number; freeInMs: number } | null> {
  const pool = await poolKeys(provider, apiKey, profile)
  if (!pool) return null
  const until = pool.keys.map(key => resting.get(restKey(pool.account, provider, key)) ?? 0)
  return { keys: pool.keys.length, freeInMs: Math.max(0, Math.min(...until) - now) }
}

/**
 * Send with the key pool's failover: a 429 rests the key and the request moves
 * to the next free key, until one answers or every key is resting; then the
 * caller gets one clear rate-limit error that names the pool.
 */
export async function sendWithKeyPool(input: { provider?: string; apiKey?: string; profile?: string }, send: (apiKey: string | undefined) => Promise<Response>, inAccount: <T>(operation: () => Promise<T>) => Promise<T> = operation => operation()): Promise<Response> {
  let response = await send(input.apiKey)
  if (response.status !== 429 || !input.apiKey || !input.provider) return response
  const provider = input.provider
  let apiKey = input.apiKey
  const tried = new Set([apiKey])
  while (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')
    const current = apiKey
    const next = await inAccount(() => failoverPooledApiKey(provider, current, input.profile, retryAfter, Date.now(), tried)).catch(() => undefined)
    if (!next) {
      const state = await inAccount(() => pooledKeysResting(provider, current, input.profile)).catch(() => null)
      if (!state || state.keys < 2) return response
      await response.body?.cancel().catch(() => undefined)
      const seconds = Math.max(1, Math.ceil(state.freeInMs / 1000))
      return new Response(JSON.stringify({ error: {
        message: `All ${state.keys} API keys for ${provider} are rate-limited (Models → Key pools). The first is free again in ${seconds}s.`,
        type: 'rate_limit_error', code: 'key_pool_exhausted',
      } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(seconds) } })
    }
    await response.body?.cancel().catch(() => undefined)
    tried.add(next)
    apiKey = next
    response = await send(next)
  }
  return response
}

/** The key for the next request: the Provider's own key and its pooled keys in turn. */
export async function nextPooledApiKey(provider: string, apiKey: string | undefined, profile?: string, now = Date.now()): Promise<string | undefined> {
  try { if (apiKey) mainKeys.set(`${providerAccountId(profile)}:${provider}`, apiKey) } catch {}
  const pool = await poolKeys(provider, apiKey, profile)
  if (!pool) return apiKey
  const { account, keys } = pool
  const cursorKey = `${account}:${provider}`
  const start = cursors.get(cursorKey) ?? 0
  // Take turns, skipping keys that are resting after a rate limit (all resting: plain turn).
  for (let step = 0; step < keys.length; step += 1) {
    const index = (start + step) % keys.length
    if ((resting.get(restKey(account, provider, keys[index])) ?? 0) <= now) {
      cursors.set(cursorKey, (index + 1) % keys.length)
      return keys[index]
    }
  }
  cursors.set(cursorKey, (start + 1) % keys.length)
  return keys[start % keys.length]
}
