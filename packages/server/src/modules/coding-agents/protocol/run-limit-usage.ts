import { observeGatewayRunUsage } from '../../studio/public/run-limits'
import { normalizeTokenUsage } from '../../studio/public/usage'
import type { AgentTargetInput } from './target-registry'
import type { CanonicalResponsesEvent } from './adapters/responses-stream'

/**
 * Tokens of a response that passed through the gateway, for run limits
 * (docs/agent-limits.md). Studio's own runs count their recorded usage; this
 * covers agents in herdr panes that only the gateway sees.
 */
export function reportRunLimitUsage(target: AgentTargetInput, event: CanonicalResponsesEvent): void {
  if (!target.chatSessionId || !['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) return
  try {
    const final = (event.data as any)?.response || event.data
    if (!final?.usage) return
    const usage = normalizeTokenUsage(final.usage, {}, { inputIncludesCache: target.apiMode !== 'anthropic_messages' })
    if (usage.isEstimated) return
    observeGatewayRunUsage({ sessionId: target.chatSessionId, provider: target.provider, model: final.model || target.model, usage })
  } catch { /* limits never break the response */ }
}
