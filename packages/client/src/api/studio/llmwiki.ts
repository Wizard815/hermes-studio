import { request } from '../client'

export interface LlmWikiSettings { url: string; hasToken: boolean; recall: boolean; saveChats: boolean; fromEnv: boolean }
export interface LlmWikiStatus { connected: boolean; error: string; card: string; settings: LlmWikiSettings }

const base = '/api/studio/llmwiki'

export const fetchLlmWikiStatus = () => request<LlmWikiStatus>(base)

export const saveLlmWikiSettings = (input: { url?: string; token?: string; recall?: boolean; saveChats?: boolean }) =>
  request<LlmWikiSettings>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(input) })

export const searchLlmWiki = (query: string) =>
  request<{ result: string }>(`${base}/search`, { method: 'POST', body: JSON.stringify({ query }) })
