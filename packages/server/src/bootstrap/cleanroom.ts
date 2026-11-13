import { isCleanRoom, removeCleanRoom } from '../modules/coding-agents/services/cleanroom'
import { onSessionListChanged } from '../modules/studio/public/session-status'
import { logger } from '../modules/studio/public/logging'

/** A deleted clean-room chat takes its container with it (the chat's folder stays). */
export function startCleanRoomCleanup(): () => void {
  return onSessionListChanged(change => {
    if (change.type !== 'deleted' || !isCleanRoom(change.sessionId)) return
    void removeCleanRoom(change.sessionId).catch(error => logger.warn({ error: String(error) }, '[cleanroom] could not remove a deleted chat\'s container'))
  })
}
