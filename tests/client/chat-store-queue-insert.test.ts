// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))
import { nextTick } from 'vue'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  socketEmit: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  onUnobservedRunStarted: vi.fn(() => vi.fn()),
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchSession: vi.fn(), fetchSessions: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []), fetchWorkspaceRunChangeFile: vi.fn(async () => null), setSessionModel: vi.fn(),
}))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_path: string, name: string) => `/download/${name}` }))
vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(), fetchAvailableModels: vi.fn(), addCustomModel: vi.fn(), removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(), updateModelVisibility: vi.fn(), triggerUpdate: vi.fn(), updateModelAlias: vi.fn(),
}))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return { id, title: id, messages: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'coding_agent', codingAgentId: 'claude-code' } as Session
}

describe('sending a queued message now (queue insertion)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.registerSessionHandlers.mockImplementation(() => vi.fn())
  })

  it('moves the forced message from the queue into the chat', async () => {
    const store = useChatStore()
    const session = makeSession('s1')
    store.sessions = [session]
    store.activeSessionId = 's1'
    store.activeSession = session

    await store.sendMessage('first task')
    const first = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    first({ event: 'run.started', session_id: 's1', run_id: 'run-1' })
    await nextTick()

    await store.sendMessage('change of plan')
    const queuedMessage = (store as any).queuedUserMessages.get('s1')?.[0]
    expect(queuedMessage?.content).toBe('change of plan')
    const queueId = queuedMessage.id
    // The queued send registers its own handler; the server's events for the session now arrive there.
    const onEvent = (chatApi.startRunViaSocket.mock.calls.at(-1)![1]) as (event: any) => void
    onEvent({ event: 'run.queued', session_id: 's1', queue_id: queueId, queue_length: 1, queued_messages: [{ id: queueId, role: 'user', content: 'change of plan', timestamp: Date.now() / 1000 }] })
    await nextTick()

    store.insertQueuedMessage('s1', queueId)
    expect(chatApi.socketEmit).toHaveBeenCalledWith('insert_queued_run', { session_id: 's1', queue_id: queueId })

    const insertion = { session_id: 's1', generation: 'g1', queue_id: queueId, run_id: 'run-1', runtime: 'claude-code', guarantee: 'immediate', requested_at: Date.now() }
    onEvent({ event: 'run.queue_insertion.updated', ...insertion, phase: 'requesting' })
    onEvent({ event: 'run.queue_insertion.updated', ...insertion, phase: 'stopping_current_turn' })
    // What coding agents send when the turn is stopped (run manager's own queue is empty).
    onEvent({ event: 'run.failed', session_id: 's1', run_id: 'run-1', error: 'Interrupted to insert a queued message', interrupted: true, stop_reason: 'queue_insertion', interruption_mode: 'immediate' })
    onEvent({ event: 'run.queue_insertion.updated', ...insertion, phase: 'starting_queued_message' })
    onEvent({ event: 'run.queued', session_id: 's1', queue_length: 0, dequeued_queue_id: queueId, queued_messages: [] })
    onEvent({ event: 'run.started', session_id: 's1', run_id: 'run-2', queue_id: queueId })
    await nextTick()

    const messages = store.activeSession!.messages
    expect((store as any).queuedUserMessages.get('s1') || []).toEqual([])
    expect(messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['first task', 'change of plan'])
    expect(messages.find(m => m.id === queueId)?.queued).toBeFalsy()
  })
})
