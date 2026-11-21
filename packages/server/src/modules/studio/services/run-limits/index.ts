import { RunLimitService, type GatewayRefusal, type GatewayRequestInput, type GatewayUsage, type RunLimitDeps } from './service'

/** Process-wide run limits; bootstrap/run-limits.ts wires it to chat runs, herdr and Mattermost. */
let service: RunLimitService | null = null

export function configureRunLimits(deps: RunLimitDeps): RunLimitService {
  service?.close()
  service = new RunLimitService(deps)
  service.start()
  return service
}

export function getRunLimits(): RunLimitService {
  if (!service) throw Object.assign(new Error('Run limits are not set up'), { status: 503 })
  return service
}

export function closeRunLimits(): void {
  service?.close()
  service = null
}

/** A chat run's event (tool calls, run start and end). No-op until configured. */
export function observeRunLimitEvent(sessionId: string, event: string, payload?: Record<string, any>): void {
  service?.observeEvent(sessionId, event, payload)
}

export function checkGatewayRunLimits(input: GatewayRequestInput): GatewayRefusal | null {
  return service?.checkGatewayRequest(input) ?? null
}

export function observeGatewayRunUsage(input: { sessionId?: string; provider?: string; model?: string; usage: GatewayUsage }): void {
  service?.observeGatewayUsage(input)
}

export { RunLimitService, describeHit, formatLimitValue } from './service'
export { RunLimitSettingsStore } from './settings'
export type { GatewayRefusal, GatewayUsage, RunLimitDeps } from './service'
