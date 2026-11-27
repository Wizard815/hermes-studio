/**
 * The homelab's own Git forge (Forgejo or Gitea), beside GitHub
 * (docs/forge.md). Set on the Studio host:
 *
 *   FORGE_URL    the forge's address, e.g. http://192.168.20.5:3030
 *   FORGE_TOKEN  an access token there (read:repository, read:issue, read:user
 *                is enough for the board and the Inbox; cloning private repos
 *                needs read:repository)
 *   FORGE_HOSTS  other addresses of the same forge, comma separated
 *                (host or host:port), e.g. forgejo:3000
 *
 * The token goes only to the forge's own addresses, never to GitHub.
 */

export interface ForgeConfig {
  url: string
  token: string
  /** host or host:port values that mean "the forge". */
  hosts: Set<string>
}

const netloc = (value: string): string => {
  try {
    const parsed = new URL(value.includes('://') ? value : `http://${value}`)
    return parsed.host.toLowerCase()
  } catch {
    return ''
  }
}

export function forgeConfig(env: NodeJS.ProcessEnv = process.env): ForgeConfig | null {
  const url = String(env.FORGE_URL || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/\s]+/i.test(url)) return null
  const hosts = new Set([netloc(url), ...String(env.FORGE_HOSTS || '').split(',').map(item => netloc(item.trim())).filter(Boolean)])
  hosts.delete('')
  return { url, token: String(env.FORGE_TOKEN || '').trim(), hosts }
}

/** The path the forge is served under ('' at the root, '/git' behind a proxy at /git). */
const prefix = (config: ForgeConfig) => new URL(config.url).pathname.replace(/\/+$/, '')

/** True when `url` (http(s), ssh:// or git@host:path) points at the forge. */
export function onForge(url: string, config: ForgeConfig | null): boolean {
  if (!config) return false
  const names = new Set([...config.hosts].map(host => host.split(':')[0]))
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(url)
  if (scp && !url.includes('://')) return names.has(scp[1].toLowerCase())
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'ssh:') return names.has(parsed.hostname.toLowerCase())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return config.hosts.has(parsed.host.toLowerCase())
  } catch {
    return false
  }
}

/** owner, repo and number of a forge pull request link, else null. */
export function forgePr(link: string, config: ForgeConfig | null): { owner: string; repo: string; number: number } | null {
  if (!config || !onForge(link.trim(), config)) return null
  let path: string
  try { path = new URL(link.trim()).pathname } catch { return null }
  const base = prefix(config)
  if (base && path.startsWith(`${base}/`)) path = path.slice(base.length)
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pulls\/(\d+)(?:\/.*)?$/.exec(path)
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null
}

/**
 * Git config through the environment that sends the token to the forge's
 * http(s) addresses only (never on the command line or into .git/config).
 */
export function forgeGitEnv(config: ForgeConfig | null): Record<string, string> {
  if (!config?.token) return {}
  const env: Record<string, string> = {}
  let index = 0
  for (const host of [...config.hosts].sort()) {
    for (const scheme of ['http', 'https']) {
      env[`GIT_CONFIG_KEY_${index}`] = `http.${scheme}://${host}/.extraheader`
      env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: token ${config.token}`
      index++
    }
  }
  env.GIT_CONFIG_COUNT = String(index)
  return env
}

export type ForgeFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

/** GET a forge API path (`/repos/o/r/...`); throws with a plain reason on failure. */
export async function forgeGet(config: ForgeConfig, path: string, fetcher: ForgeFetch = globalThis.fetch as unknown as ForgeFetch): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.token) headers.Authorization = `token ${config.token}`
  let response
  try {
    response = await fetcher(`${config.url}/api/v1${path}`, { headers })
  } catch {
    throw new Error(`The forge at ${config.url} isn't answering. Check that its container is running and FORGE_URL is right.`)
  }
  if (!response.ok) {
    throw new Error(response.status === 404 ? 'The forge has no such item, or FORGE_TOKEN cannot see it'
      : response.status === 401 || response.status === 403 ? 'The forge refused FORGE_TOKEN: make a new token with read access'
        : `The forge answered ${response.status}`)
  }
  return response.json()
}
