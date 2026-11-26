import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { LlmWikiError, callWikiTool, parseWhoami, wikiBaseUrl, wikiView, type WikiIdentity } from './client'

/**
 * Connections → LLM wiki (docs/llm-wiki.md): the LLM wiki as a Hermes memory
 * provider, set per Hermes profile.
 *
 * - Each profile has its own wiki token in its `.env` (`LLM_WIKI_TOKEN`). Studio
 *   writes it and never sends it back to a browser. A person's profile gets that
 *   person's member token; a household profile gets the shared token. What the
 *   provider can read is what the wiki lets that token read.
 * - The address and the switches are in the profile's config.yaml under
 *   `memory.llm_wiki` (`url`, `recall`, `remember`).
 * - Turning it on installs the provider into `<profile>/plugins/llm_wiki/` and
 *   sets `memory.provider: llm_wiki`. Hermes runs one external memory provider at
 *   a time (its built-in memory stays on), so the one it replaces is kept in
 *   `memory.llm_wiki.previous_provider` and put back when it is turned off.
 */
export const LLM_WIKI_PROVIDER = 'llm_wiki'
export const LLM_WIKI_TOKEN_ENV = 'LLM_WIKI_TOKEN'
/** `memory.provider` values that mean Hermes's built-in memory only (Hermes's own list). */
const BUILTIN_PROVIDERS = new Set(['', 'default', 'builtin', 'built-in', 'none'])

export interface LlmWikiProfileStatus {
  profile: string
  /** memory.provider is llm_wiki */
  enabled: boolean
  url: string
  hasToken: boolean
  recall: boolean
  remember: boolean
  /** memory.provider now ('' = Hermes's built-in memory only) */
  provider: string
  /** the provider LLM wiki replaced, put back when it is turned off */
  previousProvider: string
  /** the provider's files are in the profile's plugins folder */
  installed: boolean
}

export interface LlmWikiStatus {
  profiles: LlmWikiProfileStatus[]
  tokenEnv: string
}

export interface LlmWikiTestResult {
  ok: boolean
  identity: WikiIdentity | null
  view: ReturnType<typeof wikiView>
  error: string
}

export interface LlmWikiDeps {
  profiles: () => string[]
  profileDir: (profile: string) => string
  readConfig: (profile: string) => Promise<Record<string, any>>
  updateConfig: <T = void>(profile: string, updater: (config: Record<string, any>) => any) => Promise<T | undefined>
  saveEnv: (profile: string, key: string, value: string) => Promise<void>
  /** The folder holding the provider's files (plugin.yaml, __init__.py). */
  pluginSource: () => string
  fetcher?: typeof fetch
}

const asObject = (value: unknown): Record<string, any> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {})
const flag = (value: unknown, fallback = true) => (typeof value === 'boolean' ? value : fallback)

/** A value from a dotenv file (the last assignment wins, quotes removed). */
export function readEnvValue(text: string, key: string): string {
  let found = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at === -1 || line.slice(0, at).trim() !== key) continue
    let value = line.slice(at + 1).trim()
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1)
    found = value
  }
  return found
}

export class LlmWikiService {
  constructor(private readonly deps: LlmWikiDeps) {}

  private profileName(value: unknown): string {
    const name = String(value || '').trim()
    if (!name || !this.deps.profiles().includes(name)) throw new LlmWikiError(`There is no Hermes profile called "${name}".`, 404)
    return name
  }

  private token(profile: string): string {
    try { return readEnvValue(readFileSync(join(this.deps.profileDir(profile), '.env'), 'utf8'), LLM_WIKI_TOKEN_ENV) } catch { return '' }
  }

  private pluginDir(profile: string): string {
    return join(this.deps.profileDir(profile), 'plugins', LLM_WIKI_PROVIDER)
  }

  /** Copy the provider into the profile (replacing an older copy). */
  installProvider(profile: string): string {
    const source = this.deps.pluginSource()
    if (!existsSync(join(source, '__init__.py'))) throw new LlmWikiError("Studio's copy of the LLM wiki provider is missing. Reinstall or rebuild Studio.", 500)
    const target = this.pluginDir(profile)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(source)) {
      if (name === '__pycache__') continue
      cpSync(join(source, name), join(target, name), { recursive: true })
    }
    return target
  }

  async profileStatus(profile: string): Promise<LlmWikiProfileStatus> {
    const config = await this.deps.readConfig(profile).catch(() => ({}))
    const memory = asObject(asObject(config).memory)
    const block = asObject(memory.llm_wiki)
    const provider = String(memory.provider || '').trim()
    return {
      profile,
      enabled: provider === LLM_WIKI_PROVIDER,
      url: String(block.url || ''),
      hasToken: !!this.token(profile),
      recall: flag(block.recall),
      remember: flag(block.remember),
      provider: BUILTIN_PROVIDERS.has(provider.toLowerCase()) ? '' : provider,
      previousProvider: String(block.previous_provider || ''),
      installed: existsSync(join(this.pluginDir(profile), '__init__.py')),
    }
  }

  async status(): Promise<LlmWikiStatus> {
    const profiles = await Promise.all(this.deps.profiles().map(name => this.profileStatus(name)))
    return { profiles, tokenEnv: LLM_WIKI_TOKEN_ENV }
  }

  /**
   * Save a profile's settings. `token` is written to the profile's .env and never
   * returned; `clearToken` removes it. `enabled` makes LLM wiki the profile's
   * memory provider (or puts the previous one back).
   */
  async save(profileInput: unknown, input: Record<string, unknown>): Promise<LlmWikiProfileStatus> {
    const profile = this.profileName(profileInput)
    const url = input.url !== undefined ? wikiBaseUrl(input.url) : undefined
    const token = typeof input.token === 'string' ? input.token.trim().replace(/^Bearer\s+/i, '') : ''
    if (token && !/^\S+$/.test(token)) throw new LlmWikiError('A wiki token is one word with no spaces. Copy it again from family-setup.mjs.', 400)
    if (token) await this.deps.saveEnv(profile, LLM_WIKI_TOKEN_ENV, token)
    else if (input.clearToken === true) await this.deps.saveEnv(profile, LLM_WIKI_TOKEN_ENV, '')

    const enable = typeof input.enabled === 'boolean' ? input.enabled : undefined
    if (enable) {
      const current = await this.profileStatus(profile)
      if (!(url ?? current.url) || !this.token(profile)) {
        throw new LlmWikiError("Add the wiki's address and this profile's token before turning it on.", 400)
      }
      this.installProvider(profile)
    }
    await this.deps.updateConfig(profile, (config: Record<string, any>) => {
      const data = asObject(config)
      const memory = asObject(data.memory)
      const block = { ...asObject(memory.llm_wiki) }
      if (url !== undefined) block.url = url
      if (typeof input.recall === 'boolean') block.recall = input.recall
      if (typeof input.remember === 'boolean') block.remember = input.remember
      let provider = String(memory.provider || '').trim()
      if (enable === true && provider !== LLM_WIKI_PROVIDER) {
        if (!BUILTIN_PROVIDERS.has(provider.toLowerCase())) block.previous_provider = provider
        else delete block.previous_provider
        provider = LLM_WIKI_PROVIDER
      } else if (enable === false && provider === LLM_WIKI_PROVIDER) {
        provider = String(block.previous_provider || '')
        delete block.previous_provider
      }
      const nextMemory: Record<string, any> = { ...memory, llm_wiki: block }
      if (provider) nextMemory.provider = provider
      else delete nextMemory.provider
      return { data: { ...data, memory: nextMemory }, result: undefined, write: true }
    })
    return this.profileStatus(profile)
  }

  /** Ask the wiki who a token is (the form's token, or the one saved for the profile). */
  async test(profileInput: unknown, input: Record<string, unknown> = {}): Promise<LlmWikiTestResult> {
    const profile = this.profileName(profileInput)
    const saved = await this.profileStatus(profile)
    const url = input.url !== undefined && String(input.url).trim() ? wikiBaseUrl(input.url) : saved.url
    const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim().replace(/^Bearer\s+/i, '') : this.token(profile)
    try {
      const identity = parseWhoami(await callWikiTool(url, token, 'whoami', {}, this.deps.fetcher))
      if (!identity) return { ok: false, identity: null, view: 'unknown', error: "The wiki answered, but not with who the token is. Update the LLMWIKI MCP Bridge plugin." }
      return { ok: true, identity, view: wikiView(identity), error: '' }
    } catch (error) {
      return { ok: false, identity: null, view: 'unknown', error: error instanceof Error ? error.message : String(error) }
    }
  }
}
