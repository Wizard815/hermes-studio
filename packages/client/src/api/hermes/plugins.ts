import { request } from '../client'

export type PluginConfigStatus = 'enabled' | 'disabled' | 'not-enabled' | 'auto' | 'provider-managed'
export type PluginEffectiveStatus = 'enabled' | 'disabled' | 'inactive' | 'auto-active' | 'provider-managed'

export interface HermesPluginInfo {
  key: string
  name: string
  kind: string
  source: string
  configStatus: PluginConfigStatus | string
  effectiveStatus: PluginEffectiveStatus | string
  version: string
  description: string
  author: string
  path: string
  providesTools: string[]
  providesHooks: string[]
  requiresEnv: Array<string | Record<string, unknown>>
  /** Required env names not set for this profile (empty when all are set). */
  missingEnv?: string[]
}

export interface HermesPluginsMetadata {
  hermesAgentRoot: string
  pythonExecutable: string
  cwd: string
  projectPluginsEnabled: boolean
  envFile?: string
}

export interface HermesPluginsResponse {
  plugins: HermesPluginInfo[]
  warnings: string[]
  metadata: HermesPluginsMetadata
}

export async function fetchPlugins(): Promise<HermesPluginsResponse> {
  return request<HermesPluginsResponse>('/api/hermes/plugins')
}

export async function setPluginEnabled(key: string, enabled: boolean): Promise<{ key: string; enabled: boolean }> {
  return request<{ key: string; enabled: boolean }>(`/api/hermes/plugins/${encodeURIComponent(key)}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
  })
}

export interface RecommendedPluginsInfo {
  /** Catalog names of the official plugins Studio installs and enables once per profile. */
  plugins: string[]
  autoInstall: boolean
  disabledByEnv: boolean
  env: string
  envFile: string
  profile: { done: Record<string, { outcome: string; at: string }>; lastFailure?: Record<string, { at: string; error: string; attempts: number }> } | null
}

export const fetchRecommendedPlugins = () => request<RecommendedPluginsInfo>('/api/hermes/plugins/recommended')

export const setRecommendedAutoInstall = (autoInstall: boolean) =>
  request<{ autoInstall: boolean; disabledByEnv: boolean }>('/api/hermes/plugins/recommended', { method: 'PUT', body: JSON.stringify({ autoInstall }) })
