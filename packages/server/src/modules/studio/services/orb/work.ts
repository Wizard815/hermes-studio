import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { io, type Socket } from 'socket.io-client'
import { config } from '../../public/config'
import { getSession, updateSession } from '../../repositories/session-store'
import { getOrbClient } from './client'

/**
 * Pondering Orb sends work to Studio: a task or project becomes a new Studio
 * chat with a Studio agent (Ekko, Hermes or a coding agent) and the plan as its
 * first message. Studio follows the chat's run and tells Orb how the work goes
 * (orb_set_agent_status), so the task goes in progress and shows the agent's
 * state. Everything goes through Studio's own chat runs; herdr is not needed.
 */

/** The Orb task or project a chat works on. */
export interface OrbWorkRef {
  task?: { title: string; list: string }
  project?: string
}

/** Orb's agent states: working, blocked (needs you), done (finished its turn), idle, gone. */
export type OrbWorkStatus = 'working' | 'blocked' | 'done' | 'idle' | 'gone'

export interface OrbWork {
  sessionId: string
  title: string
  agentId: string
  orb: OrbWorkRef
  status: OrbWorkStatus
  startedAt: number
  updatedAt: number
  error?: string
}

/** Agents Orb can send work to. `ekko-agent` and `hermes` are Studio's own. */
export const ORB_WORK_AGENTS = ['ekko-agent', 'hermes', 'claude-code', 'codex', 'pi', 'grok', 'opencode'] as const
export type OrbWorkAgent = typeof ORB_WORK_AGENTS[number]

const MAX_KEPT = 200
/** A run that never ends still stops being followed after this long. */
const MAX_FOLLOW_MS = 12 * 60 * 60 * 1000

function invalid(message: string): Error {
  return Object.assign(new Error(message), { status: 400 })
}

export function cleanWorkRef(value: unknown): OrbWorkRef | null {
  const raw = (value && typeof value === 'object' ? value : {}) as { task?: { title?: unknown; list?: unknown }; project?: unknown }
  const title = String(raw.task?.title ?? '').trim().slice(0, 300)
  const project = String(raw.project ?? '').trim().slice(0, 200)
  if (title) return { task: { title, list: String(raw.task?.list ?? '').trim().slice(0, 200) } }
  if (project) return { project }
  return null
}

/** The chat-run payload that starts a new chat for this agent. */
export function workRunPayload(input: { agentId: OrbWorkAgent; prompt: string; workspace?: string; profile: string; sessionId: string }): Record<string, unknown> {
  const base: Record<string, unknown> = { input: input.prompt, session_id: input.sessionId, profile: input.profile }
  if (input.workspace) base.workspace = input.workspace
  if (input.agentId === 'hermes') return base
  // Coding agents use their own configuration; Ekko uses Studio's models.
  return { ...base, source: 'coding_agent', coding_agent_id: input.agentId, ...(input.agentId === 'ekko-agent' ? {} : { mode: 'global' }) }
}

/** Run events → Orb status. Null: no change. */
export function statusForEvent(event: string): OrbWorkStatus | null {
  if (event === 'run.started' || event === 'message.delta' || event === 'tool.started') return 'working'
  if (event === 'approval.requested' || event === 'clarify.requested' || event === 'run.failed') return 'blocked'
  if (event === 'run.completed') return 'done'
  return null
}

const FOLLOWED_EVENTS = ['run.started', 'message.delta', 'tool.started', 'run.completed', 'run.failed', 'approval.requested', 'clarify.requested']

type Connect = (token: string, profile: string) => Socket
type Report = (work: OrbWork) => Promise<void>

export class OrbWorkTracker {
  private work: OrbWork[] = []
  private loaded = false
  private sockets = new Map<string, Socket>()
  /** Reports reach Orb one at a time, in order, each with the state it was made for. */
  private reports: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly connect: Connect = defaultConnect,
    private readonly report: Report = reportToOrb,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      // Runs do not survive a Studio restart: work that was still going is no longer followed.
      this.work = (Array.isArray(raw) ? raw : []).map((item: OrbWork) => (item.status === 'working' ? { ...item, status: 'idle' as const } : item))
    } catch { this.work = [] }
  }

  /** Saves run one at a time (a run's first events can save while the chat is still being set up). */
  private saving: Promise<void> = Promise.resolve()

  private save(): Promise<void> {
    const next = this.saving.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, `${JSON.stringify(this.work.slice(0, MAX_KEPT), null, 2)}\n`)
      await rename(temp, this.file)
    })
    this.saving = next
    return next
  }

  async list(): Promise<OrbWork[]> {
    await this.load()
    return this.work.map(item => ({ ...item, title: getSession(item.sessionId)?.title || item.title }))
  }

  /** Start a new Studio chat for the work; resolves once the run is under way. */
  async start(input: { token: string; profile?: string; agentId: unknown; title?: unknown; prompt: unknown; workspace?: unknown; orb?: unknown }): Promise<OrbWork> {
    await this.load()
    const agentId = String(input.agentId || 'ekko-agent') as OrbWorkAgent
    if (!(ORB_WORK_AGENTS as readonly string[]).includes(agentId)) throw invalid('Studio cannot run that agent for Orb')
    const prompt = String(input.prompt ?? '').trim().slice(0, 20000)
    if (!prompt) throw invalid('Give the work a first message')
    if (!input.token) throw Object.assign(new Error('Sign in to Studio first'), { status: 401 })
    const orb = cleanWorkRef(input.orb) ?? {}
    const title = String(input.title ?? '').trim().slice(0, 80) || orb.task?.title || orb.project || prompt.slice(0, 60)
    const workspace = typeof input.workspace === 'string' && input.workspace.trim() ? input.workspace.trim() : undefined
    const profile = String(input.profile || 'default')
    const sessionId = randomUUID()
    const now = Date.now()
    // 'idle' until the run's first event, which reports 'working' to Orb in order with what follows.
    const work: OrbWork = { sessionId, title, agentId, orb, status: 'idle', startedAt: now, updatedAt: now }

    await new Promise<void>((resolve, reject) => {
      const socket = this.connect(input.token, profile)
      let started = false
      const stop = setTimeout(() => socket.disconnect(), MAX_FOLLOW_MS)
      stop.unref?.()
      const end = () => { clearTimeout(stop); socket.removeAllListeners(); socket.disconnect(); this.sockets.delete(sessionId) }
      socket.on('connect_error', (error: Error) => { end(); if (!started) reject(Object.assign(new Error(`Studio could not start the chat: ${error.message}`), { status: 503 })) })
      socket.on('connect', () => socket.emit('run', workRunPayload({ agentId, prompt, workspace, profile, sessionId })))
      for (const name of FOLLOWED_EVENTS) {
        socket.on(name, (event: { error?: unknown } = {}) => {
          if (!started && name === 'run.failed') { end(); reject(Object.assign(new Error(String(event?.error || 'Studio could not start the chat')), { status: 502 })); return }
          if (!started) { started = true; resolve() }
          const status = statusForEvent(name)
          if (name === 'run.failed') work.error = String(event?.error || 'failed')
          if (status) this.update(work, status)
          if (name === 'run.completed' || name === 'run.failed') end()
        })
      }
      this.sockets.set(sessionId, socket)
    })

    // The chat's name is the task's, so it is easy to find in Studio.
    try { if (getSession(sessionId)) updateSession(sessionId, { title }) } catch { /* the chat keeps its own title */ }
    this.work = [work, ...this.work.filter(item => item.sessionId !== sessionId)].slice(0, MAX_KEPT)
    await this.save()
    return { ...work }
  }

  private send(work: OrbWork): void {
    const snapshot = { ...work, orb: { ...work.orb } }
    this.reports = this.reports.then(() => this.report(snapshot)).catch(() => undefined)
  }

  private update(work: OrbWork, status: OrbWorkStatus): void {
    if (work.status === status) return
    work.status = status
    work.updatedAt = Date.now()
    this.send(work)
    void this.save().catch(() => undefined)
  }

  close(): void {
    for (const socket of this.sockets.values()) { socket.removeAllListeners(); socket.disconnect() }
    this.sockets.clear()
  }
}

function defaultConnect(token: string, profile: string): Socket {
  const base = (process.env.HERMES_WEB_UI_URL || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
  return io(`${base}/chat-run`, { auth: { token }, query: { profile }, transports: ['websocket', 'polling'], reconnection: false, timeout: 30_000 })
}

/** Orb shows the agent's state on the task or project (when Orb is connected). */
async function reportToOrb(work: OrbWork): Promise<void> {
  if (!work.orb.task && !work.orb.project) return
  const orb = getOrbClient()
  if (!(await orb.publicSettings()).url) return
  await orb.tool('orb_set_agent_status', {
    ...(work.orb.task ? { task: work.orb.task } : { project: work.orb.project }),
    status: work.status,
    agent: work.agentId,
  })
}

let tracker: OrbWorkTracker | null = null

export function configureOrbWork(file: string): OrbWorkTracker {
  tracker?.close()
  tracker = new OrbWorkTracker(file)
  return tracker
}

export function getOrbWork(): OrbWorkTracker {
  if (!tracker) throw Object.assign(new Error('Orb work is not set up'), { status: 503 })
  return tracker
}
