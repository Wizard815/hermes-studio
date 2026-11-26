import type { Context, Next } from 'koa'
import { gatewayProtocol, gatewayToken, modelGatewayAdapters, type ModelGatewayProtocol } from '../public/model-gateway-adapters'
import { withProviderAccount } from '../public/provider-account'
import { findUserById, userCanAccessProfile } from '../public/users'
import { toAuthenticatedUser } from './auth'
import { checkGatewayRunLimits } from '../services/run-limits'
import { checkModelPin } from '../services/test-lab/pin'

/** The error each protocol's clients understand; 400 so agents show it and end the turn instead of retrying. */
export function gatewayRefusalBody(protocol: ModelGatewayProtocol, message: string): Record<string, unknown> {
  if (protocol === 'anthropic_messages') return { type: 'error', error: { type: 'invalid_request_error', message } }
  if (protocol === 'gemini_contents') return { error: { code: 400, message, status: 'FAILED_PRECONDITION' } }
  return { error: { message, type: 'invalid_request_error', code: 'studio_run_limit' } }
}

/** Run-scoped model credentials authenticate only inference, never management. */
export async function modelGatewayMiddleware(ctx: Context, next: Next): Promise<void> {
  // Read-only compatibility for previously generated CLI configuration files.
  const path = ctx.path.replace(/^\/api\/(?:codex-proxy|claude-code-proxy)\/[^/]+(?=\/)/, '/api/ekko-studio/models')
  const protocol = ctx.method === 'POST' ? gatewayProtocol(path) : undefined
  const listing = ctx.method === 'GET' && path === '/api/ekko-studio/models/v1/models'
  if (!protocol && !listing) return next()
  const binding = modelGatewayAdapters().authenticate(gatewayToken(ctx))
  if (!binding) return next()
  const user = findUserById(binding.userId)
  if (user?.status !== 'active' || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, binding.profile))) { ctx.status = 403; ctx.body = { error: 'Model credential owner is unavailable' }; return }
  ctx.state.user = toAuthenticatedUser(user)
  ctx.state.profile = { name: binding.profile }
  if (listing) {
    ctx.body = { object: 'list', data: [{ id: binding.model, object: 'model', owned_by: 'ekkostudio', type: 'model', display_name: binding.model, created_at: '1970-01-01T00:00:00Z' }], has_more: false, first_id: binding.model, last_id: binding.model }
    return
  }
  // Test Lab (docs/test-lab.md): a run's credential only reaches the one model picked for it.
  const pinRefusal = checkModelPin(binding, ctx.request.body)
  if (pinRefusal) { ctx.status = 400; ctx.body = gatewayRefusalBody(protocol!, pinRefusal); return }
  // Run limits (docs/agent-limits.md): a loop, the time limit or a limit already hit ends the agent's turn here.
  if (!ctx.path.endsWith('/count_tokens')) {
    const refusal = checkGatewayRunLimits({ sessionId: binding.sessionId, runId: binding.runId, protocol: protocol!, body: ctx.request.body })
    if (refusal) { ctx.status = refusal.status; ctx.body = gatewayRefusalBody(protocol!, refusal.message); return }
  }
  await withProviderAccount(binding.userId, () => modelGatewayAdapters().handle(protocol!, ctx), binding.profile)
}
