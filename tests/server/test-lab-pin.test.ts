import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const handled = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: () => ({ id: 1, username: 'admin', role: 'super_admin', status: 'active' }),
  listUserProfiles: () => [], userCanAccessProfile: () => true,
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({
  withProviderAccount: (_id: unknown, operation: () => unknown) => operation(),
}))

import { configureModelGatewayAdapters } from '../../packages/server/src/modules/studio/public/model-gateway-adapters'
import { modelGatewayMiddleware } from '../../packages/server/src/modules/studio/middleware/model-gateway'
import { checkModelPin, pinModel, unpinModel, testLabSessionId } from '../../packages/server/src/modules/studio/services/test-lab/pin'

const session = testLabSessionId('20261125-120000-abcd')
const bindings: Record<string, any> = {
  lab: { userId: 1, profile: 'default', sessionId: session, provider: 'openrouter', model: 'tencent/hy4-flash' },
  swapped: { userId: 1, profile: 'default', sessionId: session, provider: 'openrouter', model: 'anthropic/claude-opus' },
  chat: { userId: 1, profile: 'default', sessionId: 'chat-1', provider: 'openrouter', model: 'anthropic/claude-opus' },
}

const ctx = (token: string, body: Record<string, unknown>, path = '/api/ekko-studio/models/v1/chat/completions'): any => ({
  path, method: 'POST', state: {}, query: {}, params: {}, headers: { authorization: `Bearer ${token}` },
  request: { body }, get(name: string) { return this.headers[name] || '' },
})

beforeEach(() => {
  handled.mockReset()
  configureModelGatewayAdapters({ authenticate: token => bindings[token] || null, handle: handled, register: () => { throw new Error('unused') } })
  pinModel(session, { provider: 'openrouter', model: 'tencent/hy4-flash', routeId: 'openrouter/tencent/hy4-flash' })
})
afterEach(() => unpinModel(session))

it('passes the pinned model (bare, catalog id or omitted)', async () => {
  for (const model of ['tencent/hy4-flash', 'openrouter/tencent/hy4-flash', undefined]) {
    const request = ctx('lab', { model, messages: [] })
    await modelGatewayMiddleware(request, vi.fn())
    expect(request.status).toBeUndefined()
  }
  expect(handled).toHaveBeenCalledTimes(3)
})

it('refuses any other model a run asks for', async () => {
  for (const path of ['/api/ekko-studio/models/v1/chat/completions', '/api/ekko-studio/models/v1/responses', '/api/ekko-studio/models/v1/messages']) {
    const request = ctx('lab', { model: 'anthropic/claude-opus-4', messages: [] }, path)
    await modelGatewayMiddleware(request, vi.fn())
    expect(request.status).toBe(400)
    expect(JSON.stringify(request.body)).toContain('pinned to openrouter/tencent/hy4-flash')
  }
  expect(handled).not.toHaveBeenCalled()
})

it('refuses a run credential bound to another model, and every request once the run ended', async () => {
  const swapped = ctx('swapped', { messages: [] })
  await modelGatewayMiddleware(swapped, vi.fn())
  expect(swapped.status).toBe(400)
  unpinModel(session)
  const ended = ctx('lab', { model: 'tencent/hy4-flash', messages: [] })
  await modelGatewayMiddleware(ended, vi.fn())
  expect(ended.status).toBe(400)
  expect(ended.body.error.message).toBe('This Test Lab run has ended')
  expect(handled).not.toHaveBeenCalled()
})

it('leaves ordinary chats alone', async () => {
  const request = ctx('chat', { model: 'anything', messages: [] })
  await modelGatewayMiddleware(request, vi.fn())
  expect(handled).toHaveBeenCalledOnce()
  expect(checkModelPin({ sessionId: 'chat-1' }, { model: 'x' })).toBeNull()
})
