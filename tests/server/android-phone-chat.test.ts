import { describe, expect, it, vi } from 'vitest'
import { phoneAlertLink, phoneToolChat } from '../../packages/server/src/modules/studio/services/android/phone-chat'
import { TaskPlanRuns } from '../../packages/server/src/modules/studio/services/task-plan-runs'

describe('which chat a phone tool call comes from', () => {
  const live = (id: string) => (id === 'ctx-live' ? 'hermes-chat' : '')

  it('Ekko, plugin agents and group chats: the run credential\'s chat, whatever the call names', () => {
    expect(phoneToolChat({ runSessionId: 'ekko-chat', chatForContext: live })).toBe('ekko-chat')
    // A run-bound agent cannot borrow another chat (for example one in auto mode).
    expect(phoneToolChat({ runSessionId: 'ekko-chat', contextId: 'ctx-live', claimedSessionId: 'auto-chat', chatForContext: live })).toBe('ekko-chat')
  })

  it('Hermes: the live turn\'s context id names the chat', () => {
    expect(phoneToolChat({ contextId: 'ctx-live', chatForContext: live })).toBe('hermes-chat')
    expect(phoneToolChat({ contextId: 'ctx-live', claimedSessionId: 'other', chatForContext: live })).toBe('hermes-chat')
  })

  it('an expired or unknown context id falls back to the MCP process\'s chat, then to none', () => {
    expect(phoneToolChat({ contextId: 'ctx-old', claimedSessionId: 'claude-chat', chatForContext: live })).toBe('claude-chat')
    const throws = vi.fn(() => { throw new Error('unavailable') })
    expect(phoneToolChat({ contextId: 'ctx-live', claimedSessionId: 'codex-chat', chatForContext: throws })).toBe('codex-chat')
    expect(phoneToolChat({ contextId: 'ctx-old', chatForContext: live })).toBe('')
  })

  it('coding agents: the chat Studio started the agent for (HERMES_STUDIO_SESSION_ID)', () => {
    expect(phoneToolChat({ claimedSessionId: ' claude-chat ', chatForContext: live })).toBe('claude-chat')
  })

  it('the question opens the Android page; the outcome opens the chat when there is one', () => {
    expect(phoneAlertLink('approval_asked', 'chat-1')).toBe('/android')
    expect(phoneAlertLink('approval_approved', 'chat-1')).toBe('')
    expect(phoneAlertLink('approval_denied', '')).toBe('/android')
  })
})

describe('turn context ids name their chat only while the turn is live', () => {
  it('any Studio turn, not only ones with session goals', () => {
    const state = { isWorking: true, isAborting: false, responseRun: { runMarker: 'turn-1' } }
    const runs = new TaskPlanRuns(vi.fn(), vi.fn())
    const contextId = runs.begin('session-1', 'research', () => state)
    expect(runs.chatForContext(contextId, 'research')).toBe('session-1')
    expect(runs.chatForContext(contextId, 'other-profile')).toBe('')
    expect(runs.chatForContext('', 'research')).toBe('')
    runs.finish(contextId, 'ended')
    expect(runs.chatForContext(contextId, 'research')).toBe('')
  })
})

const phone = vi.hoisted(() => ({ run: vi.fn(async (request: unknown) => ({ text: 'ok', request })) }))
const chatRun = vi.hoisted(() => ({ chatForTurnContext: vi.fn((contextId: string, profile: string) => (contextId === 'ctx-live' && profile === 'work' ? 'hermes-chat' : '')) }))
vi.mock('../../packages/server/src/modules/studio/services/android/phone-agent', () => ({ phoneAgent: phone }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => chatRun }))

describe('POST /api/studio/android/agent', () => {
  async function call(body: Record<string, unknown>, state: Record<string, unknown>) {
    const { agentAction } = await import('../../packages/server/src/modules/studio/controllers/android-devices')
    const ctx: any = { request: { body }, state, body: undefined, status: 200 }
    await agentAction(ctx)
    return (phone.run.mock.calls.at(-1)![0] as { sessionId: string }).sessionId
  }

  it('Ekko\'s run credential names the chat; a session id in the body cannot override it', async () => {
    expect(await call({ action: 'tap', sessionId: 'auto-chat' }, { runBinding: { sessionId: 'ekko-chat' }, profile: { name: 'work' } })).toBe('ekko-chat')
  })

  it('Hermes\'s turn context id is resolved in the caller\'s profile', async () => {
    expect(await call({ action: 'tap', contextId: 'ctx-live' }, { profile: { name: 'work' } })).toBe('hermes-chat')
    expect(await call({ action: 'tap', contextId: 'ctx-live' }, { profile: { name: 'other' } })).toBe('')
  })

  it('a coding agent\'s MCP process still names its chat as before', async () => {
    expect(await call({ action: 'tap', sessionId: 'claude-chat' }, { profile: { name: 'work' } })).toBe('claude-chat')
  })
})
