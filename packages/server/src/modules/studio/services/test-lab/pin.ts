/**
 * Test Lab model pin (docs/test-lab.md): while a run is active, the model
 * gateway answers its credential only for the one model picked for the run.
 * Any other model (in the request body or the credential's target) is refused,
 * so the agent cannot switch to a more expensive one.
 */

export interface ModelPin { provider: string; model: string; routeId: string }

const pins = new Map<string, ModelPin>()

export const testLabSessionId = (runId: string) => `testlab-${runId}`

export function pinModel(sessionId: string, pin: ModelPin): void { pins.set(sessionId, pin) }
export function unpinModel(sessionId: string): void { pins.delete(sessionId) }
export function modelPin(sessionId: string | undefined): ModelPin | undefined { return sessionId ? pins.get(sessionId) : undefined }

/** Is a requested model the pinned one? Accepts the bare model, the catalog id (`provider/model`) or nothing. */
export function samePinnedModel(pin: ModelPin, requested: unknown): boolean {
  if (requested === undefined || requested === null || requested === '') return true
  if (typeof requested !== 'string') return false
  const value = requested.trim()
  return value === pin.model || value === pin.routeId || value === `${pin.provider}/${pin.model}`
}

/** null when the request may pass; otherwise the refusal message. */
export function checkModelPin(binding: { sessionId?: string; provider?: string; model?: string }, body: unknown): string | null {
  const pin = modelPin(binding.sessionId)
  if (!pin) {
    // A Test Lab credential whose run has ended has no pin: nothing may pass.
    return binding.sessionId?.startsWith('testlab-') ? 'This Test Lab run has ended' : null
  }
  if ((binding.provider && binding.provider !== pin.provider) || (binding.model && binding.model !== pin.model)) {
    return `This Test Lab run is pinned to ${pin.routeId}`
  }
  const requested = body && typeof body === 'object' ? (body as Record<string, unknown>).model : undefined
  if (!samePinnedModel(pin, requested)) return `This Test Lab run is pinned to ${pin.routeId}; ${String(requested).slice(0, 120)} is not allowed`
  return null
}
