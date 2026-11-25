import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import {
  createSession,
  createSessionCategory,
  findSessionCategoryByName,
  getRecentSessionMessages,
  getSession,
  getSessionCategory,
  renameSessionCategory,
  setSessionCategory,
  updateSession,
  type HermesMessageRow,
} from '../../public/sessions'
import {
  PROJECT_INSTRUCTIONS_MAX,
  PROJECT_NAME_MAX,
  THREAD_BRIEF_MAX,
  THREAD_TITLE_MAX,
  ProjectStore,
  type Project,
  type ProjectThread,
  type ProjectThreadStatus,
} from './store'

/**
 * How project threads run. Bootstrap supplies it from herdr (a thread is an
 * agent launched in its own herdr space, filed in the project's folder), so
 * Studio itself never imports the Coding Agents module.
 */
export interface ProjectRuntime {
  /** Agents a thread can run (ids Studio knows, e.g. claude-code, codex, hermes). */
  canRun(agentId: string): boolean
  launch(input: {
    agentId: string
    title: string
    prompt: string
    workspace: string
    project: { id: string; thread: string }
  }): Promise<{ paneId: string; sessionId?: string }>
  /** The Studio chat herdr linked to a pane, once the agent reported its session. */
  sessionForPane(paneId: string): string | null
  /** Live status of a thread's agent, when herdr knows it. */
  statusForPane(paneId: string): ProjectThreadStatus | null
  /** Send a message to a thread's agent (resuming it in herdr when it is not running). */
  message(input: { sessionId: string; paneId: string; text: string }): Promise<void>
}

export interface ProjectDeps {
  store: ProjectStore
  runtime: () => ProjectRuntime | null
  now?: () => number
}

export interface ThreadView extends ProjectThread {
  /** Live status from herdr when it knows it, else the last one reported. */
  liveStatus: ProjectThreadStatus
}

export interface ProjectView extends Omit<Project, 'threads'> {
  threads: ThreadView[]
  counts: { needsYou: number; working: number; done: number; resolved: number }
}

let defaultStore: ProjectStore | null = null
let runtime: ProjectRuntime | null = null

export function projectStore(): ProjectStore {
  if (!defaultStore) defaultStore = new ProjectStore(join(getWebUiHome(), 'projects', 'projects.json'))
  return defaultStore
}

/** Bootstrap wires herdr in here once herdr's bridge exists. */
export function setProjectRuntime(value: ProjectRuntime | null): void {
  runtime = value
}

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status })
}

function clean(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max)
}

/** A thread's message text (Studio stores plain text or content-block JSON). */
export function messageText(content: unknown): string {
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

/** States that need the person: an approval or question on screen. */
export function needsYou(status: ProjectThreadStatus): boolean {
  return status === 'blocked'
}

export function isWorking(status: ProjectThreadStatus): boolean {
  return status === 'working' || status === 'starting'
}

/** The first prompt a thread's agent gets: the project's rules, then the brief. */
export function threadPrompt(project: Pick<Project, 'name' | 'instructions'>, thread: Pick<ProjectThread, 'title' | 'brief'>): string {
  return [
    `You are working on one thread of the Studio project "${project.name}": ${thread.title}.`,
    project.instructions ? `Project instructions (they apply to every thread):\n${project.instructions}` : '',
    `Your task:\n${thread.brief}`,
    'Work only on this task. When you finish, end with a short summary of what you did and anything left open; the project\'s coordinator reads it.',
  ].filter(Boolean).join('\n\n')
}

/**
 * Per-turn context for a chat in a project (appended like Studio's other
 * context blocks). The coordinator gets the thread list and its tools; a
 * thread run through Studio gets the project's rules.
 */
export function projectContextBlock(project: ProjectView | Project, role: 'coordinator' | 'thread'): string {
  const lines: string[] = []
  if (role === 'coordinator') {
    lines.push(`You coordinate the Studio project "${project.name}" (project id ${project.id}). The person gives you a stream of related work here.`)
    lines.push('Answer directly when a request needs no separate work. For a task that takes real work, start a thread: ekko_studio_use_project with action start_thread and a self-contained brief (the thread does not see this chat). Check on threads with list and read_thread, steer them with message_thread, and resolve_thread when one is finished. Tell the person which threads you started and what each is for.')
    if (project.folder) lines.push(`Project folder: ${project.folder}`)
    if (project.instructions) lines.push(`Project instructions:\n${project.instructions}`)
    const open = project.threads.filter(thread => !thread.resolved)
    if (open.length) {
      lines.push('Open threads (id · title · agent · status):')
      for (const thread of open.slice(-30)) {
        const status = 'liveStatus' in thread ? thread.liveStatus : thread.status
        lines.push(`- ${thread.id} · ${thread.title} · ${thread.agent} · ${status}`)
      }
    } else {
      lines.push('No open threads.')
    }
  } else {
    lines.push(`This chat is a thread of the Studio project "${project.name}".`)
    if (project.instructions) lines.push(`Project instructions:\n${project.instructions}`)
  }
  return `<studio_project_context>\n${lines.join('\n')}\n</studio_project_context>`
}

export class ProjectService {
  constructor(private readonly deps: ProjectDeps) {}

  private get store() { return this.deps.store }
  private now() { return this.deps.now ? this.deps.now() : Date.now() }

  private requireRuntime(): ProjectRuntime {
    const value = this.deps.runtime()
    if (!value) fail('Projects run their threads in herdr. Turn herdr on in Agents → herdr first.', 409)
    return value
  }

  /** Threads with their chat and status filled in from herdr where it knows them. */
  view(project: Project): ProjectView {
    const rt = this.deps.runtime()
    const threads: ThreadView[] = project.threads.map(thread => {
      const sessionId = thread.sessionId || (thread.paneId && rt?.sessionForPane(thread.paneId)) || ''
      const live = thread.paneId ? rt?.statusForPane(thread.paneId) ?? null : null
      return { ...thread, sessionId, liveStatus: live || thread.status }
    })
    const open = threads.filter(thread => !thread.resolved)
    return {
      ...project,
      threads,
      counts: {
        needsYou: open.filter(thread => needsYou(thread.liveStatus)).length,
        working: open.filter(thread => isWorking(thread.liveStatus)).length,
        done: open.filter(thread => thread.liveStatus === 'done' || thread.liveStatus === 'idle' || thread.liveStatus === 'gone').length,
        resolved: threads.length - open.length,
      },
    }
  }

  async list(): Promise<ProjectView[]> {
    return (await this.store.list()).map(project => this.view(project))
  }

  async get(idOrName: string): Promise<ProjectView> {
    const project = await this.store.find(idOrName)
    if (!project) fail('Project not found', 404)
    return this.view(project)
  }

  /** The project of a chat (coordinator or thread), for its turn context and the agent tools. */
  async forSession(sessionId: string): Promise<{ project: ProjectView; role: 'coordinator' | 'thread' } | null> {
    if (!sessionId) return null
    const direct = await this.store.forSession(sessionId)
    if (direct) return { project: this.view(direct.project), role: direct.role }
    // Agents herdr detects get their chat after launch: look the pane's chat up.
    for (const project of await this.store.list()) {
      const view = this.view(project)
      if (view.threads.some(thread => thread.sessionId === sessionId)) return { project: view, role: 'thread' }
    }
    return null
  }

  async contextFor(sessionId: string): Promise<string> {
    const found = await this.forSession(sessionId).catch(() => null)
    return found ? projectContextBlock(found.project, found.role) : ''
  }

  /**
   * New project: a Studio chat folder named after it (an existing folder of the
   * same name is reused, so a folder can become a project) and its coordinator chat.
   */
  async create(input: { name?: unknown; folder?: unknown; instructions?: unknown; profile?: unknown; defaultAgent?: unknown; userId?: string | number | null }): Promise<ProjectView> {
    const name = clean(input.name, PROJECT_NAME_MAX)
    if (!name) fail('Give the project a name', 400)
    const profile = clean(input.profile, 128) || 'default'
    const folder = clean(input.folder, 1024)
    const category = findSessionCategoryByName(name, null) || createSessionCategory(name, null)
    const coordinatorId = randomUUID()
    createSession({
      id: coordinatorId,
      profile,
      source: 'cli',
      agent: 'hermes',
      user_id: input.userId ?? null,
      title: `${name} · coordinator`,
      workspace: folder || undefined,
      category_id: category?.id ?? null,
    })
    try {
      const project = await this.store.create({
        name,
        folder,
        instructions: clean(input.instructions, PROJECT_INSTRUCTIONS_MAX),
        profile,
        categoryId: category?.id ?? null,
        coordinatorSessionId: coordinatorId,
        defaultAgent: clean(input.defaultAgent, 80) || 'claude-code',
      })
      return this.view(project)
    } catch (error) {
      // The name was taken: the coordinator chat made above stays as an ordinary chat in that folder.
      updateSession(coordinatorId, { title: `${name} · chat` })
      throw error
    }
  }

  async update(id: string, change: { name?: unknown; folder?: unknown; instructions?: unknown; defaultAgent?: unknown }): Promise<ProjectView> {
    const project = await this.store.update(id, current => ({
      ...current,
      ...(change.name !== undefined ? { name: clean(change.name, PROJECT_NAME_MAX) || current.name } : {}),
      ...(change.folder !== undefined ? { folder: clean(change.folder, 1024) } : {}),
      ...(change.instructions !== undefined ? { instructions: clean(change.instructions, PROJECT_INSTRUCTIONS_MAX) } : {}),
      ...(change.defaultAgent !== undefined ? { defaultAgent: clean(change.defaultAgent, 80) || current.defaultAgent } : {}),
    }))
    if (change.name !== undefined && project.categoryId && getSessionCategory(project.categoryId)?.name !== project.name) {
      try { renameSessionCategory(project.categoryId, project.name) } catch { /* a folder of that name exists: keep the old folder name */ }
    }
    return this.view(project)
  }

  /** Stop treating a folder as a project. Its chats and folder stay. */
  async remove(id: string): Promise<{ removed: boolean }> {
    return { removed: !!(await this.store.remove(id)) }
  }

  /** Start a thread: an agent launched in herdr with the project's rules and the brief. */
  async startThread(idOrName: string, input: { title?: unknown; brief?: unknown; agent?: unknown }): Promise<ThreadView> {
    const project = await this.store.find(idOrName)
    if (!project) fail('Project not found', 404)
    const brief = clean(input.brief, THREAD_BRIEF_MAX)
    if (!brief) fail('A thread needs a brief: what should it do?', 400)
    const title = clean(input.title, THREAD_TITLE_MAX) || brief.split('\n')[0].slice(0, 60)
    const agent = clean(input.agent, 80) || project.defaultAgent
    const rt = this.requireRuntime()
    if (!rt.canRun(agent)) fail(`${agent} cannot run in herdr. Pick an agent installed on this Studio.`, 400)
    if (project.threads.length >= 200) fail('This project has 200 threads. Remove resolved ones before starting more.', 409)
    const threadId = randomUUID().slice(0, 8)
    const launched = await rt.launch({
      agentId: agent,
      title,
      prompt: threadPrompt(project, { title, brief }),
      workspace: project.folder,
      project: { id: project.id, thread: threadId },
    })
    const now = this.now()
    const thread: ProjectThread = {
      id: threadId, title, agent, brief,
      paneId: launched.paneId,
      sessionId: launched.sessionId || '',
      status: 'starting', resolved: false, createdAt: now, updatedAt: now,
    }
    const saved = await this.store.update(project.id, current => ({ ...current, threads: [...current.threads, thread] }))
    return this.view(saved).threads.find(item => item.id === threadId)!
  }

  private async thread(idOrName: string, threadId: string): Promise<{ project: Project; view: ProjectView; thread: ThreadView }> {
    const project = await this.store.find(idOrName)
    if (!project) fail('Project not found', 404)
    const view = this.view(project)
    const key = clean(threadId, 200)
    const thread = view.threads.find(item => item.id === key || (item.sessionId && item.sessionId === key))
    if (!thread) fail('Thread not found in this project', 404)
    return { project, view, thread }
  }

  async messageThread(idOrName: string, threadId: string, text: unknown): Promise<{ ok: true }> {
    const body = clean(text, THREAD_BRIEF_MAX)
    if (!body) fail('The message is empty', 400)
    const { thread } = await this.thread(idOrName, threadId)
    if (thread.liveStatus === 'blocked') fail('The thread is waiting for an approval or an answer on its screen. Ask the person to answer it in the thread.', 409)
    await this.requireRuntime().message({ sessionId: thread.sessionId, paneId: thread.paneId, text: body })
    return { ok: true }
  }

  /** The thread's latest messages, for the coordinator (it sees results, not every step). */
  async readThread(idOrName: string, threadId: string, limit = 6): Promise<{ thread: ThreadView; messages: Array<{ role: string; text: string }> }> {
    const { thread } = await this.thread(idOrName, threadId)
    const rows: HermesMessageRow[] = thread.sessionId && getSession(thread.sessionId) ? getRecentSessionMessages(thread.sessionId, Math.max(1, Math.min(20, limit))) : []
    return {
      thread,
      messages: rows.map(row => ({ role: row.role, text: messageText(row.content).slice(0, 4000) })).filter(row => row.text),
    }
  }

  async setResolved(idOrName: string, threadId: string, resolved: boolean): Promise<ThreadView> {
    const { project, thread } = await this.thread(idOrName, threadId)
    const saved = await this.store.update(project.id, current => ({
      ...current,
      threads: current.threads.map(item => item.id === thread.id ? { ...item, resolved, sessionId: item.sessionId || thread.sessionId, updatedAt: this.now() } : item),
    }))
    return this.view(saved).threads.find(item => item.id === thread.id)!
  }

  /** An existing chat joins the project as a thread (its history stays). */
  async adoptChat(idOrName: string, sessionId: string): Promise<ThreadView> {
    const project = await this.store.find(idOrName)
    if (!project) fail('Project not found', 404)
    const row = getSession(sessionId)
    if (!row) fail('Chat not found', 404)
    if (project.coordinatorSessionId === sessionId) fail('That chat is the project\'s coordinator', 409)
    const existing = await this.forSession(sessionId)
    if (existing) fail(`That chat is already in the project “${existing.project.name}”`, 409)
    if (project.categoryId) setSessionCategory(sessionId, project.categoryId)
    const now = this.now()
    const thread: ProjectThread = {
      id: randomUUID().slice(0, 8),
      title: clean(row.title, THREAD_TITLE_MAX) || 'Chat',
      agent: row.agent || 'hermes',
      brief: '',
      paneId: '',
      sessionId,
      status: 'idle',
      resolved: false,
      createdAt: now,
      updatedAt: now,
    }
    const saved = await this.store.update(project.id, current => ({ ...current, threads: [...current.threads, thread] }))
    return this.view(saved).threads.find(item => item.id === thread.id)!
  }

  /** A thread leaves the project and is an ordinary chat again (its folder stays as it is). */
  async releaseChat(idOrName: string, threadId: string): Promise<{ ok: true }> {
    const { project, thread } = await this.thread(idOrName, threadId)
    await this.store.update(project.id, current => ({ ...current, threads: current.threads.filter(item => item.id !== thread.id) }))
    return { ok: true }
  }

  /** herdr reported a status for a thread's agent (bootstrap forwards the bridge's work reports). */
  async threadStatusChanged(ref: { id: string; thread: string }, paneId: string, status: string, sessionId?: string | null): Promise<void> {
    const project = await this.store.get(ref.id)
    if (!project || !project.threads.some(thread => thread.id === ref.thread)) return
    const next = (['working', 'blocked', 'done', 'idle', 'unknown', 'gone'] as const).find(value => value === status) || 'unknown'
    await this.store.update(project.id, current => ({
      ...current,
      threads: current.threads.map(thread => thread.id !== ref.thread ? thread : {
        ...thread,
        status: next,
        paneId: thread.paneId || paneId,
        sessionId: thread.sessionId || sessionId || '',
        updatedAt: this.now(),
      }),
    }))
  }

  /** Where a thread's agent starts and which folder its chat goes in. */
  async folderFor(ref: { id: string }): Promise<{ categoryId: number | null; workspace: string } | null> {
    const project = await this.store.get(ref.id)
    return project ? { categoryId: project.categoryId, workspace: project.folder } : null
  }
}

let defaultService: ProjectService | null = null

export function projectService(): ProjectService {
  if (!defaultService) defaultService = new ProjectService({ store: projectStore(), runtime: () => runtime })
  return defaultService
}
