import type { HermesEnvField, HermesPlatform, HermesPlatformUpdate } from '@/api/hermes/channels'

/**
 * Settings Studio's own channel cards already edit (same .env keys). The Hermes
 * panel inside those cards leaves them out so no field shows up twice.
 */
export const STUDIO_CARD_ENV_KEYS: Record<string, string[]> = {
  telegram: ['TELEGRAM_BOT_TOKEN'],
  discord: ['DISCORD_BOT_TOKEN'],
  slack: ['SLACK_BOT_TOKEN'],
  whatsapp: ['WHATSAPP_ENABLED'],
  matrix: ['MATRIX_ACCESS_TOKEN', 'MATRIX_HOMESERVER', 'MATRIX_USER_ID', 'MATRIX_PASSWORD'],
  feishu: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ENCRYPT_KEY', 'FEISHU_VERIFICATION_TOKEN'],
  dingtalk: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_ALLOWED_USERS'],
  qqbot: ['QQ_APP_ID', 'QQ_CLIENT_SECRET', 'QQ_ALLOWED_USERS'],
  weixin: ['WEIXIN_TOKEN', 'WEIXIN_ACCOUNT_ID'],
  wecom: ['WECOM_BOT_ID', 'WECOM_SECRET'],
}

/** Platforms with their own Studio card (rendered by PlatformSettings). */
export const STUDIO_CARD_PLATFORMS = Object.keys(STUDIO_CARD_ENV_KEYS)

/** Hermes platforms shown in their own section instead of as a channel card. */
export const NON_CARD_PLATFORMS = ['webhook']

/** Hermes platforms that need Studio's own card list skipped: everything else gets a generic card. */
export function extraPlatforms(platforms: HermesPlatform[]): HermesPlatform[] {
  return platforms
    .filter(p => !STUDIO_CARD_PLATFORMS.includes(p.id) && !NON_CARD_PLATFORMS.includes(p.id))
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || a.name.localeCompare(b.name))
}

export function isActive(p: HermesPlatform): boolean {
  return p.enabled || p.configured || p.env_vars.some(f => f.is_set)
}

/** Fields the panel shows for a platform: Studio-card keys left out, then split basic / advanced. */
export function panelFields(p: HermesPlatform, hideStudioKeys: boolean): { basic: HermesEnvField[]; advanced: HermesEnvField[] } {
  const hidden = hideStudioKeys ? STUDIO_CARD_ENV_KEYS[p.id] || [] : []
  const fields = p.env_vars.filter(f => !hidden.includes(f.key))
  return {
    basic: fields.filter(f => !f.advanced && (f.required || f.is_list || !optionalNoise(f))),
    advanced: fields.filter(f => f.advanced || (!f.required && !f.is_list && optionalNoise(f))),
  }
}

/** Optional tuning knobs (ports, hosts, paths, …) go behind "More settings". */
function optionalNoise(f: HermesEnvField): boolean {
  return /_(PORT|HOST|PATH|API_VERSION|BASE_URL|CDN_BASE_URL|NODE_BIN|CLI_PATH|TELEMETRY|POLL_INTERVAL|TRANSPORT|SIDECAR_[A-Z_]+|AUTHSERV_ID|DASHBOARD_HOST|SPECTRUM_HOST|SLOW_RESPONSE_THRESHOLD|CREDENTIALS_FILE)$/.test(f.key)
}

/**
 * Body for PUT messaging/platforms/{id}. Drafts hold what the user typed; Hermes
 * only sends back list values (allowed users), so a blank draft keeps any other
 * field and clears a list that was set. `clears` are explicit "remove" clicks.
 */
export function buildPlatformUpdate(
  fields: HermesEnvField[], drafts: Record<string, string | undefined>, clears: string[], enabled?: boolean,
): HermesPlatformUpdate {
  const env: Record<string, string> = {}
  const clearEnv = new Set(clears)
  for (const field of fields) {
    if (clearEnv.has(field.key)) continue
    const draft = drafts[field.key]
    if (draft === undefined) continue
    const value = draft.trim()
    if (value) {
      if (!field.is_list || value !== (field.value ?? '')) env[field.key] = value
    } else if (field.is_list && field.is_set) {
      clearEnv.add(field.key)
    }
  }
  const body: HermesPlatformUpdate = {}
  if (enabled !== undefined) body.enabled = enabled
  if (Object.keys(env).length) body.env = env
  if (clearEnv.size) body.clear_env = [...clearEnv]
  return body
}

export function hasUpdate(body: HermesPlatformUpdate): boolean {
  return body.enabled !== undefined || !!body.env || !!body.clear_env
}

export type TagType = 'success' | 'warning' | 'error' | 'info' | 'default'

export function stateTagType(state: string): TagType {
  if (state === 'connected') return 'success'
  if (state === 'pending_restart' || state === 'gateway_stopped' || state === 'connecting' || state === 'not_configured') return 'warning'
  if (state === 'startup_failed' || state === 'fatal' || state === 'error' || state === 'retrying') return 'error'
  if (state === 'disabled') return 'default'
  return 'info'
}

/** Translation key under hermesChannels.state for a Hermes platform state. */
export function stateKey(state: string): string {
  const known = ['connected', 'disabled', 'not_configured', 'pending_restart', 'gateway_stopped', 'startup_failed', 'connecting']
  if (known.includes(state)) return state
  if (state === 'fatal' || state === 'error' || state === 'retrying') return 'error'
  return 'unknown'
}

/** "API Error 400: detail" → "detail". */
export function cleanError(err: unknown, fallback = ''): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return message.replace(/^API Error \d+:\s*/, '') || fallback
}

/** Split "123, 456\n789" into unique ids. */
export function splitIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean))]
}

/** Valid inbound webhook route name, normalised the way Hermes does. */
export function normalizeWebhookName(name: string): string | null {
  const normalized = name.trim().toLowerCase().replace(/ /g, '-')
  return /^[a-z0-9][a-z0-9_-]*$/.test(normalized) ? normalized : null
}

/** Hermes reports routes on localhost; outside callers need this server's own address. */
export function publicWebhookUrl(url: string, hostname: string): string {
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') return url
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\])(?=[:/])/, `$1${host}`)
}

/** Delivery targets for a webhook route: the log plus every channel that is set up. */
export function deliveryTargets(platforms: HermesPlatform[]): string[] {
  return ['log', ...platforms.filter(p => p.configured && !NON_CARD_PLATFORMS.includes(p.id) && p.id !== 'api_server').map(p => p.id)]
}
