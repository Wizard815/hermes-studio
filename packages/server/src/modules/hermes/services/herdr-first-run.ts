import { updateConfigYamlForProfile } from './profiles/config'

/**
 * `hermes chat` in a new profile first asks whether to share usage metrics
 * with Nous ("Help improve Hermes?"), before the chat. In a herdr pane that
 * Studio opened for a chat, that question stands between the user and the
 * chat. Studio answers it the way Hermes's own default does, "No thanks"
 * (nothing is collected or sent), in the profile's config.yaml, only when the
 * profile never answered. `hermes setup telemetry` changes it.
 *
 * Hermes reads `telemetry.shared_metrics.{enabled,send,offer_version}`; an
 * answer without `offer_version` 2 is asked again, so that is written too.
 */
export const HERMES_METRICS_OFFER_VERSION = 2

export function hermesMetricsUndecided(config: Record<string, any> | null | undefined): boolean {
  const section = config?.telemetry?.shared_metrics
  if (!section || typeof section !== 'object') return true
  const answered = 'enabled' in section || 'send' in section
  const reask = answered && section.enabled !== true && section.offer_version !== HERMES_METRICS_OFFER_VERSION
  return !answered || reask
}

export function withHermesMetricsDeclined(config: Record<string, any>): Record<string, any> {
  const telemetry = config.telemetry && typeof config.telemetry === 'object' && !Array.isArray(config.telemetry) ? config.telemetry : {}
  const section = telemetry.shared_metrics && typeof telemetry.shared_metrics === 'object' ? telemetry.shared_metrics : {}
  return { ...config, telemetry: { ...telemetry, shared_metrics: { ...section, enabled: false, send: false, offer_version: HERMES_METRICS_OFFER_VERSION } } }
}

/** Answer Hermes's metrics question for a profile that never answered it. True when it wrote. */
export async function answerHermesFirstRun(profile: string): Promise<boolean> {
  const wrote = await updateConfigYamlForProfile<boolean>(profile || 'default', (current) => {
    const config = current && typeof current === 'object' ? current : {}
    if (!hermesMetricsUndecided(config)) return { data: config, result: false, write: false }
    return { data: withHermesMetricsDeclined(config), result: true }
  })
  return wrote === true
}
