import { getOrbWork } from '../orb/work'
import { getAgentWork } from '../agent-work'
import { getProfileDir, listProfileNames } from '../../public/profile-config'
import { findUserById, type UserRecord } from '../../repositories/users-store'
import {
  createChatWebhookEndpoint,
  deleteChatWebhookEndpoint,
  getChatWebhookEndpoint,
  type ChatWebhookEventType,
} from '../../public/chat-webhooks'
import { getChatWebhookDispatcher, setChatWebhookEndpointFilter } from '../webhooks/dispatcher'
import { normalizeSafeWebhookUrl } from '../webhooks/url-safety'
import { OmiError, OmiSettingsFile } from './settings'
import { OmiService } from './service'

export { OmiError } from './settings'
export { OMI_KEY_PREFIX, omiKeyAllows, looksLikeOmiKey } from './scope'

let service: OmiService | null = null

/** Process-wide Omi connection; bootstrap sets the settings file under HERMES_WEB_UI_HOME. */
export function configureOmi(file: string, issueJwt: (user: UserRecord) => Promise<string>): OmiService {
  service = new OmiService({
    settings: new OmiSettingsFile(file),
    work: getOrbWork,
    agentWork: getAgentWork,
    profiles: listProfileNames,
    profileDir: getProfileDir,
    issueToken: async (userId) => {
      const user = findUserById(userId)
      if (!user || user.status !== 'active') throw new OmiError("The key's owner is disabled or no longer exists.", 403)
      return issueJwt(user)
    },
    webhooks: {
      create: async input => createChatWebhookEndpoint({
        ...input,
        url: await normalizeSafeWebhookUrl(input.url, input.allow_private_network),
        event_types: input.event_types as ChatWebhookEventType[],
      }),
      get: id => getChatWebhookEndpoint(id),
      remove: id => deleteChatWebhookEndpoint(id),
      status: id => getChatWebhookDispatcher().getStatus(id),
      reload: () => getChatWebhookDispatcher().reloadEndpoints(),
      setFilter: (id, filter) => setChatWebhookEndpointFilter(id, filter as any),
    },
  })
  return service
}

export function getOmi(): OmiService {
  if (!service) throw new OmiError('Omi is not set up', 503)
  return service
}
