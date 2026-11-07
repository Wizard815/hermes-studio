import type { Server, Socket } from 'socket.io'
import { authenticateUserToken } from '../public/auth'
import { SERIAL } from '../services/android/adb'
import { androidDeviceManager } from '../services/android/manager'

const MAX_WATCHES_PER_SOCKET = 4

/**
 * `/android` namespace: live device screens and input for the Studio panel.
 * Frames travel over Studio's own connection, so the panel works through a
 * tunnel or reverse proxy with no extra ports.
 */
export function setupAndroidDeviceSocket(io: Server): { close: () => void } {
  const nsp = io.of('/android')
  nsp.use((socket, next) => {
    void (async () => {
      const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
      if (user?.role !== 'super_admin') return next(new Error('Super administrator privileges are required'))
      socket.data.user = user
      next()
    })().catch(() => next(new Error('Unauthorized')))
  })

  nsp.on('connection', (socket: Socket) => {
    const watches = new Map<string, () => void>()
    // A viewer that is still receiving the previous frame skips frames instead of queueing them.
    let inFlight = 0

    socket.on('screen.watch', (data: any, ack?: (result: { ok: boolean; error?: string }) => void) => {
      const reply = typeof ack === 'function' ? ack : () => {}
      const serial = String(data?.serial || '')
      if (!SERIAL.test(serial)) return reply({ ok: false, error: 'Invalid device serial' })
      if (watches.has(serial)) return reply({ ok: true })
      if (watches.size >= MAX_WATCHES_PER_SOCKET) return reply({ ok: false, error: 'Too many device screens open' })
      try {
        const stop = androidDeviceManager.frames.watch(serial, frame => {
          if (inFlight > 1) return
          inFlight += 1
          socket.timeout(5_000).emit('screen.frame', {
            serial: frame.serial,
            mime: frame.mime,
            width: frame.width,
            height: frame.height,
            source: frame.source,
            data: frame.data,
          }, () => { inFlight = Math.max(0, inFlight - 1) })
        }, reason => {
          watches.delete(serial)
          socket.emit('screen.ended', { serial, reason })
        })
        watches.set(serial, stop)
        reply({ ok: true })
      } catch (error) {
        reply({ ok: false, error: (error as Error).message })
      }
    })

    socket.on('screen.unwatch', (data: any) => {
      const serial = String(data?.serial || '')
      watches.get(serial)?.()
      watches.delete(serial)
    })

    socket.on('input', (data: any, ack?: (result: { ok: boolean; error?: string }) => void) => {
      const reply = typeof ack === 'function' ? ack : () => {}
      const serial = String(data?.serial || '')
      androidDeviceManager.gesture(serial, data?.gesture)
        .then(() => reply({ ok: true }))
        .catch(error => reply({ ok: false, error: (error as Error).message }))
    })

    socket.on('disconnect', () => {
      for (const stop of watches.values()) stop()
      watches.clear()
    })
  })

  return {
    close: () => {
      nsp.disconnectSockets(true)
      androidDeviceManager.shutdown()
    },
  }
}
