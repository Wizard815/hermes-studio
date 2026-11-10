import { homedir } from 'node:os'
import { folderFor } from '../modules/coding-agents/services/herdr/folders'
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
  listSessionCategories,
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
import { hermesCliAvailable, hermesInteractiveLaunch, hermesNewChatLaunch } from '../modules/hermes/services/herdr-launch'

/** The stored agent id when herdr can host the chat as a pane, else null. */
function herdrHostableAgentId(agent: string | null | undefined): string | null {
  const id = codingAgentIdForStoredAgent(agent) || String(agent || '')
  return herdrKindForStudioAgent(id) ? id : null
}
import { herdrChatMode, herdrKindForStudioAgent } from '../modules/coding-agents/services/herdr/protocol'
import { locateTranscript } from '../modules/coding-agents/services/herdr/transcript'
import type { HerdrBridgeDeps, HerdrSessionRef, HerdrWorkRef } from '../modules/coding-agents/services/herdr/bridge'
import { setupHerdrSocket } from '../modules/coding-agents/sockets/herdr'
import { configureOrbClient, getOrbClient } from '../modules/studio/services/orb/client'
import { writeModelRunProfileToken } from '../modules/studio/services/chat-run/model-run-prompt'
import { listUsers } from '../modules/studio/public/users'
import type { AuthenticatedUser } from '../modules/studio/public/auth'

function toRef(row: HermesSessionRow | null): HerdrSessionRef | null {
  if (!row) return null
  return {
    id: row.id,
    agent: codingAgentIdForStoredAgent(row.agent) || row.agent,
    title: row.title,
    workspace: row.workspace || null,
    agent_native_session_id: row.agent_native_session_id || '',
    message_count: row.message_count,
    category_id: row.category_id ?? null,
  }
}

const AGENT_LABELS: Record<string, string> = { hermes: 'Hermes Agent' }

/**
 * Chats that herdr started natively used to be stored as Studio-routed
 * ('scoped') without a model, so Studio could not resume or reopen them.
 */
export function repairHerdrChatModes(): number {
  let repaired = 0
  for (const row of listSessions(undefined, 'coding_agent', 5000)) {
    if (!row.id.startsWith('herdr-') || row.agent_mode !== 'scoped' || String(row.model || '').trim()) continue
    if (herdrChatMode(row.provider) !== 'global') continue
    updateSession(row.id, { agent_mode: 'global' })
    repaired += 1
  }
  return repaired
}

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
        agent_mode: herdrChatMode(input.provider),
        agent_native_session_id: input.nativeId,
        title: input.title,
        workspace: input.workspace || undefined,
        provider: input.provider || 'global',
        model: input.model || '',
        category_id: input.categoryId ?? null,
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
    // Hermes chats resume as `hermes chat` panes (herdr has a hermes
    // integration); everything else goes through the coding-agent launcher.
    prepareSessionLaunch: async sessionId => {
      const session = getSession(sessionId)
      return session?.agent === 'hermes' ? hermesInteractiveLaunch(session) : prepareCodingAgentSessionLaunch(sessionId)
    },
    prepareAgentLaunch: async (agentId, input) => agentId === 'hermes'
      ? hermesNewChatLaunch(input.workspace)
      : prepareCodingAgentInteractiveLaunch(agentId, {
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
    workStatusChanged: (data, _paneId, status, agent) => reportOrbAgentStatus(data.orb, status, agent),
    folderForWork,
    categoryForSpace,
    // Agents in herdr act for the Studio admin using herdr (herdr routes are
    // super-admin only), or the first active super admin after a restart.
    grantAgentAccess: async profile => {
      const user = herdrManager.actingUser() ?? listUsers().find(item => item.role === 'super_admin' && item.status === 'active') ?? null
      if (user) await writeModelRunProfileToken({ id: user.id, username: user.username, role: user.role as AuthenticatedUser['role'] }, profile)
    },
  }
}

/** The Studio chat folder Mission files a herdr space in (folders are `c<category id>`). */
async function categoryForSpace(spaceId: string, cwd: string): Promise<number | null> {
  const id = folderFor(await herdrManager.folders().load(), spaceId, cwd, homedir())
  const match = /^c(\d+)$/.exec(id)
  if (!match) return null
  const categoryId = Number(match[1])
  return listSessionCategories().some(category => category.id === categoryId) ? categoryId : null
}

/** The agent working on an Orb task or project changed state: show it in Orb, the way herdr does. */
async function reportOrbAgentStatus(ref: HerdrWorkRef['orb'], status: string, agent: string | null) {
  if (!ref) return
  const orb = getOrbClient()
  if (!(await orb.publicSettings()).url) return
  await orb.tool('orb_set_agent_status', {
    ...(ref.task ? { task: { title: ref.task.title, ...(ref.task.list ? { list: ref.task.list } : {}) } } : { project: ref.project }),
    status,
    ...(agent ? { agent } : {}),
  })
}

/**
 * Studio's chat folder for a piece of work: the folder named like the Orb
 * project (or the task's list, which is its project), shallowest first, with
 * the start directory set for it in Mission.
 */
async function folderForWork(ref: HerdrWorkRef): Promise<{ categoryId: number | null; workspace: string } | null> {
  const name = (ref.orb?.project || ref.orb?.task?.list || '').trim().toLowerCase()
  if (!name) return null
  const categories = listSessionCategories()
  const depth = (id: number | null): number => { let d = 0; let cur = categories.find(c => c.id === id); while (cur && d < 10) { d += 1; cur = categories.find(c => c.id === cur!.parent_id) } return d }
  const match = categories.filter(category => category.name.trim().toLowerCase() === name).sort((a, b) => depth(a.id) - depth(b.id))[0]
  if (!match) return null
  const folders = await herdrManager.folders().load()
  const meta = folders.list.find(folder => folder.id === `c${match.id}`)
  return { categoryId: match.id, workspace: meta?.start || '' }
}

let stopListChanges: (() => void) | null = null

export function herdrPluginDeps(baseUrl: string): HerdrPluginDeps {
  return {
    // Every chat herdr can host: coding-agent chats and Hermes chats alike
    // (they all resume as panes); sub-chats and archived chats stay out.
    listChats: limit => listSessions(undefined, undefined, limit * 4, { lite: true })
      .filter(row => !row.parent_session_id && !row.is_archived && !!herdrHostableAgentId(row.agent))
      .slice(0, limit)
      .map(row => ({
        id: row.id,
        title: row.title || '',
        agent: herdrHostableAgentId(row.agent)!,
        updatedAt: Number(row.last_active || row.started_at || 0),
      })),
    listAgents: async () => [
      ...(await getCodingAgentsStatus()).tools
        .filter(tool => tool.installed)
        .map(tool => ({ id: tool.id, name: tool.name })),
      ...(hermesCliAvailable() ? [{ id: 'hermes', name: AGENT_LABELS.hermes }] : []),
    ],
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
  try {
    const repaired = repairHerdrChatModes()
    if (repaired) logger.info({ repaired }, '[herdr] chats started in herdr now resume with their agent\'s own configuration')
  } catch (error) { logger.warn(error, '[herdr] could not check herdr chat modes') }
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
