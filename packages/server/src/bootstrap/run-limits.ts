import { join } from 'node:path'
import { getWebUiHome } from '../modules/studio/public/config'
import { logger } from '../modules/studio/public/logging'
import { getChatRunServer } from '../modules/studio/public/chat-run'
import { getSessionLimitHit, onSessionListChanged, setSessionLimitHit, onSessionLimitHitChanged } from '../modules/studio/public/session-status'
import { onSessionUsageRecorded } from '../modules/studio/public/usage'
import { getModelCatalogSnapshot } from '../modules/studio/public/model-catalog'
import { priceGatewayRunUsage } from '../modules/studio/services/run-limits/pricing'
import { getUsagePricing } from '../modules/studio/repositories/usage-pricing-store'
import { getSession } from '../modules/studio/repositories/session-store'
import { closeRunLimits, configureRunLimits, RunLimitSettingsStore } from '../modules/studio/services/run-limits'
import { getAgentWork } from '../modules/studio/services/agent-work'
import { herdrManager } from '../modules/coding-agents/services/herdr/manager'

/**
 * Run limits (docs/agent-limits.md): stop a runaway agent in any chat. Wires
 * the service to chat runs (Stop, chat notices), recorded usage, herdr (the
 * chat's pane shows blocked) and Agent work's Mattermost channel.
 */
export function startRunLimits(): { close: () => void } {
  const store = new RunLimitSettingsStore(() => join(getWebUiHome(), 'run-limits.json'))
  const service = configureRunLimits({
    store,
    stopRun: async sessionId => {
      const server = getChatRunServer()
      return server?.stopRunForLimit ? await server.stopRunForLimit(sessionId) : false
    },
    postNotice: (sessionId, text, hit) => getChatRunServer()?.postRunLimitNotice?.(sessionId, text, hit),
    setHit: (sessionId, hit) => setSessionLimitHit(sessionId, hit),
    getHit: sessionId => getSessionLimitHit(sessionId),
    alert: async (sessionId, text) => {
      let agentWork
      try { agentWork = getAgentWork() } catch { return }
      const title = getSession(sessionId)?.title?.trim() || `Chat ${sessionId.slice(0, 8)}`
      await agentWork.alertBlocked(title, text)
    },
    priceGatewayUsage: input => priceGatewayRunUsage(input, getUsagePricing(input.profile || 'default'), getModelCatalogSnapshot()),
    onError: (what, error) => logger.warn({ err: error }, '[run-limits] %s failed', what),
  })
  const stops = [
    onSessionUsageRecorded(notice => service.observeUsage(notice)),
    onSessionLimitHitChanged(sessionId => {
      const blocked = !!getSessionLimitHit(sessionId)
      void herdrManager.getBridge()?.reportChatLimit(sessionId, blocked).catch(() => false)
    }),
    onSessionListChanged(change => { if (change.type === 'deleted') service.forgetChat(change.sessionId) }),
  ]
  return {
    close: () => {
      for (const stop of stops) stop()
      closeRunLimits()
    },
  }
}
