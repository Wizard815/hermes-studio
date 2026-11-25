import { logger } from '../../public/logging'

/**
 * Upstream Manager (repos, upstreams, tasks for coding agents) as Studio sees it.
 *
 * Studio shows Upstream in its Upstream tab through `/upstream` (see
 * `middleware/upstream-upkeep-proxy.ts`), and the two work in tandem:
 *
 * - Opening the tab hands Upstream Studio's address and a login (headers on the
 *   proxied requests), so Upstream can call Studio back with no setup.
 * - On Studio's machine Upstream starts its herdr agents through Studio's herdr
 *   bridge (`POST /api/coding-agents/herdr/agents` with `upstream: {task}`), so
 *   each one is a Studio chat in its herdr space.
 * - Studio then tells Upstream how each such agent is doing (here), as it tells
 *   Pondering Orb for Orb work, and a chat shows the Upstream task it is for.
 *
 * Upstream's address is `UPSTREAM_UPKEEP_TARGET` (default http://127.0.0.1:5001).
 */

export interface UpstreamWorkRef {
  /** Upstream's task id. */
  task: string
  title?: string
  /** The repo's name (files the chat in a Studio folder of that name, if there is one). */
  repo?: string
}

export function upstreamTarget(env: NodeJS.ProcessEnv = process.env): string {
  return (env.UPSTREAM_UPKEEP_TARGET || 'http://127.0.0.1:5001').replace(/\/+$/, '')
}

/** The path Studio serves Upstream under (the proxy's prefix). */
export function upstreamPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return `/${(env.UPSTREAM_UPKEEP_PATH_PREFIX || '/upstream').replace(/^\/+/, '').replace(/\/+$/, '') || 'upstream'}`
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/

/** A launch request's `upstream` field, checked; undefined when absent or malformed. */
export function upstreamWorkRef(input: unknown): UpstreamWorkRef | undefined {
  const value = input as { task?: unknown; title?: unknown; repo?: unknown } | null
  const task = String(value?.task ?? '').trim()
  if (!value || !TASK_ID.test(task)) return undefined
  const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)
  return { task, ...(value.title ? { title: text(value.title, 300) } : {}), ...(value.repo ? { repo: text(value.repo, 120) } : {}) }
}

async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 4000)
  try {
    return await fetchImpl(`${upstreamTarget()}${path}`, {
      ...init,
      // Upstream trusts what its Studio proxy sends: this header, from this machine (or an
      // address in its UPSTREAM_TRUSTED_PROXIES).
      headers: { 'content-type': 'application/json', 'x-upstream-base': upstreamPrefix(), ...(init.headers as Record<string, string> || {}) },
      redirect: 'manual',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Tell Upstream how the herdr agent Studio started for one of its tasks is doing. */
export async function reportUpstreamAgentStatus(ref: UpstreamWorkRef | undefined, paneId: string, status: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!ref || !TASK_ID.test(ref.task)) return
  try {
    const res = await call(`/api/tasks/${encodeURIComponent(ref.task)}/agent-status`, {
      method: 'POST',
      body: JSON.stringify({ status, pane: paneId }),
    }, fetchImpl)
    if (!res.ok) logger.warn({ status: res.status, task: ref.task }, '[upstream] Upstream did not take the agent status')
  } catch (err) {
    logger.warn({ err: String(err), task: ref.task }, '[upstream] could not reach Upstream to report agent status')
  }
}

export interface UpstreamStatus {
  target: string
  reachable: boolean
  error?: string
  /** Tasks with an agent or waiting (Upstream's Work count). */
  openTasks?: number
}

/** Whether Upstream answers, for Studio's Upstream tab. */
export async function upstreamStatus(fetchImpl: typeof fetch = fetch): Promise<UpstreamStatus> {
  const target = upstreamTarget()
  try {
    const res = await call('/api/tasks', { method: 'GET', timeoutMs: 2500 }, fetchImpl)
    if (!res.ok) return { target, reachable: false, error: `Upstream answered ${res.status}` }
    const body = await res.json().catch(() => ({})) as { items?: Array<{ status?: string }> }
    const openTasks = Array.isArray(body.items) ? body.items.filter(t => t.status === 'open' || t.status === 'working').length : undefined
    return { target, reachable: true, ...(openTasks !== undefined ? { openTasks } : {}) }
  } catch (err) {
    const text = String((err as Error)?.message || err)
    return { target, reachable: false, error: /abort/i.test(text) ? 'timed out' : /ECONNREFUSED|fetch failed/i.test(text) ? 'nothing is listening there (is Upstream running?)' : text.slice(0, 200) }
  }
}

// ---------------------------------------------------------------- the Overseer and its board, from Studio

export interface UpstreamOverview {
  reachable: boolean
  error?: string
  /** When the Overseer last looked. */
  at?: string
  /** The open tasks in the order agents get them. */
  next: Array<{ id: string; title: string; repo: string; priority?: string }>
  working: Array<{ id: string; title: string; repo: string; agent?: string | null }>
  waitingForYou: number
  unread: number
  agents: number
}

/** What Upstream's Overseer sees now, for the summary at the top of Studio's Upstream tab. */
export async function upstreamOverview(fetchImpl: typeof fetch = fetch): Promise<UpstreamOverview> {
  const empty: UpstreamOverview = { reachable: false, next: [], working: [], waitingForYou: 0, unread: 0, agents: 0 }
  try {
    const [o, n] = await Promise.all([
      call('/api/overseer', { method: 'GET', timeoutMs: 3000 }, fetchImpl),
      call('/api/notifications?limit=1', { method: 'GET', timeoutMs: 3000 }, fetchImpl),
    ])
    if (!o.ok) return { ...empty, error: `Upstream answered ${o.status}` }
    const rep = ((await o.json().catch(() => ({}))) as { report?: any }).report || {}
    const notes = n.ok ? await n.json().catch(() => ({})) as { unread?: number } : {}
    const list = (v: unknown) => (Array.isArray(v) ? v : [])
    return {
      reachable: true,
      ...(rep.at ? { at: String(rep.at) } : {}),
      next: list(rep.next).slice(0, 5).map((t: any) => ({ id: String(t.id), title: String(t.title || ''), repo: String(t.repo || ''), priority: t.priority })),
      working: list(rep.working).slice(0, 10).map((t: any) => ({ id: String(t.id), title: String(t.title || ''), repo: String(t.repo || ''), agent: t.agent ?? null })),
      waitingForYou: list(rep.waiting_for_you).length,
      unread: Number(notes.unread) || 0,
      agents: list(rep.agents).length,
    }
  } catch (err) {
    const text = String((err as Error)?.message || err)
    return { ...empty, error: /abort/i.test(text) ? 'timed out' : 'Upstream is not reachable' }
  }
}

/** The name Upstream's tools get in a Hermes profile's mcp_servers. */
export const UPSTREAM_MCP_NAME = 'upstream-manager'

export interface UpstreamMcpServer { command: string; args: string[]; env: Record<string, string> }

/** How a client on this machine starts Upstream's MCP server, as Upstream says (`GET /api/mcp`). */
export async function upstreamMcpServer(fetchImpl: typeof fetch = fetch): Promise<UpstreamMcpServer | null> {
  try {
    const res = await call('/api/mcp', { method: 'GET', timeoutMs: 3000 }, fetchImpl)
    if (!res.ok) return null
    const m = await res.json().catch(() => ({})) as { stdio_command?: unknown; stdio_env?: unknown }
    const cmd = Array.isArray(m.stdio_command) ? m.stdio_command.map(String) : []
    if (!cmd.length || !cmd[0]) return null
    const env = m.stdio_env && typeof m.stdio_env === 'object' ? Object.fromEntries(Object.entries(m.stdio_env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {}
    return { command: cmd[0], args: cmd.slice(1), env }
  } catch {
    return null
  }
}

export interface ProfileConfigAccess {
  read: (profile: string) => Promise<Record<string, any>>
  update: <T>(profile: string, fn: (current: Record<string, any>) => { data: Record<string, any>; result: T; write?: boolean }) => Promise<T>
}

/** Whether a Hermes profile already has Upstream's tools. */
export async function hermesHasUpstreamTools(profile: string, cfg: ProfileConfigAccess): Promise<boolean> {
  const current = await cfg.read(profile).catch(() => ({} as Record<string, any>))
  const servers = current?.mcp_servers && typeof current.mcp_servers === 'object' ? current.mcp_servers : {}
  return Object.keys(servers).some(key => key.toLowerCase() === UPSTREAM_MCP_NAME || key.toLowerCase() === 'upstream')
}

/**
 * Give a Hermes profile Upstream's tools (the board, the Overseer, repos, tasks): its chats in Studio and the
 * `hermes` agents herdr starts with that profile can then take work with next_task, talk on tasks, and so on.
 * An entry the user already has is left as it is. Returns whether one was added.
 */
export async function giveHermesUpstreamTools(profile: string, server: UpstreamMcpServer, cfg: ProfileConfigAccess): Promise<boolean> {
  return (await cfg.update<boolean>(profile, (current) => {
    const data = current && typeof current === 'object' ? current : {}
    const servers = data.mcp_servers && typeof data.mcp_servers === 'object' && !Array.isArray(data.mcp_servers) ? data.mcp_servers : {}
    if (Object.keys(servers).some(key => key.toLowerCase() === UPSTREAM_MCP_NAME || key.toLowerCase() === 'upstream')) {
      return { data, result: false, write: false }
    }
    data.mcp_servers = { ...servers, [UPSTREAM_MCP_NAME]: { command: server.command, args: server.args, env: server.env } }
    return { data, result: true }
  })) === true
}
