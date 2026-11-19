import { bridgeLogger } from '../../public/logging'
import { normalizeTokenUsage, recordSessionUsage } from './usage-recorder'
import { MIN_GENERATION_SECONDS } from '../../public/generation-time'

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Seconds Hermes spent generating: from the first streamed text or reasoning
 * (noted by Studio's bridge) to the end of the request, so speed matches
 * llama.cpp's. Falls back to Hermes's whole request time when there is no
 * usable first output (nothing streamed, a stale mark from a cancelled request,
 * or under MIN_GENERATION_SECONDS of output).
 */
export function hermesGenerationSeconds(event: Record<string, unknown>): number | undefined {
  const whole = typeof event.api_duration === 'number' && Number.isFinite(event.api_duration) ? event.api_duration : undefined
  const first = Number(event.first_output_at), started = Number(event.started_at), ended = Number(event.ended_at)
  if (event.first_output_at == null || !Number.isFinite(first) || !Number.isFinite(ended)) return whole
  if (Number.isFinite(started) && event.started_at != null && first < started) return whole
  const generating = ended - first
  return generating >= MIN_GENERATION_SECONDS && (whole == null || generating <= whole + 1) ? generating : whole
}

export function recordBridgeModelUsage(
  sessionId: string,
  bridgeRunId: string,
  event: Record<string, unknown>,
  profile: string,
  modelContext: { model?: string | null; provider?: string | null },
): void {
  const usage = normalizeTokenUsage(event.usage)
  if (usage.isEstimated) {
    bridgeLogger.warn({
      sessionId,
      bridgeRunId,
      apiRequestId: event.api_request_id,
    }, '[chat-run-socket] ignoring incomplete Hermes model usage event')
    return
  }

  const apiRequestId = stringValue(event.api_request_id)
  const turnId = stringValue(event.turn_id)
  const apiCallCount = Number(event.api_call_count)
  const fallbackId = turnId && Number.isFinite(apiCallCount)
    ? `${turnId}:${Math.max(0, Math.floor(apiCallCount))}`
    : ''
  const requestKey = apiRequestId || fallbackId
  if (!requestKey) {
    bridgeLogger.warn({ sessionId, bridgeRunId }, '[chat-run-socket] ignoring Hermes model usage event without request identity')
    return
  }

  recordSessionUsage({
    sessionId,
    runId: `${bridgeRunId}:api:${requestKey}`,
    parentRunId: bridgeRunId,
    apiDuration: hermesGenerationSeconds(event),
    source: 'hermes',
    agent: 'hermes',
    usageScope: 'model_call',
    apiCalls: 1,
    usage: event.usage,
    model: stringValue(event.model) || modelContext.model,
    provider: stringValue(event.provider) || modelContext.provider,
    baseUrl: stringValue(event.base_url) || undefined,
    profile,
    isEstimated: false,
  })
}
