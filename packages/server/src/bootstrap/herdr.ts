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
  getRecentSessionMessages,
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
import { cleanRoomHomes } from '../modules/coding-agents/services/cleanroom'
import type { HerdrBridgeDeps, HerdrSessionRef, HerdrWorkRef } from '../modules/coding-agents/services/herdr/bridge'
import { setupHerdrSocket } from '../modules/coding-agents/sockets/herdr'
import { getOrbClient } from '../modules/studio/services/orb/client'
import { writeModelRunProfileToken } from '../modules/studio/services/chat-run/model-run-prompt'
import { listUsers } from '../modules/studio/public/users'
import { issueModelRunJwt, type AuthenticatedUser } from '../modules/studio/public/auth'
import { chatAgentLabel } from '../modules/coding-agents/services/herdr/chat-spaces'

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
    locateTranscript: (agent, nativeId) => findChatTranscript(agent, nativeId),
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
    listChatSpaces: async () => listChatSpaces(),
    chatAccess: async sessionId => {
      const row = getSession(sessionId)
      if (!row) throw Object.assign(new Error('Chat not found'), { status: 404 })
      const user = herdrManager.actingUser() ?? listUsers().find(item => item.role === 'super_admin' && item.status === 'active') ?? null
      if (!user) throw Object.assign(new Error('Sign in to Studio first'), { status: 401 })
      const token = await issueModelRunJwt({ id: user.id, username: user.username, role: user.role as AuthenticatedUser['role'] })
      const stored = String(row.agent || '').trim()
      const name = stored === 'ekko-agent' || stored === 'ekko' ? 'Ekko' : !stored || stored === 'hermes' ? 'Hermes' : getCodingAgentDefinition(stored)?.name || stored
      return { token, profile: row.profile || 'default', run: chatRunFields(row), agent: chatAgentLabel(stored), name }
    },
    chatRecap: async sessionId => chatRecap(getSession(sessionId)?.title || '', getRecentSessionMessages(sessionId, 50).map(message => ({ role: message.role, text: messageText(message.content) }))),
    chatPreview: async sessionId => getRecentSessionMessages(sessionId, 6).map(message => ({ role: message.role, text: messageText(message.content) })).filter(message => message.text),
    chatPane: () => herdrManager.chatPaneSetup(),
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

/** A message's plain text for a chat card (content can be a string or content blocks). */
function messageText(content: unknown): string {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { return messageText(JSON.parse(trimmed)) } catch { return trimmed }
    }
    return trimmed
  }
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join(' ').trim()
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') return String((content as { text: string }).text).trim()
  return ''
}

/**
 * Every Studio chat (not archived, not a sub-chat), with its folder path, for
 * its herdr space. Chats herdr cannot run (Ekko) still get a space that shows
 * the chat and points to Studio.
 */
/** The longest recap handed to a fresh agent session (the newest messages win). */
const RECAP_LIMIT = 16_000

/**
 * The chat so far, for an agent starting a fresh session on an old chat: its
 * earlier agent session could not be resumed, so it reads the conversation
 * first. Newest messages are kept when the chat is long.
 */
export function chatRecap(title: string, messages: Array<{ role: string; text: string }>): string {
  const lines = messages.filter(message => message.text.trim())
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.trim().slice(0, 3000)}`)
  if (!lines.length) return ''
  const kept: string[] = []
  let size = 0
  for (const line of [...lines].reverse()) {
    if (size + line.length > RECAP_LIMIT && kept.length) break
    kept.unshift(line)
    size += line.length + 2
  }
  return [
    `This continues an earlier Studio chat${title ? ` ("${title}")` : ''}. Its previous agent session could not be restored, so here is the conversation so far${kept.length < lines.length ? ' (newest part)' : ''}.`,
    'Read it, briefly confirm where things stand, and wait for the next request. Do not act on it yet.',
    '',
    ...kept.join('\n\n').split('\n'),
  ].join('\n')
}

/**
 * A chat agent's transcript: in Studio's own agent folders, else in a clean
 * room's home folder (a clean-room agent writes there, see cleanRoomHome).
 */
export async function findChatTranscript(agent: string, nativeId: string, homes: () => string[] = cleanRoomHomes): Promise<string | null> {
  const own = await locateTranscript(agent, nativeId)
  if (own) return own
  for (const home of homes()) {
    const found = await locateTranscript(agent, nativeId, {}, home)
    if (found) return found
  }
  return null
}

/** Studio stores chat times in seconds; herdr's chat spaces work in milliseconds. */
export function toMs(time: number): number {
  return time > 0 && time < 1e12 ? time * 1000 : time
}

/** The run fields that continue a chat with its own agent, model and folder. */
export function chatRunFields(row: Pick<HermesSessionRow, 'id' | 'agent' | 'agent_mode' | 'model' | 'provider' | 'workspace'>): Record<string, unknown> {
  const fields: Record<string, unknown> = { session_id: row.id }
  if (row.workspace) fields.workspace = row.workspace
  if (row.model) fields.model = row.model
  if (row.provider) fields.provider = row.provider
  const stored = String(row.agent || '').trim()
  // Ekko uses Studio's models; other coding agents keep the chat's mode.
  if (stored === 'ekko-agent' || stored === 'ekko') return { ...fields, source: 'coding_agent', coding_agent_id: 'ekko-agent' }
  const agent = codingAgentIdForStoredAgent(stored)
  if (!agent) return fields
  return { ...fields, source: 'coding_agent', coding_agent_id: agent, mode: row.agent_mode === 'scoped' ? 'scoped' : 'global' }
}

/**
 * Every chat that can be a herdr space (not a sub-chat, archived, group chat
 * or workflow), newest first, read in pages: herdr's awake filter runs on the
 * whole list, so a chat past any page size keeps its space while awake.
 */
export function chatSpaceRows(list: (limit: number, offset: number) => HermesSessionRow[] = (limit, offset) => listSessions(undefined, undefined, limit, { lite: true, offset }), pageSize = 2000, max = 200000): HermesSessionRow[] {
  const rows: HermesSessionRow[] = []
  for (let offset = 0; offset < max; offset += pageSize) {
    const page = list(pageSize, offset)
    rows.push(...page.filter(row => !row.parent_session_id && !row.is_archived && row.source !== 'group_chat' && row.source !== 'workflow'))
    if (page.length < pageSize) break
  }
  return rows
}

function listChatSpaces() {
  const categories = listSessionCategories()
  const byId = new Map(categories.map(category => [category.id, category]))
  const pathOf = (id: number | null | undefined): string[] => {
    const names: string[] = []
    const seen = new Set<number>()
    let current = id != null ? byId.get(id) : undefined
    while (current && !seen.has(current.id) && names.length < 10) {
      seen.add(current.id)
      names.unshift(current.name)
      current = current.parent_id != null ? byId.get(current.parent_id) : undefined
    }
    return names
  }
  const hermesCli = hermesCliAvailable()
  return chatSpaceRows()
    .map(row => {
      // Hermes runs in herdr through its CLI; without it the chat is talked to through Studio.
      const hostable = herdrHostableAgentId(row.agent) === 'hermes' && !hermesCli ? null : herdrHostableAgentId(row.agent)
      return {
        id: row.id,
        title: row.title || '',
        folderPath: pathOf(row.category_id),
        agent: hostable || codingAgentIdForStoredAgent(row.agent) || String(row.agent || 'hermes'),
        hostable: !!hostable,
        workspace: row.workspace || null,
        lastActive: toMs(Number(row.last_active || row.started_at || 0)),
      }
    })
}

export function herdrPluginDeps(baseUrl: string): HerdrPluginDeps {
  return {
    // Every chat, old ones included (opening one wakes it in herdr); sub-chats,
    // archived chats, group chats and workflows stay out.
    listChats: (limit, options = {}) => {
      const query = String(options.query || '').trim().toLowerCase()
      return chatSpaceRows()
        .filter(row => !query || String(row.title || '').toLowerCase().includes(query))
        .slice(options.offset || 0, (options.offset || 0) + limit)
        .map(row => {
          const stored = String(row.agent || '').trim()
          return {
            id: row.id,
            title: row.title || '',
            agent: herdrHostableAgentId(stored) || (stored === 'ekko-agent' ? 'ekko' : codingAgentIdForStoredAgent(stored) || 'hermes'),
            updatedAt: Number(row.last_active || row.started_at || 0),
          }
        })
    },
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
    // New, renamed, moved or deleted chats: herdr's chat spaces follow.
    herdrManager.getBridge()?.scheduleChatSync()
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
