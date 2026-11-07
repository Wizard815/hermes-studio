import { join } from 'node:path'
import type { Server } from 'socket.io'
import { getWebUiHome } from '../modules/studio/public/config'
import { logger } from '../modules/studio/public/logging'
import {
  addMessages,
  createSession,
  listSessions,
  findSessionByNativeSessionId,
  getSession,
  updateSession,
  updateSessionStats,
  type HermesSessionRow,
} from '../modules/studio/public/sessions'
import { notifySessionListChanged, onSessionListChanged, setSessionHerdrLink } from '../modules/studio/public/session-status'
import {
  codingAgentIdForStoredAgent,
  getCodingAgentsStatus,
  getCodingAgentDefinition,
  prepareCodingAgentInteractiveLaunch,
  prepareCodingAgentSessionLaunch,
  storedAgentIdForCodingAgent,
} from '../modules/coding-agents/services'
import { herdrManager, type HerdrPluginDeps } from '../modules/coding-agents/services/herdr/manager'
import { listProfileModelGroups } from '../modules/hermes/controllers/models'
import { listProfileNamesFromDisk } from '../modules/hermes/services/profiles/profile'
import { herdrKindForStudioAgent } from '../modules/coding-agents/services/herdr/protocol'
import { locateTranscript } from '../modules/coding-agents/services/herdr/transcript'
import type { HerdrBridgeDeps, HerdrSessionRef } from '../modules/coding-agents/services/herdr/bridge'
import { setupHerdrSocket } from '../modules/coding-agents/sockets/herdr'
import { configureOrbClient } from '../modules/studio/services/orb/client'

function toRef(row: HermesSessionRow | null): HerdrSessionRef | null {
  if (!row) return null
  return {
    id: row.id,
    agent: codingAgentIdForStoredAgent(row.agent) || row.agent,
    title: row.title,
    workspace: row.workspace || null,
    agent_native_session_id: row.agent_native_session_id || '',
    message_count: row.message_count,
  }
}

const AGENT_LABELS: Record<string, string> = { hermes: 'Hermes Agent' }

export function herdrBridgeDeps(): HerdrBridgeDeps {
  return {
    findSessionByNativeId: nativeId => toRef(findSessionByNativeSessionId(nativeId)),
    getSession: id => toRef(getSession(id)),
    createSession: input => {
      if (getSession(input.id)) return
      createSession({
        id: input.id,
        profile: input.profile,
        source: 'coding_agent',
        agent: storedAgentIdForCodingAgent(input.agent),
        // Agents started in herdr use their own native configuration unless Studio launched them.
        agent_mode: input.provider ? 'scoped' : 'global',
        agent_native_session_id: input.nativeId,
        title: input.title,
        workspace: input.workspace || undefined,
        provider: input.provider || 'global',
        model: input.model || '',
      })
    },
    updateNativeSessionId: (id, nativeId) => updateSession(id, { agent_native_session_id: nativeId }),
    appendMessages: (sessionId, messages) => {
      if (!messages.length || !getSession(sessionId)) return
      addMessages(messages.map(message => ({
        session_id: sessionId,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
      })))
      updateSessionStats(sessionId)
    },
    setLink: (sessionId, link) => setSessionHerdrLink(sessionId, link),
    notifyUpdated: sessionId => notifySessionListChanged({ type: 'updated', sessionId }),
    locateTranscript: (agent, nativeId) => locateTranscript(agent, nativeId),
    prepareSessionLaunch: sessionId => prepareCodingAgentSessionLaunch(sessionId),
    prepareAgentLaunch: (agentId, input) => prepareCodingAgentInteractiveLaunch(agentId, {
      profile: input.profile,
      provider: input.provider,
      model: input.model,
      workspace: input.workspace,
      // Without a provider the agent runs with its own native configuration.
      mode: input.provider ? 'scoped' : 'global',
    }),
    herdrKindFor: agentId => herdrKindForStudioAgent(agentId),
    agentLabel: agentId => AGENT_LABELS[agentId] || getCodingAgentDefinition(agentId)?.name || agentId,
    log: (level, message, data) => logger[level](data || {}, message),
  }
}

let stopListChanges: (() => void) | null = null

export function herdrPluginDeps(baseUrl: string): HerdrPluginDeps {
  return {
    listChats: limit => listSessions(undefined, 'coding_agent', limit, { lite: true })
      .filter(row => !!codingAgentIdForStoredAgent(row.agent))
      .map(row => ({
        id: row.id,
        title: row.title || '',
        agent: codingAgentIdForStoredAgent(row.agent) || row.agent,
        updatedAt: Number(row.last_active || row.started_at || 0),
      })),
    listAgents: async () => (await getCodingAgentsStatus()).tools
      .filter(tool => tool.installed)
      .map(tool => ({ id: tool.id, name: tool.name })),
    listProviders: profile => listProfileModelGroups(profile),
    listProfiles: () => { try { const names = listProfileNamesFromDisk(); return names.length ? names : ['default'] } catch { return ['default'] } },
    studioUrl: () => baseUrl,
    browserUrl: () => process.env.HERMES_WEB_UI_PUBLIC_URL || baseUrl,
    nodePath: process.env.HERMES_AGENT_NODE?.trim() || process.execPath,
    scriptCandidates: [
      process.env.HERMES_HERDR_PLUGIN_SCRIPT || '',
      join(process.cwd(), 'bin/herdr-plugin/studio-herdr.mjs'),
      join(__dirname, '../../bin/herdr-plugin/studio-herdr.mjs'),
      join(__dirname, '../../../../bin/herdr-plugin/studio-herdr.mjs'),
    ].filter(Boolean),
  }
}

/** Configure and (if enabled) connect the herdr bridge. Never blocks startup on herdr. */
export function startHerdrIntegration(io: Server, baseUrl: string): { close: () => void } {
  const home = getWebUiHome()
  configureOrbClient(join(home, 'orb', 'settings.json'))
  herdrManager.configure(herdrBridgeDeps(), {
    settingsFile: join(home, 'herdr', 'settings.json'),
    stateFile: join(home, 'herdr', 'bridge-state.json'),
  }, herdrPluginDeps(baseUrl))
  const socket = setupHerdrSocket(io)
  stopListChanges = onSessionListChanged(change => {
    if (change.type === 'deleted') void herdrManager.getBridge()?.forgetSession(change.sessionId)
  })
  void herdrManager.init().catch(error => logger.warn(error, '[herdr] integration failed to start'))
  return {
    close: () => {
      stopListChanges?.(); stopListChanges = null
      socket.close()
      herdrManager.shutdown()
    },
  }
}
