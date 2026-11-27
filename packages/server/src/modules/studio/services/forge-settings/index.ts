import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getActiveProfileName, getProfileDir, readConfigYamlForProfile, saveEnvValueForProfile, updateConfigYamlForProfile,
} from '../../public/profile-config'
import { readEnvValue } from '../llm-wiki/service'

/**
 * Settings → Git forges (docs/forge.md): where repos go (GitHub or the
 * homelab's Forgejo/Gitea) and how to reach the forge. Saved in the active
 * Hermes profile, so Hermes's forgejo skill and Studio read the same values:
 * config.yaml skills.config.forgejo.{url, default_home, github_owner, jobs_repo}
 * and the profile's .env FORGE_TOKEN and FORGE_HOSTS.
 */

export interface ForgeSettingsView {
  profile: string
  /** 'host' when FORGE_URL is set on the Studio host: it wins over the profile for Studio. */
  source: 'host' | 'profile' | 'none'
  hostUrl: string
  url: string
  hosts: string[]
  defaultHome: '' | 'forge' | 'github'
  githubOwner: string
  jobsRepo: string
  tokenSet: boolean
  github: { tokenSet: boolean }
}

export interface ForgeSettingsInput {
  url?: string
  hosts?: string[] | string
  defaultHome?: string
  githubOwner?: string
  jobsRepo?: string
  /** A new token; empty or missing keeps the saved one. */
  token?: string
  clearToken?: boolean
}

export interface ForgeSettingsDeps {
  profile: () => string
  readConfig: (profile: string) => Promise<Record<string, any>>
  updateConfig: (profile: string, updater: (config: Record<string, any>) => any) => Promise<unknown>
  readEnv: (profile: string) => Promise<string>
  saveEnv: (profile: string, key: string, value: string) => Promise<void>
  githubToken: () => Promise<string>
  fetch: typeof fetch
  env: NodeJS.ProcessEnv
  /** Called after a save, so Studio uses the new values now (refreshForgeFromProfile). */
  changed: () => Promise<void>
}

export class ForgeSettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const home = (value: unknown): ForgeSettingsView['defaultHome'] => {
  const v = String(value || '').trim().toLowerCase()
  return v === 'forge' || v === 'github' ? v : ''
}

function cleanUrl(value: unknown): string {
  const url = String(value || '').trim().replace(/\/+$/, '')
  if (!url) return ''
  if (!/^https?:\/\/[^/\s?#]+(\/[^\s?#]*)?$/i.test(url)) throw new ForgeSettingsError('The forge address starts with http:// or https://, e.g. http://192.168.20.5:3030')
  return url
}

function cleanHosts(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value || '').split(',')
  const hosts = list.map(item => String(item).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean)
  for (const host of hosts) if (!/^[\w.-]+(:\d{1,5})?$/.test(host)) throw new ForgeSettingsError(`Other addresses are host or host:port, e.g. forgejo:3000 (not ${host})`)
  return [...new Set(hosts)]
}

export class ForgeSettingsService {
  constructor(private readonly deps: ForgeSettingsDeps) {}

  async read(): Promise<ForgeSettingsView> {
    const profile = this.deps.profile()
    const config = await this.deps.readConfig(profile).catch(() => ({} as Record<string, any>))
    const forgejo = config?.skills?.config?.forgejo || {}
    const env = await this.deps.readEnv(profile).catch(() => '')
    const hostUrl = String(this.deps.env.FORGE_URL || '').trim()
    const url = String(forgejo.url || '').trim()
    return {
      profile,
      source: hostUrl ? 'host' : url ? 'profile' : 'none',
      hostUrl,
      url,
      hosts: cleanHostsSafe(readEnvValue(env, 'FORGE_HOSTS')),
      defaultHome: home(forgejo.default_home),
      githubOwner: String(forgejo.github_owner || ''),
      jobsRepo: String(forgejo.jobs_repo || ''),
      tokenSet: !!readEnvValue(env, 'FORGE_TOKEN'),
      github: { tokenSet: !!(await this.deps.githubToken().catch(() => '')) },
    }
  }

  async save(input: ForgeSettingsInput): Promise<ForgeSettingsView> {
    const profile = this.deps.profile()
    const url = cleanUrl(input.url)
    const hosts = cleanHosts(input.hosts)
    const defaultHome = home(input.defaultHome)
    const githubOwner = String(input.githubOwner || '').trim()
    if (githubOwner && !/^[\w.-]{1,39}$/.test(githubOwner)) throw new ForgeSettingsError('GitHub owner is a user or organization name, e.g. Wizard815')
    const jobsRepo = String(input.jobsRepo || '').trim()
    if (jobsRepo && !/^[\w.-]+\/[\w.-]+$/.test(jobsRepo)) throw new ForgeSettingsError('Jobs repo is OWNER/REPO on the forge, or blank')
    const token = String(input.token || '').trim()
    if (/\s/.test(token)) throw new ForgeSettingsError('The token has spaces in it: paste only the token')
    await this.deps.updateConfig(profile, (config) => {
      config.skills ||= {}
      config.skills.config ||= {}
      const forgejo = { ...(config.skills.config.forgejo || {}) }
      const set = (key: string, value: string) => { if (value) forgejo[key] = value; else delete forgejo[key] }
      set('url', url); set('default_home', defaultHome); set('github_owner', githubOwner); set('jobs_repo', jobsRepo)
      if (Object.keys(forgejo).length) config.skills.config.forgejo = forgejo
      else delete config.skills.config.forgejo
      return config
    })
    await this.deps.saveEnv(profile, 'FORGE_HOSTS', hosts.join(','))
    if (token) await this.deps.saveEnv(profile, 'FORGE_TOKEN', token)
    else if (input.clearToken) await this.deps.saveEnv(profile, 'FORGE_TOKEN', '')
    await this.deps.changed().catch(() => undefined)
    return this.read()
  }

  /** Asks the forge who the token is (given values first, else the saved ones). */
  async test(input: { url?: string; token?: string } = {}): Promise<{ ok: true; url: string; login: string; version: string }> {
    const profile = this.deps.profile()
    const saved = await this.read()
    const url = cleanUrl(input.url) || saved.url || saved.hostUrl
    if (!url) throw new ForgeSettingsError('Give the forge address first')
    const token = String(input.token || '').trim() || readEnvValue(await this.deps.readEnv(profile).catch(() => ''), 'FORGE_TOKEN') || String(this.deps.env.FORGE_TOKEN || '')
    const get = async (path: string, auth: boolean) => {
      try {
        return await this.deps.fetch(`${url}/api/v1${path}`, { headers: auth && token ? { Authorization: `token ${token}` } : {}, signal: AbortSignal.timeout(8000) })
      } catch (error) {
        throw new ForgeSettingsError(`The forge at ${url} isn't answering (${(error as Error).message}). Check the address and that the forge is running.`, 502)
      }
    }
    // With the token: a forge with REQUIRE_SIGNIN_VIEW answers 403 to anonymous requests, even /version.
    const versionRes = await get('/version', true)
    if (versionRes.status === 401 || versionRes.status === 403) {
      throw new ForgeSettingsError(token
        ? 'The forge refused the token: it is wrong, expired, or lacks read:user'
        : 'The forge only answers signed-in requests: save a token (Settings > Applications on the forge)', 401)
    }
    if (!versionRes.ok) throw new ForgeSettingsError(`${url} answered ${versionRes.status}: is it a Forgejo or Gitea address?`, 502)
    const version = String((await versionRes.json().catch(() => ({})))?.version || '')
    if (!token) throw new ForgeSettingsError(`The forge answers (version ${version || '?'}), but no token is saved: make one under Settings > Applications on the forge`)
    const userRes = await get('/user', true)
    if (userRes.status === 401 || userRes.status === 403) throw new ForgeSettingsError('The forge refused the token: it is wrong, expired, or lacks read:user', 401)
    if (!userRes.ok) throw new ForgeSettingsError(`The forge answered ${userRes.status} for the token check`, 502)
    const login = String((await userRes.json().catch(() => ({})))?.login || '')
    return { ok: true, url, login, version }
  }
}

function cleanHostsSafe(value: string): string[] {
  try { return cleanHosts(value) } catch { return [] }
}

let instance: ForgeSettingsService | null = null

export function getForgeSettings(): ForgeSettingsService {
  instance ||= new ForgeSettingsService({
    profile: () => getActiveProfileName() || 'default',
    readConfig: readConfigYamlForProfile,
    updateConfig: updateConfigYamlForProfile,
    readEnv: profile => readFile(join(getProfileDir(profile), '.env'), 'utf8'),
    saveEnv: saveEnvValueForProfile,
    githubToken: async () => (await import('../repo-pack')).githubToken(),
    fetch: (...args) => fetch(...args),
    env: process.env,
    changed: async () => (await import('../forge')).refreshForgeFromProfile(),
  })
  return instance
}
