/**
 * Browser tasks: browser-use (https://github.com/browser-use/browser-use) drives
 * the browser the panel shows, with a model from Studio's providers (Argos for
 * llama.cpp, OpenRouter, any OpenAI-compatible server). docs/browser-tasks.md.
 *
 * One task at a time. bin/browser-use-task.py runs it with the Python that has
 * browser-use; it reports steps as JSON lines, which go to the panel as
 * `browser.task` socket events.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

// Studio's provider catalog, loaded when a model is listed or resolved (keeps the runner light to import).
async function catalog() {
  const [{ apiMode, unifiedCatalog }, { resolveProviderUpstream }] = await Promise.all([
    import('../model-api/service'),
    import('../../public/provider-upstream'),
  ])
  return { apiMode, unifiedCatalog, resolveProviderUpstream }
}

export interface BrowserTaskStep { n: number; text: string; at: number }
export type BrowserTaskStatus = 'running' | 'completed' | 'max_steps' | 'timeout' | 'stopped' | 'error'
export interface BrowserTaskState {
  id: string
  task: string
  model: string
  status: BrowserTaskStatus
  steps: BrowserTaskStep[]
  startedAt: number
  finishedAt?: number
  result?: string
  success?: boolean | null
  costUsd?: number | null
  error?: string | null
  version?: string
}

export interface BrowserTaskModel { id: string; provider: string; model: string }

/** A model the runner can call: resolved to an OpenAI-compatible endpoint. */
export interface ResolvedTaskModel { id: string; model: string; baseUrl: string; apiKey: string }

export interface StartTaskInput { task: string; model: string; maxSteps?: number; timeout?: number; vision?: boolean }

export interface BrowserTaskDeps {
  /** The panel browser's DevTools endpoint ('' when no browser is running). */
  cdpUrl: () => Promise<string>
  /** Called with every state change (the controller broadcasts it). */
  onUpdate?: (state: BrowserTaskState) => void
  /** While a task runs, tabs it opens become the panel's active tab. */
  setFollowTabs?: (on: boolean) => void
  resolveModel?: (id: string) => Promise<ResolvedTaskModel>
  python?: () => string | null
  script?: () => string | null
}

const MAX_TASK_LENGTH = 4000
const MAX_STEPS_KEPT = 200
const DONE: ReadonlySet<string> = new Set(['completed', 'max_steps', 'timeout', 'stopped', 'error'])

/** bin/browser-use-task.py, in the source tree or the build. */
export function runnerScript(): string | null {
  const candidates = [
    resolve(__dirname, '..', '..', '..', '..', '..', '..', '..', 'bin', 'browser-use-task.py'),
    resolve(__dirname, '..', 'bin', 'browser-use-task.py'),
    resolve(__dirname, '..', '..', 'bin', 'browser-use-task.py'),
    resolve(process.cwd(), 'bin', 'browser-use-task.py'),
  ]
  return candidates.find(path => existsSync(path)) || null
}

let checkedPython: { python: string | null; version?: string; error?: string } | undefined

/** The first Python that can import browser_use: BROWSER_USE_PYTHON, the image's venv, then python3. */
export function findBrowserUsePython(script = runnerScript(), refresh = false): { python: string | null; version?: string; error?: string } {
  if (checkedPython && !refresh) return checkedPython
  const candidates = [process.env.BROWSER_USE_PYTHON, '/opt/browser-use/bin/python', 'python3'].filter((c): c is string => !!c)
  let error = 'browser-use is not installed'
  if (!script) return (checkedPython = { python: null, error: 'bin/browser-use-task.py is missing from this build' })
  for (const python of candidates) {
    if (python.includes('/') && !existsSync(python)) continue
    const check = spawnSync(python, ['-I', script, '--check'], { encoding: 'utf8', timeout: 30_000 })
    try {
      const answer = JSON.parse((check.stdout || '').trim().split('\n').at(-1) || '{}')
      if (answer.ok) return (checkedPython = { python, version: answer.version })
      if (answer.error) error = String(answer.error)
    } catch { /* not this one */ }
  }
  return (checkedPython = { python: null, error })
}

function chatCompletionsCapable(mode: string | undefined): boolean {
  return !mode || mode === 'chat_completions'
}

/** Studio's models that speak OpenAI chat completions (what browser-use's ChatOpenAI calls). */
export async function listTaskModels(): Promise<BrowserTaskModel[]> {
  const { apiMode, unifiedCatalog } = await catalog()
  const models: BrowserTaskModel[] = []
  for (const [id, entry] of await unifiedCatalog([])) {
    if (entry.group.model_meta?.[entry.model]?.disabled) continue
    if (!chatCompletionsCapable(apiMode(entry.group, entry.model))) continue
    models.push({ id, provider: entry.group.provider, model: entry.model })
  }
  return models
}

export async function resolveTaskModel(id: string): Promise<ResolvedTaskModel> {
  const { apiMode, unifiedCatalog, resolveProviderUpstream } = await catalog()
  const entry = (await unifiedCatalog([])).get(id)
  if (!entry || entry.group.model_meta?.[entry.model]?.disabled) throw new BrowserTaskError('That model is not available. Pick another one.', 404)
  const mode = apiMode(entry.group, entry.model)
  if (!chatCompletionsCapable(mode)) throw new BrowserTaskError('Browser tasks need a model with an OpenAI-compatible chat API (Argos, OpenRouter, llama.cpp).', 400)
  const upstream = await resolveProviderUpstream({ profile: entry.profile, provider: entry.group.provider, model: entry.model, apiMode: mode })
  if (!upstream.baseUrl) throw new BrowserTaskError('The provider of that model has no address set.', 503)
  return { id, model: entry.model, baseUrl: upstream.baseUrl.replace(/\/+$/, ''), apiKey: upstream.apiKey || '' }
}

export class BrowserTaskError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export class BrowserTaskRunner {
  private current: BrowserTaskState | null = null
  private child: ChildProcess | null = null
  private counter = 0

  constructor(private readonly deps: BrowserTaskDeps) {}

  state(): BrowserTaskState | null {
    return this.current ? { ...this.current, steps: [...this.current.steps] } : null
  }

  running(): boolean {
    return this.current?.status === 'running'
  }

  async start(input: StartTaskInput): Promise<BrowserTaskState> {
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (!task) throw new BrowserTaskError('Say what the browser should do.')
    if (task.length > MAX_TASK_LENGTH) throw new BrowserTaskError(`Keep the task under ${MAX_TASK_LENGTH} characters.`)
    if (!input.model || typeof input.model !== 'string') throw new BrowserTaskError('Pick a model for the task.')
    if (this.running()) throw new BrowserTaskError('A browser task is already running. Stop it first.', 409)

    const script = (this.deps.script || runnerScript)()
    const python = this.deps.python ? this.deps.python() : findBrowserUsePython(script).python
    if (!script || !python) {
      const why = findBrowserUsePython(script).error
      throw new BrowserTaskError(`browser-use is not installed for Studio (${why}). Set BROWSER_USE_PYTHON to a Python with browser-use==1.0.4.`, 503)
    }
    const cdpUrl = await this.deps.cdpUrl()
    if (!cdpUrl) throw new BrowserTaskError('The browser is not running, so there is nothing to drive.', 503)
    const resolved = await (this.deps.resolveModel || resolveTaskModel)(input.model)

    const state: BrowserTaskState = {
      id: `task-${Date.now().toString(36)}-${++this.counter}`,
      task, model: resolved.id, status: 'running', steps: [], startedAt: Date.now(),
    }
    this.current = state
    this.deps.setFollowTabs?.(true)

    const child = spawn(python, ['-I', script], {
      // The key goes by environment, never on the command line.
      env: { ...process.env, BROWSER_TASK_API_KEY: resolved.apiKey, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    let stderr = ''
    child.stderr?.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-4000)
      if (process.env.BROWSER_TASK_DEBUG === '1') process.stderr.write(`[browser-use] ${chunk}`)
    })
    createInterface({ input: child.stdout! }).on('line', line => this.onLine(state, line))
    child.on('error', error => this.finish(state, { status: 'error', error: `Could not start browser-use: ${error.message}` }))
    child.on('close', code => {
      if (state.status === 'running') {
        const tail = stderr.trim().split('\n').slice(-3).join(' ')
        this.finish(state, { status: 'error', error: `browser-use stopped (exit ${code})${tail ? `: ${tail}` : ''}` })
      }
      if (this.child === child) this.child = null
    })
    child.stdin?.end(JSON.stringify({
      task, cdp_url: cdpUrl, model: resolved.model, base_url: resolved.baseUrl,
      max_steps: input.maxSteps, timeout: input.timeout, vision: input.vision !== false,
    }))
    this.emit(state)
    return this.state()!
  }

  stop(): BrowserTaskState | null {
    if (!this.running() || !this.child) return this.state()
    const child = this.child
    child.kill('SIGTERM')
    // A run that ignores SIGTERM is killed; the browser stays (it is Studio's).
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000).unref()
    return this.state()
  }

  private onLine(state: BrowserTaskState, line: string): void {
    let event: any
    try { event = JSON.parse(line) } catch { return }
    if (!event || typeof event !== 'object' || state.status !== 'running') return
    if (event.type === 'started') {
      state.version = typeof event.version === 'string' ? event.version : undefined
    } else if (event.type === 'step' && Number.isInteger(event.n)) {
      state.steps.push({ n: event.n, text: String(event.text ?? '').slice(0, 600), at: Date.now() })
      if (state.steps.length > MAX_STEPS_KEPT) state.steps.shift()
    } else if (event.type === 'done') {
      const status = DONE.has(event.status) ? event.status : 'error'
      this.finish(state, {
        status, result: typeof event.text === 'string' ? event.text : undefined,
        success: typeof event.success === 'boolean' ? event.success : null,
        costUsd: typeof event.cost_usd === 'number' ? event.cost_usd : null,
        error: typeof event.error === 'string' ? event.error : null,
      })
      return
    } else return
    this.emit(state)
  }

  private finish(state: BrowserTaskState, patch: Partial<BrowserTaskState>): void {
    if (state.status !== 'running') return
    Object.assign(state, patch, { finishedAt: Date.now() })
    this.deps.setFollowTabs?.(false)
    this.emit(state)
  }

  private emit(state: BrowserTaskState): void {
    if (this.current !== state) return
    this.deps.onUpdate?.(this.state()!)
  }
}

let runner: BrowserTaskRunner | null = null
export function getBrowserTaskRunner(): BrowserTaskRunner | null { return runner }
export function setBrowserTaskRunner(next: BrowserTaskRunner | null): void { runner = next }
