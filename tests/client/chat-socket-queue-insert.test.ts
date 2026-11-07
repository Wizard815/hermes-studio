// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

/** A fake socket.io client: records listeners so the test can play server events. */
const fake = vi.hoisted(() => {
  const listeners = new Map<string, Array<(data: any) => void>>()
  const socket: any = {
    connected: true,
    id: 'sock-1',
    io: { on: () => {}, off: () => {}, opts: {} },
    on(event: string, fn: (data: any) => void) { listeners.set(event, [...(listeners.get(event) || []), fn]); return socket },
    off(event: string, fn?: (data: any) => void) { listeners.set(event, fn ? (listeners.get(event) || []).filter(f => f !== fn) : []); return socket },
    once(event: string, fn: (data: any) => void) { return socket.on(event, fn) },
    emit: vi.fn(),
    connect() { return socket },
    disconnect() { return socket },
    removeAllListeners() { listeners.clear(); return socket },
  }
  return { socket, fire: (event: string, data: any) => { for (const fn of [...(listeners.get(event) || [])]) fn(data) } }
})
vi.mock('socket.io-client', () => ({ io: () => fake.socket }))
vi.mock('@/api/client', () => ({ getBaseUrlValue: () => 'http://studio.test', getApiKey: () => 'k' }))

import { startRunViaSocket } from '@/api/studio/chat'

describe('chat socket: sending a queued message now', () => {
  it('keeps listening after a turn is stopped for the queued message, so the chat sees it start', () => {
    const events: string[] = []
    const onDone = vi.fn()
    startRunViaSocket({ session_id: 's1', input: 'change of plan', queue_id: 'q1' } as any, evt => events.push(evt.event), onDone, () => {})
    // Coding agents report the stopped turn without counting the chat's queue.
    fake.fire('run.failed', { event: 'run.failed', session_id: 's1', run_id: 'run-1', interrupted: true, stop_reason: 'queue_insertion', interruption_mode: 'immediate' })
    fake.fire('run.queued', { event: 'run.queued', session_id: 's1', queue_length: 0, dequeued_queue_id: 'q1', queued_messages: [] })
    fake.fire('run.started', { event: 'run.started', session_id: 's1', run_id: 'run-2', queue_id: 'q1' })
    expect(events).toEqual(['run.failed', 'run.queued', 'run.started'])
    expect(onDone).not.toHaveBeenCalled()
  })

  it('still finishes on an ordinary failure', () => {
    const events: string[] = []
    const onDone = vi.fn()
    startRunViaSocket({ session_id: 's2', input: 'x' } as any, evt => events.push(evt.event), onDone, () => {})
    fake.fire('run.failed', { event: 'run.failed', session_id: 's2', error: 'boom' })
    fake.fire('run.started', { event: 'run.started', session_id: 's2', run_id: 'late' })
    expect(events).toEqual(['run.failed'])
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
