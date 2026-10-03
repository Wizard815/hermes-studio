import { createServer } from 'http'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────
//
// The terminal socket is a raw `ws` server that shells out to tmux/node-pty,
// so the pty and the tmux store are faked. The fakes keep a mutable store so a
// test can drive session creation and shell output deterministically.

const tmux = vi.hoisted(() => ({ sessions: new Map<string, string[]>() }))
const ptyMock = vi.hoisted(() => ({ instances: [] as any[] }))

vi.mock('../../packages/server/src/modules/hermes/services/terminal/runtime', () => ({
  findShell: () => '/bin/sh',
  canOpenTerminal: () => true,
  resolveTerminalCwd: () => '/tmp',
  pty: {
    spawn: () => {
      let onData: (data: string) => void = () => {}
      const instance: any = {
        pid: 4242,
        onData: (fn: (data: string) => void) => { onData = fn },
        onExit: () => {},
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        emit: (data: string) => onData(data),
      }
      ptyMock.instances.push(instance)
      return instance
    },
  },
}))

vi.mock('../../packages/server/src/modules/hermes/services/terminal/tmux-sessions', () => ({
  tmuxAvailable: () => true,
  tmuxSessionName: (chat: string, index: number) => `hermes_${chat}_${index}`,
  nextSessionIndex: (chat: string) => (tmux.sessions.get(chat)?.length ?? 0) + 1,
  listChatSessions: (chat: string) => (tmux.sessions.get(chat) ?? []).map(name => ({ name })),
  ensureTmuxSession: (name: string) => {
    const chat = name.replace(/^hermes_/, '').replace(/_\d+$/, '')
    const list = tmux.sessions.get(chat) ?? []
    if (!list.includes(name)) list.push(name)
    tmux.sessions.set(chat, list)
  },
  tmuxSessionExists: (name: string) =>
    [...tmux.sessions.values()].some(list => list.includes(name)),
  killTmuxSession: (name: string) => {
    for (const [chat, list] of tmux.sessions) {
      tmux.sessions.set(chat, list.filter(entry => entry !== name))
    }
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  isAuthEnabled: async () => false,
  authenticateUserToken: async () => ({ id: 1, role: 'super_admin' }),
}))

vi.mock('../../packages/server/src/modules/studio/public/security', () => ({
  parseUpgradeRequestUrl: (req: any) => {
    try { return new URL(req.url, 'http://127.0.0.1') } catch { return null }
  },
  shouldRejectUpgradeOrigin: () => false,
  writeBadUpgradeRequest: () => {},
  writeForbiddenOrigin: () => {},
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: { corsOrigins: [] },
}))

import { setupTerminalWebSocket } from '../../packages/server/src/modules/hermes/sockets/terminal'

const HEARTBEAT_MS = 60

let server: ReturnType<typeof createServer>
let service: ReturnType<typeof setupTerminalWebSocket>
let origin = ''
const sockets: WebSocket[] = []

beforeEach(async () => {
  tmux.sessions.clear()
  ptyMock.instances.length = 0
  server = createServer()
  service = setupTerminalWebSocket(server, { heartbeatMs: HEARTBEAT_MS })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  origin = `ws://127.0.0.1:${(server.address() as any).port}`
})

afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.close())
  service?.forceClose()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

/** Open a terminal socket for a chat scope and record its control frames. */
function open(chat: string) {
  const socket = new WebSocket(`${origin}/api/hermes/terminal?chat_session_id=${chat}`)
  sockets.push(socket)
  const controls: any[] = []
  socket.on('message', (raw: any) => {
    const text = raw.toString()
    if (text.charCodeAt(0) === 0x7b) {
      try { controls.push(JSON.parse(text)) } catch { /* raw output */ }
    }
  })
  const send = (payload: Record<string, unknown>) => socket.send(JSON.stringify(payload))
  const of = (type: string) => controls.filter(frame => frame.type === type)
  return { socket, controls, send, of }
}

const ready = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

describe('terminal socket liveness and session restore', () => {
  it('pushes heartbeat frames so an idle intermediary cannot drop the socket', async () => {
    const client = open('heartbeat-chat')
    await ready(client.socket)
    await vi.waitFor(() => expect(client.of('restored')).toHaveLength(1))

    // The whole point of the fix: with no traffic an idle timeout closes the
    // socket (~31s median observed in production), so the server must emit on
    // an interval rather than waiting for the user to type.
    await vi.waitFor(() => expect(client.of('ping').length).toBeGreaterThanOrEqual(2), { timeout: 3000 })
    expect(client.socket.readyState).toBe(WebSocket.OPEN)
    for (const frame of client.of('ping')) expect(typeof frame.t).toBe('number')
  })

  it('restores the session the user was last viewing instead of the first tab', async () => {
    const client = open('restore-chat')
    await ready(client.socket)
    await vi.waitFor(() => expect(client.of('restored')).toHaveLength(1))

    // The scope already had one tmux session auto-created; add a second and
    // switch to it, exactly like clicking "bash #2" in the rail.
    client.send({ type: 'create' })
    await vi.waitFor(() => expect(client.of('created')).toHaveLength(1))
    const second = client.of('created')[0].id
    expect(second).toBe('hermes_restore-chat_2')

    client.send({ type: 'switch', sessionId: second })
    await vi.waitFor(() => expect(client.of('switched')).toHaveLength(1))

    // Reconnect: the previous build always answered with tmuxSessions[0],
    // which is what snapped the user back to bash #1 mid-keystroke.
    client.socket.close()
    await vi.waitFor(() => expect(client.socket.readyState).toBe(WebSocket.CLOSED))

    const reconnected = open('restore-chat')
    await ready(reconnected.socket)
    await vi.waitFor(() => expect(reconnected.of('restored')).toHaveLength(1))
    const restored = reconnected.of('restored')[0]
    expect(restored.activeSessionId).toBe(second)
    expect(restored.activeSessionId).not.toBe('hermes_restore-chat_1')
    expect(restored.sessions.map((s: any) => s.id)).toContain(second)
  })

  it('sends live scrollback on restore so a reattach repaints instead of blanking', async () => {
    const client = open('scrollback-chat')
    await ready(client.socket)
    await vi.waitFor(() => expect(client.of('restored')).toHaveLength(1))

    // Shell output reaches the attached socket...
    await vi.waitFor(() => expect(ptyMock.instances).toHaveLength(1))
    ptyMock.instances[0].emit('live-shell-output\r\n')
    await vi.waitFor(() => expect(client.controls.some(f => f.type === 'restored')).toBe(true))

    client.socket.close()
    await vi.waitFor(() => expect(client.socket.readyState).toBe(WebSocket.CLOSED))

    // ...and is replayed to the next socket instead of being lost, which is
    // what produced the black flash before the pane repainted.
    const reconnected = open('scrollback-chat')
    await ready(reconnected.socket)
    await vi.waitFor(() => expect(reconnected.of('restored')).toHaveLength(1))
    const [session] = reconnected.of('restored')[0].sessions
    expect(session.scrollback).toContain('live-shell-output')
  })
})
