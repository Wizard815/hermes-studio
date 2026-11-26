import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn(async (input: Record<string, unknown>) => ({ text: 'ok', input }))
vi.mock('../../packages/server/src/modules/studio/services/android/phone-agent', () => ({ phoneAgent: { run } }))
vi.mock('../../packages/server/src/modules/studio/services/android/manager', () => ({ androidDeviceManager: {} }))

const { agentAction } = await import('../../packages/server/src/modules/studio/controllers/android-devices')

function ctx(body: Record<string, unknown>, runBinding?: { sessionId?: string; agentId?: string }) {
  return { request: { body }, state: runBinding ? { runBinding } : {}, body: undefined as unknown, status: 200 } as any
}

describe("a phone action belongs to the chat whose run asked", () => {
  beforeEach(() => run.mockClear())

  it("takes the chat from the run's credential when the tool sends none (Ekko)", async () => {
    await agentAction(ctx({ action: 'tap', arguments: { id: 'e2' }, agent: 'ekko' }, { sessionId: 'chat-ekko', agentId: 'ekko-agent' }))
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ action: 'tap', sessionId: 'chat-ekko', agent: 'ekko' }))
  })

  it("prefers the run's chat over a sessionId in the body", async () => {
    await agentAction(ctx({ action: 'tap', sessionId: 'another-chat' }, { sessionId: 'chat-ekko' }))
    expect(run.mock.calls[0][0]).toMatchObject({ sessionId: 'chat-ekko' })
  })

  it('keeps the body sessionId for callers without a run credential', async () => {
    await agentAction(ctx({ action: 'screen', sessionId: 'hermes-chat' }))
    expect(run.mock.calls[0][0]).toMatchObject({ sessionId: 'hermes-chat', agent: 'agent' })
  })
})
