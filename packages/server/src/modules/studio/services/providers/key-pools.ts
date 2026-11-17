import { randomBytes } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { safeFileStore } from '../../public/safe-file-store'
import { importAccountProviders, providerAccountHome, providerAccountId } from './account-store'

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
export function pooledKeyEntries(entries: unknown): Array<Record<string, any>> {
  if (!Array.isArray(entries)) return []
  return entries.filter((entry): entry is Record<string, any> => !!entry && typeof entry === 'object'
    && entry.auth_type === 'api_key' && typeof entry.access_token === 'string' && !!entry.access_token.trim())
}

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

/** The key for the next request: the Provider's own key and its pooled keys in turn. */
export async function nextPooledApiKey(provider: string, apiKey: string | undefined, profile?: string): Promise<string | undefined> {
  let account: number
  try { account = providerAccountId(profile) } catch { return apiKey }
  let auth: Record<string, any>
  try { auth = JSON.parse(await safeFileStore.readText(join(providerAccountHome(account), 'auth.json')) || '{}') } catch { return apiKey }
  const pooled = pooledKeyEntries(auth.credential_pool?.[provider]).map(entry => String(entry.access_token).trim())
  if (!pooled.length) return apiKey
  const keys = [...new Set([...(apiKey ? [apiKey] : []), ...pooled])]
  const cursorKey = `${account}:${provider}`
  const next = cursors.get(cursorKey) ?? 0
  cursors.set(cursorKey, (next + 1) % keys.length)
  return keys[next % keys.length]
}
