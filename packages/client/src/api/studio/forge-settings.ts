import { request } from '../client'

/** Settings → Git forges (docs/forge.md): GitHub or the homelab's Forgejo/Gitea, saved in the Hermes profile. */

export interface ForgeSettingsView {
  profile: string
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
  url: string
  hosts: string
  defaultHome: string
  githubOwner: string
  jobsRepo: string
  token?: string
  clearToken?: boolean
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

export const fetchForgeSettings = () => request<ForgeSettingsView>('/api/studio/forge/settings')
export const saveForgeSettings = (input: ForgeSettingsInput) => request<ForgeSettingsView>('/api/studio/forge/settings', json('PUT', input))
export const testForge = (input: { url?: string; token?: string }) =>
  request<{ ok: true; url: string; login: string; version: string }>('/api/studio/forge/test', json('POST', input))
