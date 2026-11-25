import { homedir } from 'node:os'
import { folderFor } from '../modules/coding-agents/services/herdr/folders'
import { existsSync, readdirSync } from 'node:fs'
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
  createSessionCategory,
  renameSessionCategory,
  moveSessionCategory,
  deleteSessionCategory,
  setSessionCategory,
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
import { listProfileModelChoices, listProfileModelGroups } from '../modules/hermes/controllers/models'
import { getProfileDir, listProfileNamesFromDisk } from '../modules/hermes/services/profiles/profile'
import { hermesCliAvailable, hermesInteractiveLaunch, hermesNewChatLaunch, hermesSessionIdFor } from '../modules/hermes/services/herdr-launch'
import { HerdrHermesLaunchStore, herdrModelChange, logicalHermesRoute, readHermesSessionRoute, type ModelRoute } from '../modules/hermes/services/herdr-model-sync'
import { importAccountProviders, withProviderAccount } from '../modules/studio/public/provider-account'
import { hermesGatewaySelection, synchronizeHermesProvider } from '../modules/studio/public/provider-projection'
import { logicalModelSelection } from '../modules/studio/public/model-routing'
import { readConfigYamlForProfile } from '../modules/studio/public/provider-config'

/**
 * A chat's stored agent as herdr sees it. Chats with no stored agent are
 * Hermes chats (older Studio chats were saved that way), so they are 'hermes',
 * except Ekko's own chats (source 'builtin_agent').
 */
export function herdrStoredAgent(agent: string | null | undefined, source?: string | null): string {
  return String(agent || '').trim() || (source === 'builtin_agent' ? 'ekko-agent' : 'hermes')
}

/** The stored agent id when herdr can host the chat as a pane, else null. */
export function herdrHostableAgentId(agent: string | null | undefined, source?: string | null): string | null {
  const stored = herdrStoredAgent(agent, source)
  const id = codingAgentIdForStoredAgent(stored) || stored
  return herdrKindForStudioAgent(id) ? id : null
}
import { herdrChatMode, herdrKindForStudioAgent } from '../modules/coding-agents/services/herdr/protocol'
import { locateTranscript } from '../modules/coding-agents/services/herdr/transcript'
import { cleanRoomHomes } from '../modules/coding-agents/services/cleanroom'
import type { HerdrBridgeDeps, HerdrSessionRef, HerdrWorkRef } from '../modules/coding-agents/services/herdr/bridge'
import { setupHerdrSocket } from '../modules/coding-agents/sockets/herdr'
import { getOrbClient } from '../modules/studio/services/orb/client'
import { reportUpstreamAgentStatus } from '../modules/studio/services/upstream/client'
import { writeModelRunProfileToken } from '../modules/studio/services/chat-run/model-run-prompt'
import { listUsers } from '../modules/studio/public/users'
import { issueModelRunJwt, type AuthenticatedUser } from '../modules/studio/public/auth'
import { chatAgentLabel } from '../modules/coding-agents/services/herdr/chat-spaces'
import { SpaceFolderSync, spaceFoldersFile, type SpaceFolderChat } from '../modules/coding-agents/services/herdr/space-folder-sync'
import { orderedCategories } from '../modules/coding-agents/services/herdr/space-folder-file'
import { recordWatcherEvent } from '../modules/studio/public/watcher'

function toRef(row: HermesSessionRow | null): HerdrSessionRef | null {
  if (!row) return null
  return {
    id: row.id,
    agent: codingAgentIdForStoredAgent(row.agent) || herdrStoredAgent(row.agent, row.source),
    title: row.title,
    workspace: row.workspace || null,
    agent_native_session_id: row.agent_native_session_id || '',
    message_count: row.message_count,
    category_id: row.category_id ?? null,
    profile: row.profile || 'default',
  }
}

let hermesLaunchStore: HerdrHermesLaunchStore | null = null
/** Chats whose agent runs in a herdr pane now (not just its waiting pane). */
const liveChats = new Set<string>()
function hermesLaunches(): HerdrHermesLaunchStore {
  if (!hermesLaunchStore) hermesLaunchStore = new HerdrHermesLaunchStore(join(getWebUiHome(), 'herdr', 'hermes-models.json'))
  return hermesLaunchStore
}

/**
 * A Hermes chat's pane is done (or about to start again): keep a model picked
 * with `/model` in the pane as the chat's model, unless Studio's model picker
 * changed it since (see `herdr-model-sync.ts`).
 */
/**
 * Studio's model providers belong to a Studio account (upstream's model
 * gateway). herdr acts for the user who signed it in (else the first super
 * administrator), so launches and model lookups run in that account.
 */
function herdrAccountUser() {
  return herdrManager.actingUser() ?? listUsers().find(item => item.role === 'super_admin' && item.status === 'active') ?? null
}
export async function inHerdrAccount<T>(profile: string | null | undefined, run: () => Promise<T>): Promise<T> {
  const user = herdrAccountUser()
  if (!user) return run()
  return withProviderAccount(user.id, async () => { await importAccountProviders(); return run() }, profile || undefined)
}

/** A Hermes session's model (read from its state.db) in Studio's provider/model terms. */
async function hermesSessionModel(profile: string, row: { id: string; agent_native_session_id?: string | null }): Promise<ModelRoute | null> {
  const raw = await readHermesSessionRoute(getProfileDir(profile), hermesSessionIdFor(row))
  return logicalHermesRoute(raw, model => {
    try { return logicalModelSelection(profile, 'ekkostudio', model) } catch { return null }
  })
}

/** The profile's default model as Studio's model manager has it (logical provider and model). */
async function profileDefaultModel(profile: string): Promise<ModelRoute> {
  const config = await readConfigYamlForProfile(profile)
  const selection = config.model && typeof config.model === 'object' ? config.model : { default: config.model }
  return { model: String(selection.default || '').trim(), provider: String(selection.provider || '').trim() }
}

/** How a Hermes pane asks for a chat's model: the gateway route, after the profile's Hermes config is projected. */
async function hermesPaneRoute(profile: string, provider?: string | null, model?: string | null) {
  await synchronizeHermesProvider(profile)
  if (!model || !provider || provider === 'global') return null
  try {
    const selected = await hermesGatewaySelection(profile, provider, model)
    return selected.provider === 'moa' ? null : { model: selected.model }
  } catch (error) {
    logger.warn({ profile, provider, model, error: String(error) }, '[herdr] chat model is not in the model gateway; the pane uses it as is')
    return null
  }
}

export async function syncHermesModelFromHerdr(sessionId: string, options: { forget?: boolean } = {}): Promise<HermesSessionRow | null> {
  const row = getSession(sessionId)
  return inHerdrAccount(row?.profile, () => syncHermesModelFromHerdrInAccount(sessionId, options))
}

async function syncHermesModelFromHerdrInAccount(sessionId: string, options: { forget?: boolean }): Promise<HermesSessionRow | null> {
  const store = hermesLaunches()
  const record = store.get(sessionId)
  const row = getSession(sessionId)
  if (!record || !row || herdrStoredAgent(row.agent, row.source) !== 'hermes') return row
  const hermesNow = await hermesSessionModel(row.profile || 'default', row)
  const change = herdrModelChange(record, { model: row.model || '', provider: row.provider || '' }, hermesNow)
  if (change) {
    updateSession(sessionId, { model: change.model, provider: change.provider })
    notifySessionListChanged({ type: 'updated', sessionId })
    logger.info({ sessionId, model: change.model, provider: change.provider }, '[herdr] chat keeps the model picked in its herdr pane')
  }
  if (options.forget) store.delete(sessionId)
  else if (change) store.set(sessionId, { ...record, studio: change, hermes: hermesNow!, launched: change.model, at: Date.now() })
  return change ? getSession(sessionId) : row
}

/** Open a Hermes chat in herdr in its profile, on its model, remembering both for `syncHermesModelFromHerdr`. */
async function hermesChatLaunch(sessionId: string) {
  const first = getSession(sessionId)
  return inHerdrAccount(first?.profile, async () => {
    const row = (await syncHermesModelFromHerdrInAccount(sessionId, {}))!
    const profile = row.profile || 'default'
    const route = await hermesPaneRoute(profile, row.provider, row.model)
    const hermes = await hermesSessionModel(profile, row) ?? { model: '', provider: '' }
    const profileDefault = await profileDefaultModel(profile)
    hermesLaunches().set(sessionId, {
      studio: { model: row.model || '', provider: row.provider || '' },
      hermes,
      launched: row.model || profileDefault.model,
      at: Date.now(),
    })
    return hermesInteractiveLaunch(row, getProfileDir, route)
  })
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
    setLink: (sessionId, link) => {
      setSessionHerdrLink(sessionId, link)
      if (link && !link.waiting) { liveChats.add(sessionId); return }
      // The chat's agent left its pane: a model picked there with /model stays the chat's.
      if (!liveChats.delete(sessionId)) return
      void syncHermesModelFromHerdr(sessionId, { forget: true }).catch(error => logger.warn({ sessionId, error: String(error) }, '[herdr] could not read the model of a Hermes pane'))
    },
    notifyUpdated: sessionId => notifySessionListChanged({ type: 'updated', sessionId }),
    locateTranscript: (agent, nativeId) => findChatTranscript(agent, nativeId),
    // Hermes chats resume as `hermes chat` panes (herdr has a hermes
    // integration); everything else goes through the coding-agent launcher.
    prepareSessionLaunch: async sessionId => {
      const session = getSession(sessionId)
      return session && herdrStoredAgent(session.agent, session.source) === 'hermes' ? hermesChatLaunch(sessionId) : inHerdrAccount(session?.profile, () => prepareCodingAgentSessionLaunch(sessionId))
    },
    // A new Hermes chat runs in herdr's profile (Studio's, unless pinned) on its default model, or the model picked,
    // through Studio's model gateway like every other Hermes run.
    prepareAgentLaunch: async (agentId, input) => agentId === 'hermes'
      ? inHerdrAccount(input.profile, async () => hermesNewChatLaunch(input.workspace, {
          profile: input.profile, provider: input.provider, model: input.model, profileHome: getProfileDir,
          route: await hermesPaneRoute(input.profile || 'default', input.provider, input.model),
        }))
      : inHerdrAccount(input.profile, () => prepareCodingAgentInteractiveLaunch(agentId, {
          profile: input.profile,
          provider: input.provider,
          model: input.model,
          workspace: input.workspace,
          // Without a provider the agent runs with its own native configuration.
          mode: input.provider ? 'scoped' : 'global',
        })),
    herdrKindFor: agentId => herdrKindForStudioAgent(agentId),
    agentLabel: agentId => AGENT_LABELS[agentId] || getCodingAgentDefinition(agentId)?.name || agentId,
    log: (level, message, data) => logger[level](data || {}, message),
    workStatusChanged: async (data, paneId, status, agent) => {
      await Promise.all([reportOrbAgentStatus(data.orb, status, agent), reportUpstreamAgentStatus(data.upstream, paneId, status)])
    },
    folderForWork,
    categoryForSpace,
    listChatSpaces: () => listChatSpaces(),
    chatAccess: async sessionId => {
      const row = getSession(sessionId)
      if (!row) throw Object.assign(new Error('Chat not found'), { status: 404 })
      const user = herdrManager.actingUser() ?? listUsers().find(item => item.role === 'super_admin' && item.status === 'active') ?? null
      if (!user) throw Object.assign(new Error('Sign in to Studio first'), { status: 401 })
      const token = await issueModelRunJwt({ id: user.id, username: user.username, role: user.role as AuthenticatedUser['role'] })
      const stored = herdrStoredAgent(row.agent, row.source)
      const name = stored === 'ekko-agent' || stored === 'ekko' ? 'Ekko' : stored === 'hermes' ? 'Hermes' : getCodingAgentDefinition(stored)?.name || stored
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
  // An Upstream task's agent works in the task's own branch folder: only its chat is filed (in the
  // Studio folder named after the repo, if there is one), the folder's start directory is not used.
  if (ref.upstream && !ref.orb) {
    const repo = (ref.upstream.repo || '').trim().toLowerCase()
    const match = repo ? listSessionCategories().find(category => category.name.trim().toLowerCase() === repo) : undefined
    return match ? { categoryId: match.id, workspace: '' } : null
  }
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
export async function findChatTranscript(agent: string, nativeId: string, homes: () => string[] = cleanRoomHomes, configHomes: (agent: string) => string[] = studioAgentConfigHomes): Promise<string | null> {
  const own = await locateTranscript(agent, nativeId)
  if (own) return own
  for (const home of homes()) {
    const found = await locateTranscript(agent, nativeId, {}, home)
    if (found) return found
  }
  // Agents on Studio's providers keep their sessions in Studio's config folders
  // (CODEX_HOME / CLAUDE_CONFIG_DIR point there), in and out of clean rooms.
  for (const dir of configHomes(agent)) {
    const env = agent === 'codex' ? { CODEX_HOME: dir } : { CLAUDE_CONFIG_DIR: dir }
    const found = await locateTranscript(agent, nativeId, env)
    if (found) return found
  }
  return null
}

/** Studio's per-provider config folders for an agent: coding-agent/model/<profile>/<provider>/<agent>[/runs/<id>]. */
export function studioAgentConfigHomes(agent: string, root = join(getWebUiHome(), 'coding-agent', 'model')): string[] {
  if (agent !== 'codex' && agent !== 'claude-code') return []
  const out: string[] = []
  const dirs = (path: string) => { try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name)) } catch { return [] } }
  for (const profile of dirs(root)) {
    for (const provider of dirs(profile)) {
      const home = join(provider, agent)
      if (!existsSync(home)) continue
      out.push(home, ...dirs(join(home, 'runs')))
      if (out.length > 400) return out
    }
  }
  return out
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

async function listChatSpaces() {
  const categories = listSessionCategories()
  const byId = new Map(categories.map(category => [category.id, category]))
  // Folders in the order Studio's herdr page shows them (herdr's own space order follows it).
  const meta = await herdrManager.folders().load().catch(() => null)
  const position = new Map(meta ? orderedCategories(categories, meta).map((item, index) => [item.category.id, index]) : [])
  const rankOf = (id: number | null | undefined): number[] => {
    const ranks: number[] = []
    const seen = new Set<number>()
    let current = id != null ? byId.get(id) : undefined
    while (current && !seen.has(current.id) && ranks.length < 10) {
      seen.add(current.id)
      ranks.unshift(position.get(current.id) ?? Infinity)
      current = current.parent_id != null ? byId.get(current.parent_id) : undefined
    }
    return ranks
  }
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
      const agent = herdrHostableAgentId(row.agent, row.source)
      const hostable = agent === 'hermes' && !hermesCli ? null : agent
      return {
        id: row.id,
        title: row.title || '',
        folderPath: pathOf(row.category_id),
        folderRank: rankOf(row.category_id),
        agent: hostable || codingAgentIdForStoredAgent(row.agent) || herdrStoredAgent(row.agent, row.source),
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
          const stored = herdrStoredAgent(row.agent, row.source)
          return {
            id: row.id,
            title: row.title || '',
            agent: herdrHostableAgentId(stored) || (stored === 'ekko-agent' || stored === 'ekko' ? 'ekko' : codingAgentIdForStoredAgent(stored) || 'hermes'),
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
    listProviders: profile => inHerdrAccount(profile, () => listProfileModelGroups(profile)),
    profileDefault: profile => inHerdrAccount(profile, async () => (await listProfileModelChoices(profile)).default),
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

/** Every chat as Studio's herdr page lists it, with its folder and (awake) herdr space. */
function spaceFolderChats(): SpaceFolderChat[] {
  const spaces = herdrManager.getBridge()?.chatWorkspaces() ?? {}
  return chatSpaceRows().map(row => ({
    id: row.id,
    title: row.title || '',
    agent: codingAgentIdForStoredAgent(row.agent) || herdrStoredAgent(row.agent, row.source),
    categoryId: row.category_id ?? null,
    workspace: row.workspace || null,
    workspaceId: spaces[row.id] || null,
    lastActive: toMs(Number(row.last_active || row.started_at || 0)),
  }))
}

/** Studio's space folders, kept in sync with herdr-space-folders' file in this machine's home. */
function startSpaceFolders(): SpaceFolderSync {
  const sync = new SpaceFolderSync({
    file: spaceFoldersFile(),
    store: herdrManager.folders(),
    enabled: () => herdrManager.getSettings().enabled,
    categories: () => listSessionCategories(),
    chats: spaceFolderChats,
    createCategory: (name, parentId) => createSessionCategory(name, parentId),
    renameCategory: (id, name) => { renameSessionCategory(id, name) },
    moveCategory: (id, parentId) => { moveSessionCategory(id, parentId) },
    deleteCategory: id => { deleteSessionCategory(id) },
    setChatCategory: (sessionId, categoryId) => {
      if (setSessionCategory(sessionId, categoryId)) notifySessionListChanged({ type: 'updated', sessionId })
    },
    changed: () => {
      herdrManager.foldersChanged()
      // herdr's own space order follows the folders.
      herdrManager.getBridge()?.scheduleChatSync()
    },
    log: (level, message, data) => logger[level](data || {}, message),
  })
  herdrManager.setSpaceFolders(sync)
  sync.start()
  return sync
}

/** Configure and (if enabled) connect the herdr bridge. Never blocks startup on herdr. */
export function startHerdrIntegration(io: Server, baseUrl: string): { close: () => void } {
  const home = getWebUiHome()
  herdrManager.configure(herdrBridgeDeps(), {
    settingsFile: join(home, 'herdr', 'settings.json'),
    stateFile: join(home, 'herdr', 'bridge-state.json'),
  }, herdrPluginDeps(baseUrl))
  const socket = setupHerdrSocket(io)
  const folders = startSpaceFolders()
  try {
    const repaired = repairHerdrChatModes()
    if (repaired) logger.info({ repaired }, '[herdr] chats started in herdr now resume with their agent\'s own configuration')
  } catch (error) { logger.warn(error, '[herdr] could not check herdr chat modes') }
  stopListChanges = onSessionListChanged(change => {
    if (change.type === 'deleted') void herdrManager.getBridge()?.forgetSession(change.sessionId)
    // New, renamed, moved or deleted chats: herdr's chat spaces follow.
    herdrManager.getBridge()?.scheduleChatSync()
    folders.soon()
  })
  void herdrManager.init().catch(error => {
    logger.warn(error, '[herdr] integration failed to start')
    recordWatcherEvent({ kind: 'connection', severity: 'warn', text: `herdr did not start: ${String(error?.message || error).slice(0, 200)}`, link: '/hermes/chat?center=herdr' })
  })
  return {
    close: () => {
      stopListChanges?.(); stopListChanges = null
      folders.stop()
      herdrManager.setSpaceFolders(null)
      socket.close()
      herdrManager.shutdown()
    },
  }
}
