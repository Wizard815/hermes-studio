import { request } from '../client'

/** One Hermes profile's LLM wiki memory settings. The token is never sent back: only whether there is one. */
export interface LlmWikiProfile {
  profile: string
  enabled: boolean
  url: string
  hasToken: boolean
  recall: boolean
  remember: boolean
  /** memory.provider now ('' = Hermes's built-in memory only) */
  provider: string
  previousProvider: string
  installed: boolean
}

export interface LlmWikiStatus {
  profiles: LlmWikiProfile[]
  tokenEnv: string
}

export interface LlmWikiTestResult {
  ok: boolean
  identity: { name: string; kind: string; id: string } | null
  view: 'own' | 'household' | 'everyone' | 'service' | 'unknown'
  error: string
}

export interface LlmWikiSaveInput {
  url?: string
  token?: string
  clearToken?: boolean
  enabled?: boolean
  recall?: boolean
  remember?: boolean
}

const base = '/api/studio/llm-wiki'
const profilePath = (profile: string) => `${base}/profiles/${encodeURIComponent(profile)}`

export const fetchLlmWikiStatus = () => request<LlmWikiStatus>(base)

export const saveLlmWikiProfile = (profile: string, input: LlmWikiSaveInput) =>
  request<LlmWikiProfile>(profilePath(profile), { method: 'PUT', body: JSON.stringify(input) })

export const testLlmWikiProfile = (profile: string, input: { url?: string; token?: string } = {}) =>
  request<LlmWikiTestResult>(`${profilePath(profile)}/test`, { method: 'POST', body: JSON.stringify(input) })
