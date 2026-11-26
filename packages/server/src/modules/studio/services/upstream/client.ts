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
