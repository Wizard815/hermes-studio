import { join } from 'node:path'
import { getWebUiHome } from '../modules/studio/public/config'
import { logger } from '../modules/studio/public/logging'
import { getChatRunServer } from '../modules/studio/public/chat-run'
import { getSession } from '../modules/studio/repositories/session-store'
import { findUserById, listUsers } from '../modules/studio/repositories/users-store'
import { getAgentWork } from '../modules/studio/services/agent-work'
import { phoneAgent } from '../modules/studio/services/android/phone-agent'
import { recordWatcherEvent } from '../modules/studio/services/watcher'
import {
  ApprovalAlertsFile, closeApprovalAlerts, configureApprovalAlerts, setPhoneKeyLookup,
} from '../modules/studio/services/approval-alerts'

/**
 * Where approvals reach you (docs/approval-alerts.md): each super admin's
 * choice (Mattermost, the Android app, both, off), paired phones' keys and
 * their live streams. Questions come from Agent work, every chat type's
 * approvals and the phone tools; answers go back to them.
 */
export function startApprovalAlerts(): { close: () => void } {
  const service = configureApprovalAlerts({
    file: new ApprovalAlertsFile(join(getWebUiHome(), 'approval-alerts.json')),
    user: id => {
      const user = findUserById(id)
      return user ? { id: user.id, username: user.username, role: user.role, status: user.status } : null
    },
    superAdmins: () => listUsers().filter(user => user.role === 'super_admin' && user.status === 'active')
      .map(user => ({ id: user.id, username: user.username, role: user.role, status: user.status })),
    work: () => {
      try {
        const work = getAgentWork()
        return {
          pending: () => work.list({ status: ['awaiting_approval'], limit: 200 }),
          decide: (id, decision, via, by) => work.decide(id, decision, via, by),
        }
      } catch { return null }
    },
    phone: () => ({
      pending: () => phoneAgent.approvals(),
      respond: (id, allowed) => phoneAgent.respond(id, allowed),
    }),
    answerChat: async (sessionId, approvalId, choice) => Boolean(await getChatRunServer()?.respondPersonInteraction?.(sessionId, approvalId, choice, true)),
    sessionTitle: sessionId => getSession(sessionId)?.title || '',
    mattermost: {
      post: input => getAgentWork().postQuestion(input),
      resolve: (postId, message) => getAgentWork().resolveQuestion(postId, message),
    },
    record: input => recordWatcherEvent(input),
    onError: (what, error) => logger.warn({ err: error }, '[approval-alerts] %s failed', what),
  })
  setPhoneKeyLookup(token => {
    const device = service.authenticate(token)
    return device ? { id: device.id, name: device.name, userId: device.userId } : null
  })
  try {
    getAgentWork().setAlertActionHandler(input => service.answerFromMattermost(input))
  } catch (error) {
    logger.warn({ err: error }, '[approval-alerts] Mattermost buttons for chat and phone questions are off: Agent work is not running')
  }
  return {
    close: () => {
      setPhoneKeyLookup(null)
      try { getAgentWork().setAlertActionHandler(null) } catch { /* already closed */ }
      closeApprovalAlerts()
    },
  }
}
