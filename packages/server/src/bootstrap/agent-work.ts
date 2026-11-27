import { join } from 'node:path'
import { getWebUiHome } from '../modules/studio/public/config'
import { closeAgentWork, configureAgentWork } from '../modules/studio/services/agent-work'
import { logger } from '../modules/studio/public/logging'
import { getActiveProfileName } from '../modules/hermes/services/profiles/profile'
import { readProfileEnv, readSetupRecord } from '../modules/hermes/controllers/mattermost-setup'

/** Agent work on Vikunja tasks: its log, approvals and where they are shared. Needs the Orb client first. */
export function startAgentWork(): { close: () => void } {
  try {
    configureAgentWork(join(getWebUiHome(), 'agent-work', 'settings.json'), {
      activeProfile: getActiveProfileName,
      env: readProfileEnv,
      mattermostSetup: readSetupRecord,
    })
  } catch (error) {
    logger.warn({ err: error }, '[agent-work] not started')
  }
  return { close: () => closeAgentWork() }
}
