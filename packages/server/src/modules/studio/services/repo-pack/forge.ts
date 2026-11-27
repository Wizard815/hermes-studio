import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getActiveProfileName, getProfileDir, readConfigYamlForProfile } from '../../public/profile-config'
import { readEnvValue } from '../llm-wiki/service'

/**
 * The family's Forgejo (the same shape every homelab app uses): the address in
 * the Hermes profile's config.yaml as skills.config.forgejo.url, the token as
 * FORGE_TOKEN in the profile's .env, other addresses of the same forge in
 * FORGE_HOSTS (comma separated). The token goes only to forge addresses, as a
 * one-off git header, never in a URL or argv.
 */

export interface ForgeSettings { url: string; token: string; hosts: string[] }

export async function loadForgeSettings(profile = getActiveProfileName() || 'default'): Promise<ForgeSettings | null> {
  const config = await readConfigYamlForProfile(profile).catch(() => ({} as Record<string, any>))
  const url = String(config?.skills?.config?.forgejo?.url || '').trim().replace(/\/+$/, '')
  if (!url) return null
  const env = await readFile(join(getProfileDir(profile), '.env'), 'utf8').catch(() => '')
  const token = readEnvValue(env, 'FORGE_TOKEN') || process.env.FORGE_TOKEN || ''
  const hosts = (readEnvValue(env, 'FORGE_HOSTS') || process.env.FORGE_HOSTS || '').split(',').map(host => host.trim()).filter(Boolean)
  return { url, token, hosts }
}

/** The forge address a URL is on (its own origin), or null. github.com is never the forge. */
export function forgeOrigin(target: URL, forge: ForgeSettings | null): string | null {
  if (!forge || target.hostname === 'github.com') return null
  let own: URL
  try { own = new URL(forge.url) } catch { return null }
  const candidates = [own.host, ...forge.hosts.map(host => host.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))]
  const match = candidates.some(host => target.host === host || (target.protocol === 'https:' && target.hostname === host.split(':')[0]))
  return match ? target.origin : null
}

export function forgeGitEnv(origin: string, token: string): Record<string, string> {
  if (!token) return {}
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: token ${token}`,
    GIT_TERMINAL_PROMPT: '0',
  }
}

export const maskToken = (text: string, token: string) => token ? text.split(token).join('***') : text
