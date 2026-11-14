import { hermesAgent } from './agent-api'

/** Hermes Agent's messaging channels, pairing and inbound webhooks (through Studio's passthrough). */

export interface HermesEnvField {
  key: string
  required: boolean
  is_set: boolean
  redacted_value: string | null
  /** Only list fields (allowed users) carry their value; secrets never do. */
  value: string | null
  description: string
  prompt: string
  help: string
  url: string | null
  is_password: boolean
  is_list: boolean
  advanced: boolean
}

export type HermesPlatformState =
  | 'connected' | 'disabled' | 'not_configured' | 'pending_restart' | 'gateway_stopped'
  | 'startup_failed' | 'fatal' | 'error' | 'connecting' | string

export interface HermesPlatform {
  id: string
  name: string
  description: string
  docs_url: string | null
  enabled: boolean
  configured: boolean
  gateway_running: boolean
  state: HermesPlatformState
  error_code: string | null
  error_message: string | null
  updated_at: string | null
  home_channel: unknown
  env_vars: HermesEnvField[]
  disabled_by_relay?: boolean
  relay_fronted?: boolean
  relay_exclusive?: boolean
  ingress_url?: string | null
  whatsapp_setup?: { mode: string; allowed_users_set: boolean; home_channel_set: boolean }
}

export interface HermesPlatformList { env_path: string; gateway_start_command: string; platforms: HermesPlatform[] }
export interface HermesPlatformUpdate { enabled?: boolean; env?: Record<string, string>; clear_env?: string[] }
export interface HermesPlatformTest { ok: boolean; state: string; message: string; auth_posture?: 'open' | 'allowlist' | 'pairing' | 'deny_all' }

export const listHermesPlatforms = () => hermesAgent<HermesPlatformList>('messaging/platforms')
export const updateHermesPlatform = (id: string, body: HermesPlatformUpdate) =>
  hermesAgent<{ ok: boolean; hot_served?: boolean }>(`messaging/platforms/${encodeURIComponent(id)}`, { method: 'PUT', body })
export const testHermesPlatform = (id: string) =>
  hermesAgent<HermesPlatformTest>(`messaging/platforms/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} })

// ── Guided setup ─────────────────────────────────────────────
export interface RestartResult { ok: boolean; needs_restart?: boolean; restart_started?: boolean; bot_username?: string | null }

export interface TelegramOnboardingStartResult { pairing_id: string; suggested_username: string; deep_link: string; qr_payload: string; expires_at: string }
export interface TelegramOnboardingStatus { status: 'waiting' | 'ready'; bot_username?: string | null; owner_user_id?: string | null; expires_at?: string }
export const startTelegramOnboarding = (botName?: string) =>
  hermesAgent<TelegramOnboardingStartResult>('messaging/telegram/onboarding/start', { method: 'POST', body: { bot_name: botName || undefined } })
export const getTelegramOnboarding = (id: string) => hermesAgent<TelegramOnboardingStatus>(`messaging/telegram/onboarding/${encodeURIComponent(id)}`)
export const applyTelegramOnboarding = (id: string, allowedUserIds: string[]) =>
  hermesAgent<RestartResult>(`messaging/telegram/onboarding/${encodeURIComponent(id)}/apply`, { method: 'POST', body: { allowed_user_ids: allowedUserIds } })
export const cancelTelegramOnboarding = (id: string) => hermesAgent(`messaging/telegram/onboarding/${encodeURIComponent(id)}`, { method: 'DELETE' })

export interface WhatsAppOnboarding {
  pairing_id: string
  status: 'starting' | 'waiting' | 'qr' | 'connected' | 'error' | 'expired' | 'cancelled' | string
  qr_payload: string | null
  expires_at: string
  mode: string
  allowed_users: string
  account_id: string | null
  account_name: string | null
  account_phone: string | null
  error: string | null
}
export const startWhatsAppOnboarding = (body: { mode: 'bot' | 'self-chat'; allowed_users?: string; reset_session?: boolean }) =>
  hermesAgent<WhatsAppOnboarding>('messaging/whatsapp/onboarding/start', { method: 'POST', body })
export const getWhatsAppOnboarding = (id: string) => hermesAgent<WhatsAppOnboarding>(`messaging/whatsapp/onboarding/${encodeURIComponent(id)}`)
export const applyWhatsAppOnboarding = (id: string, body: { mode?: string; allowed_users?: string } = {}) =>
  hermesAgent<RestartResult>(`messaging/whatsapp/onboarding/${encodeURIComponent(id)}/apply`, { method: 'POST', body })
export const cancelWhatsAppOnboarding = (id: string) => hermesAgent(`messaging/whatsapp/onboarding/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ── Pairing approvals ────────────────────────────────────────
export interface PairingEntry { platform: string; user_id?: string; user_name?: string; age_minutes?: number; code?: string; request_id?: string; created_at?: number | string; approved_at?: number | string; [key: string]: unknown }
export const listPairing = () => hermesAgent<{ pending: PairingEntry[]; approved: PairingEntry[] }>('pairing')
export const approvePairing = (platform: string, target: { request_id?: string; code?: string }) =>
  hermesAgent<{ ok: boolean }>('pairing/approve', { method: 'POST', body: { platform, ...target } })
export const revokePairing = (platform: string, userId: string) =>
  hermesAgent<{ ok: boolean }>('pairing/revoke', { method: 'POST', body: { platform, user_id: userId } })
export const clearPendingPairing = () => hermesAgent<{ ok: boolean; cleared: number }>('pairing/clear-pending', { method: 'POST', body: {} })

// ── Inbound webhooks ─────────────────────────────────────────
export interface HermesWebhook {
  name: string
  description: string
  events: string[]
  deliver: string
  deliver_only: boolean
  prompt: string
  script: string
  skills: string[]
  created_at: string | null
  url: string
  secret_set: boolean
  enabled: boolean
  secret?: string
}
export interface HermesWebhookCreate {
  name: string
  description?: string
  events?: string[]
  prompt?: string
  skills?: string[]
  deliver?: string
  deliver_only?: boolean
  deliver_chat_id?: string
  secret?: string
}
export const listHermesWebhooks = () => hermesAgent<{ enabled: boolean; base_url: string; subscriptions: HermesWebhook[] }>('webhooks')
export const enableHermesWebhooks = () => hermesAgent<RestartResult>('webhooks/enable', { method: 'POST', body: {} })
export const saveHermesWebhook = (body: HermesWebhookCreate) => hermesAgent<HermesWebhook>('webhooks', { method: 'POST', body })
export const setHermesWebhookEnabled = (name: string, enabled: boolean) =>
  hermesAgent<{ ok: boolean }>(`webhooks/${encodeURIComponent(name)}/enabled`, { method: 'PUT', body: { enabled } })
export const deleteHermesWebhook = (name: string) => hermesAgent<{ ok: boolean }>(`webhooks/${encodeURIComponent(name)}`, { method: 'DELETE' })
