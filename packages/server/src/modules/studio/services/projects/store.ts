import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Projects: a coordinator chat plus the threads it starts, like Claude's
 * projects. Each project is a Studio chat folder; its threads are chats whose
 * agents run in herdr (see docs/projects.md). This file keeps what a folder
 * cannot: the instructions, which chat coordinates and which chats are threads.
 */

/** herdr's agent states, plus `gone` (the pane closed) and `starting` (launched, not reported yet). */
export type ProjectThreadStatus = 'starting' | 'working' | 'blocked' | 'done' | 'idle' | 'unknown' | 'gone'

/**
 * Where a thread is in its life, for the person (docs/projects.md#thread-stages).
 * The same names as FAITH's projects: working, needs_you (blocked or failed),
 * review (finished, the person has not opened it since), done (finished and
 * seen) and resolved (put away: hidden, and reopened by new work).
 */
export type ThreadStage = 'working' | 'needs_you' | 'review' | 'done' | 'resolved'
export const THREAD_STAGES: ThreadStage[] = ['needs_you', 'working', 'review', 'done', 'resolved']
/** Done threads are resolved after this many days unless the project says otherwise; 0 turns it off. */
export const AUTO_RESOLVE_DAYS = 3
export const AUTO_RESOLVE_DAYS_MAX = 90

export interface ProjectThread {
  id: string
  title: string
  /** Studio agent id (claude-code, codex, hermes, ...). */
  agent: string
  /** The model its agent runs, '' for the agent's own default. */
  model: string
  /** The provider for that model, '' for the agent's own. */
  provider: string
  /** The brief the thread started with. */
  brief: string
  /** The herdr pane its agent was launched in. */
  paneId: string
  /** The Studio chat, once herdr reports the agent's session (agents herdr detects) or at once (the rest). */
  sessionId: string
  /** Where its agent works: its own git worktree, or the project folder when it has none. */
  workspace: string
  /** The thread's git branch when it has its own worktree, else ''. */
  branch: string
  status: ProjectThreadStatus
  /** The person or the coordinator marked the thread finished; it moves to Resolved. */
  resolved: boolean
  /** Its agent stopped (herdr pane closed) while it was working or waiting: it needs the person. */
  failed: boolean
  /** When it last finished a turn (done, idle or stopped), 0 when it has not. */
  finishedAt: number
  /** When the person last opened it, 0 when never. Opening it after it finished turns review into done. */
  seenAt: number
  /** When it was last resolved, by anyone, 0 when never. */
  resolvedAt: number
  /** The pull request (or merge request) its work went to, '' when none yet. */
  pr: string
  createdAt: number
  updatedAt: number
}

/** A fact the project keeps: every thread and the coordinator get it (docs/projects.md#memory). */
export interface ProjectMemory {
  id: string
  text: string
  /** 'person', 'coordinator' or 'thread <id>'. */
  by: string
  createdAt: number
}

/** Something a project produced for the person: a file on the Studio host or a link (docs/projects.md#artifacts). */
export interface ProjectArtifact {
  id: string
  title: string
  /** An absolute file path, or an http(s) URL. */
  ref: string
  kind: 'file' | 'link'
  /** The thread that made it, '' for the coordinator or the person. */
  threadId: string
  createdAt: number
}

/** A board column for a task. Threads take theirs from their status (docs/projects.md#board). */
export type ProjectTaskColumn = 'todo' | 'doing' | 'review' | 'done'
export const TASK_COLUMNS: ProjectTaskColumn[] = ['todo', 'doing', 'review', 'done']

/** A card on the project's board that is not (yet) a thread: a to-do, or a PR to follow. */
export interface ProjectTask {
  id: string
  title: string
  notes: string
  column: ProjectTaskColumn
  pr: string
  /** The thread started from this task; the board then shows the thread instead. */
  threadId: string
  createdAt: number
  updatedAt: number
}

export interface Project {
  id: string
  name: string
  /** Where its threads start: the project's folder on the Studio host. */
  folder: string
  /** The git URL the folder was cloned from, '' when the folder came first. */
  repo: string
  /** Rules every thread and the coordinator get, like a project's instructions in Claude. */
  instructions: string
  profile: string
  /** The Studio chat folder (session category) that holds its chats. */
  categoryId: number | null
  /** The chat that coordinates the project. */
  coordinatorSessionId: string
  /** Agent new threads use when none is named. */
  defaultAgent: string
  /** Model new threads use when none is named, '' for each agent's own default. */
  defaultModel: string
  /** When the folder is a git repo, each thread works in its own worktree and branch. */
  worktrees: boolean
  /** The coordinator gets a turn when a thread finishes or needs the person. */
  wakeCoordinator: boolean
  /** Done threads are resolved after this many days; 0 never (docs/projects.md#thread-stages). */
  autoResolveDays: number
  threads: ProjectThread[]
  tasks: ProjectTask[]
  memory: ProjectMemory[]
  artifacts: ProjectArtifact[]
  createdAt: number
  updatedAt: number
}

export const PROJECT_NAME_MAX = 80
export const PROJECT_INSTRUCTIONS_MAX = 8000
export const THREAD_BRIEF_MAX = 20000
export const THREAD_TITLE_MAX = 120
export const THREADS_MAX = 200
export const TASKS_MAX = 500
export const TASK_NOTES_MAX = 4000
export const PR_MAX = 500
export const MEMORY_MAX = 200
export const ARTIFACTS_MAX = 300
export const MEMORY_TEXT_MAX = 1000

const STATUSES = new Set<ProjectThreadStatus>(['starting', 'working', 'blocked', 'done', 'idle', 'unknown', 'gone'])

function text(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max)
}

/** A link to a pull request: an http(s) URL with no spaces, else ''. */
export function prLink(value: unknown): string {
  const link = text(value, PR_MAX)
  return /^https?:\/\/[^\s<>"]+$/i.test(link) ? link : ''
}

/** A time that may be unset (0). */
function stamp(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Whole days 0 to 90; anything else is the default. */
export function autoResolveDays(value: unknown): number {
  if (value === null || value === undefined || value === '') return AUTO_RESOLVE_DAYS
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= AUTO_RESOLVE_DAYS_MAX ? n : AUTO_RESOLVE_DAYS
}

function time(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function normalizeThread(raw: any, now = Date.now()): ProjectThread | null {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, 64)
  if (!id) return null
  const status = STATUSES.has(raw.status) ? raw.status as ProjectThreadStatus : 'unknown'
  return {
    id,
    title: text(raw.title, THREAD_TITLE_MAX) || 'Thread',
    agent: text(raw.agent, 80),
    model: text(raw.model, 200),
    provider: text(raw.provider, 120),
    brief: text(raw.brief, THREAD_BRIEF_MAX),
    paneId: text(raw.paneId, 80),
    sessionId: text(raw.sessionId, 200),
    workspace: text(raw.workspace, 1024),
    branch: text(raw.branch, 200),
    status,
    resolved: raw.resolved === true,
    failed: raw.failed === true,
    finishedAt: stamp(raw.finishedAt),
    seenAt: stamp(raw.seenAt),
    resolvedAt: stamp(raw.resolvedAt),
    pr: prLink(raw.pr),
    createdAt: time(raw.createdAt, now),
    updatedAt: time(raw.updatedAt, now),
  }
}

export function normalizeArtifact(raw: any, now = Date.now()): ProjectArtifact | null {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, 64)
  const ref = text(raw.ref, 2048)
  const kind = raw.kind === 'link' ? 'link' : 'file'
  if (!id || !ref || (kind === 'link' ? !prLink(ref) : !ref.startsWith('/'))) return null
  return { id, title: text(raw.title, THREAD_TITLE_MAX) || ref.split('/').filter(Boolean).at(-1) || ref, ref, kind, threadId: text(raw.threadId, 64), createdAt: time(raw.createdAt, now) }
}

export function normalizeMemory(raw: any, now = Date.now()): ProjectMemory | null {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, 64)
  const body = text(raw.text, MEMORY_TEXT_MAX)
  if (!id || !body) return null
  return { id, text: body, by: text(raw.by, 80) || 'person', createdAt: time(raw.createdAt, now) }
}

export function normalizeTask(raw: any, now = Date.now()): ProjectTask | null {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, 64)
  const title = text(raw.title, THREAD_TITLE_MAX)
  if (!id || !title) return null
  return {
    id,
    title,
    notes: text(raw.notes, TASK_NOTES_MAX),
    column: TASK_COLUMNS.includes(raw.column) ? raw.column : 'todo',
    pr: prLink(raw.pr),
    threadId: text(raw.threadId, 64),
    createdAt: time(raw.createdAt, now),
    updatedAt: time(raw.updatedAt, now),
  }
}

export function normalizeProject(raw: any, now = Date.now()): Project | null {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, 64)
  const name = text(raw.name, PROJECT_NAME_MAX)
  if (!id || !name) return null
  const categoryId = Number(raw.categoryId)
  return {
    id,
    name,
    folder: text(raw.folder, 1024),
    repo: text(raw.repo, 500),
    instructions: text(raw.instructions, PROJECT_INSTRUCTIONS_MAX),
    profile: text(raw.profile, 128) || 'default',
    categoryId: Number.isInteger(categoryId) && categoryId > 0 ? categoryId : null,
    coordinatorSessionId: text(raw.coordinatorSessionId, 200),
    defaultAgent: text(raw.defaultAgent, 80) || 'claude-code',
    defaultModel: text(raw.defaultModel, 200),
    worktrees: raw.worktrees !== false,
    wakeCoordinator: raw.wakeCoordinator !== false,
    autoResolveDays: autoResolveDays(raw.autoResolveDays),
    threads: (Array.isArray(raw.threads) ? raw.threads : [])
      .map((thread: unknown) => normalizeThread(thread, now))
      .filter((thread: ProjectThread | null): thread is ProjectThread => !!thread)
      .slice(-THREADS_MAX),
    tasks: (Array.isArray(raw.tasks) ? raw.tasks : [])
      .map((task: unknown) => normalizeTask(task, now))
      .filter((task: ProjectTask | null): task is ProjectTask => !!task)
      .slice(-TASKS_MAX),
    memory: (Array.isArray(raw.memory) ? raw.memory : [])
      .map((item: unknown) => normalizeMemory(item, now))
      .filter((item: ProjectMemory | null): item is ProjectMemory => !!item)
      .slice(-MEMORY_MAX),
    artifacts: (Array.isArray(raw.artifacts) ? raw.artifacts : [])
      .map((item: unknown) => normalizeArtifact(item, now))
      .filter((item: ProjectArtifact | null): item is ProjectArtifact => !!item)
      .slice(-ARTIFACTS_MAX),
    createdAt: time(raw.createdAt, now),
    updatedAt: time(raw.updatedAt, now),
  }
}

/** The project a chat belongs to: as its coordinator or as one of its threads. */
export function projectRoleOf(project: Project, sessionId: string): 'coordinator' | 'thread' | null {
  if (!sessionId) return null
  if (project.coordinatorSessionId === sessionId) return 'coordinator'
  return project.threads.some(thread => thread.sessionId === sessionId) ? 'thread' : null
}

/** JSON file under the Web UI home; writes are atomic and one at a time. */
export class ProjectStore {
  private cache: Project[] | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async list(): Promise<Project[]> {
    if (this.cache) return this.cache
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'))
      const list = Array.isArray(raw?.projects) ? raw.projects : []
      this.cache = list.map((item: unknown) => normalizeProject(item)).filter((item: Project | null): item is Project => !!item)
    } catch {
      this.cache = []
    }
    return this.cache!
  }

  async get(id: string): Promise<Project | null> {
    return (await this.list()).find(project => project.id === id) || null
  }

  /** A project by id, or by name (case-insensitive) for agents that only know its name. */
  async find(idOrName: string): Promise<Project | null> {
    const key = String(idOrName || '').trim()
    if (!key) return null
    const list = await this.list()
    return list.find(project => project.id === key)
      || list.find(project => project.name.toLowerCase() === key.toLowerCase())
      || null
  }

  async forSession(sessionId: string): Promise<{ project: Project; role: 'coordinator' | 'thread' } | null> {
    for (const project of await this.list()) {
      const role = projectRoleOf(project, sessionId)
      if (role) return { project, role }
    }
    return null
  }

  async create(input: Omit<Project, 'id' | 'threads' | 'tasks' | 'memory' | 'artifacts' | 'createdAt' | 'updatedAt' | 'worktrees' | 'wakeCoordinator' | 'defaultModel' | 'repo' | 'autoResolveDays'> & Partial<Pick<Project, 'worktrees' | 'wakeCoordinator' | 'defaultModel' | 'repo' | 'autoResolveDays'>>): Promise<Project> {
    const now = Date.now()
    const project = normalizeProject({ ...input, id: randomUUID(), threads: [], tasks: [], memory: [], artifacts: [], createdAt: now, updatedAt: now }, now)
    if (!project) throw Object.assign(new Error('A project needs a name'), { status: 400 })
    await this.list()
    const list = this.cache!
    if (list.some(item => item.name.toLowerCase() === project.name.toLowerCase())) {
      throw Object.assign(new Error(`A project named “${project.name}” already exists`), { status: 409 })
    }
    await this.write([...list, project])
    return project
  }

  /** Change a project; `change` gets a copy and returns it changed. */
  async update(id: string, change: (project: Project) => Project): Promise<Project> {
    await this.list()
    const list = this.cache!
    const index = list.findIndex(project => project.id === id)
    if (index < 0) throw Object.assign(new Error('Project not found'), { status: 404 })
    const copy = structuredClone(list[index])
    const next = normalizeProject({ ...change(copy), id, createdAt: list[index].createdAt, updatedAt: Date.now() })
    if (!next) throw Object.assign(new Error('A project needs a name'), { status: 400 })
    if (list.some(item => item.id !== id && item.name.toLowerCase() === next.name.toLowerCase())) {
      throw Object.assign(new Error(`A project named “${next.name}” already exists`), { status: 409 })
    }
    const updated = [...list]
    updated[index] = next
    await this.write(updated)
    return next
  }

  async remove(id: string): Promise<Project | null> {
    await this.list()
    const list = this.cache!
    const project = list.find(item => item.id === id) || null
    if (project) await this.write(list.filter(item => item.id !== id))
    return project
  }

  // create, update and remove read this.cache after their await, not the value
  // list() returned: two changes that start together then each build on the
  // other's result instead of the later one overwriting the first (everything
  // from there to write() is synchronous).
  private async write(projects: Project[]): Promise<void> {
    this.cache = projects
    const job = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, `${JSON.stringify({ version: 1, projects: this.cache }, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.path)
    })
    this.writing = job.catch(() => undefined)
    await job
  }
}
