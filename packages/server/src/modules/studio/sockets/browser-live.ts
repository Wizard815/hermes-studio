import type { Server, Socket } from 'socket.io'
import { authenticateUserToken } from '../public/auth'
import type { BrowserScreencast } from '../services/browser-live/screencast'

/**
 * `/browser-live`: the browser panel's live view. A panel sends `watch` with
 * its active tab and gets `frame` events ({ tabId, data: JPEG bytes, width,
 * height, scrollX, scrollY }) while the page changes. Same access as the
 * panel's REST routes: any signed-in user.
 *
 * Frames are volatile (dropped when the socket is still busy with the last
 * one, so a slow link gets fewer frames rather than a growing delay) and not
 * deflated (JPEG does not compress).
 */
export function registerBrowserLiveSocket(io: Server, screencast: () => BrowserScreencast | null): void {
  const namespace = io.of('/browser-live')
  namespace.use((socket, next) => {
    void authenticateUserToken(String(socket.handshake.auth?.token || ''))
      .then(user => {
        if (!user) return next(new Error('Unauthorized'))
        socket.data.user = user
        next()
      })
      .catch(() => next(new Error('Unauthorized')))
  })

  namespace.on('connection', (socket: Socket) => {
    let stop: (() => void) | null = null
    let generation = 0
    const unwatch = () => {
      generation += 1
      stop?.()
      stop = null
    }

    socket.on('watch', async (payload: unknown, ack?: (reply: { ok: boolean; error?: string }) => void) => {
      unwatch()
      const mine = generation
      const tabId = typeof (payload as { tabId?: unknown })?.tabId === 'string' ? (payload as { tabId: string }).tabId : ''
      const cast = screencast()
      if (!tabId || tabId.length > 100 || !cast) {
        ack?.({ ok: false, error: cast ? 'tabId is required' : 'The browser is not running' })
        return
      }
      try {
        const release = await cast.watch(tabId, frame => {
          socket.compress(false).volatile.emit('frame', frame)
        })
        // Another watch or a disconnect came in while this one started.
        if (mine !== generation || socket.disconnected) release()
        else stop = release
        ack?.({ ok: true })
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    socket.on('unwatch', unwatch)
    socket.on('disconnect', unwatch)
  })
}
