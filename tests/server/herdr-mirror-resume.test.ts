import { describe, expect, it } from 'vitest'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'

// herdr's transcript mirror writes a pane's turns straight to the database.
// The chat-run socket resumes chats from its in-memory cache, so without
// dropping it a reopened chat shows the history from before the pane's turns.
function socketWith(states: Record<string, unknown>) {
  return Object.assign(Object.create(ChatRunSocket.prototype), {
    sessionMap: new Map(Object.entries(states)),
  }) as ChatRunSocket & { sessionMap: Map<string, unknown> }
}

describe('chat-run cache after herdr mirrors a pane turn', () => {
  it('drops an idle chat so the next resume reads the database', () => {
    const socket = socketWith({ chat: { isWorking: false, queue: [], messages: [{ id: 1 }] } })
    expect(socket.forgetIdleSessionState('chat')).toBe(true)
    expect(socket.sessionMap.has('chat')).toBe(false)
  })

  it('keeps a chat that is running, stopping, compressing or has queued messages', () => {
    const socket = socketWith({
      running: { isWorking: true, queue: [] },
      stopping: { isWorking: false, isAborting: true, queue: [] },
      compressing: { isWorking: false, isCompressing: true, queue: [] },
      queued: { isWorking: false, queue: [{ queue_id: 'q1' }] },
    })
    for (const id of ['running', 'stopping', 'compressing', 'queued']) {
      expect(socket.forgetIdleSessionState(id)).toBe(false)
      expect(socket.sessionMap.has(id)).toBe(true)
    }
  })

  it('does nothing for a chat that is not cached', () => {
    expect(socketWith({}).forgetIdleSessionState('missing')).toBe(false)
  })
})
