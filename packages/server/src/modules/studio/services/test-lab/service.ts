import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { basename, dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { LabDocker, LABEL_APP, memoryBytes, runLabels, type ContainerSpec } from './docker'
import { isBuildUrl, loadTemplates, pullReference, runnerScriptFile, builtinTemplateDir, type LoadedTemplate, type TemplateProblem } from './templates'
import { parseReport, type ParsedReport } from './report'
import { buildsFromForge, forgeBuildContext } from './forge-build'
import { forgeConfig, type ForgeConfig } from '../forge'
import { pinModel, testLabSessionId, unpinModel } from './pin'

/**
 * Test Lab (docs/test-lab.md): a throwaway set of app containers on a private
 * Docker network, test data in them, and one agent that tests them through a
 * browser and their APIs on one pinned model with a spending cap; then a
 * report, screenshots, logs and the exact cost, and the containers removed.
 */

export interface TestLabSettings {
  /** Docker Hub images are pulled through this mirror (empty: from Docker Hub). */
  registryMirror: string
  runnerImage: string
  browserImage: string
  defaultCapUsd: number
  defaultMinutes: number
  maxSteps: number
}

export const DEFAULT_TEST_LAB_SETTINGS: TestLabSettings = {
  registryMirror: 'mirror.gcr.io',
  runnerImage: 'node:24-bookworm-slim',
  browserImage: 'chromedp/headless-shell:157.0.8103.27',
  defaultCapUsd: 0.5,
  defaultMinutes: 20,
  maxSteps: 40,
}

export interface LabModel { id: string; provider: string; model: string; profile: string; apiMode?: string }

export type StepKey = 'images' | 'network' | 'apps' | 'health' | 'seed' | 'agent' | 'report' | 'cleanup'
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type AppState = 'pending' | 'pulling' | 'building' | 'starting' | 'running' | 'healthy' | 'unhealthy' | 'failed' | 'skipped' | 'removed'
export type RunStatus = 'starting' | 'running' | 'passed' | 'failed' | 'stopped' | 'error'
export type StopReason = 'cap' | 'time' | 'user' | 'limit' | 'restart'

export interface RunApp {
  id: string
  name: string
  url: string
  state: AppState
  message?: string
  logins: Array<{ username: string; password: string; role?: string }>
  containerId?: string
  image?: string
}

export interface TranscriptLine { at: number; role: 'assistant' | 'tool' | 'system'; tool?: string; text: string }

export interface TestLabRun {
  id: string
  createdAt: number
  finishedAt?: number
  createdBy: number
  status: RunStatus
  stopReason?: StopReason
  message?: string
  model: LabModel
  capUsd: number
  minutes: number
  instructions: string
  keepRunning: boolean
  browser: boolean
  steps: Array<{ key: StepKey; state: StepState; detail?: string }>
  apps: RunApp[]
  transcript: TranscriptLine[]
  screenshots: string[]
  logs: string[]
  cost: { gatewayUsd: number; tokens: number; unpricedCalls: number; openrouterBefore?: number; openrouterAfter?: number; openrouterUsd?: number; openrouterError?: string }
  report?: ParsedReport
  network?: string
  removed?: boolean
  removedAt?: number
}

export interface StartRunInput {
  model: string
  apps: string[]
  instructions?: string
  capUsd?: number
  minutes?: number
  keepRunning?: boolean
  browser?: boolean
  builds?: Record<string, string>
}

export interface GatewayRegistration { dispose(): void }
export interface OpenRouterUsage { usage: number }

export interface TestLabDeps {
  /** HERMES_WEB_UI_HOME/test-lab */
  home: () => string
  /** The homelab forge (tests); unset reads forgeConfig(). */
  forge?: ForgeConfig | null
  /** Build context for a forge repo (tests); unset clones with FORGE_TOKEN. */
  forgeContext?: (gitUrl: string, forge: ForgeConfig) => Promise<Buffer>
  docker: LabDocker
  /** Labels every object of this Studio, so two Studios on one Docker never remove each other's runs. */
  instance: string
  /** Models the user may pick (Studio's configured providers). */
  models: (userId: number, profile?: string) => Promise<LabModel[]>
  /** Register the run's credential with the model gateway (chat completions); Studio's tunnel sends it. */
  registerGateway: (input: { userId: number; model: LabModel; sessionId: string; runId: string; token: string }) => Promise<GatewayRegistration>
  gatewayPort: () => number
  /** Run limits for the run (cost cap and time), its spend so far, and forgetting it. */
  limits: {
    set: (sessionId: string, capUsd: number, minutes: number) => void
    spent: (sessionId: string) => { costUsd: number; tokens: number; unpricedCalls: number } | null
    forget: (sessionId: string) => void
  }
  /** OpenRouter key usage in USD (null: not an OpenRouter model). Throws when it cannot be read. */
  openRouterUsage: (model: LabModel, userId: number) => Promise<number | null>
  now?: () => number
  pollMs?: number
  log?: (message: string) => void
}

const ACTIVE: RunStatus[] = ['starting', 'running']
const DAY = 24 * 60 * 60_000
const STEP_KEYS: StepKey[] = ['images', 'network', 'apps', 'health', 'seed', 'agent', 'report', 'cleanup']
const MAX_TRANSCRIPT = 400

export class TestLabError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'test_lab') { super(message) }
}

function readJson<T>(file: string, fallback: T): T {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : fallback } catch { return fallback }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, file)
}

export function sanitizeSettings(raw: unknown, base: TestLabSettings = DEFAULT_TEST_LAB_SETTINGS): TestLabSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const next = { ...base }
  if (typeof input.registryMirror === 'string' && /^([a-z0-9.-]+(:\d+)?(\/[\w.-]+)*)?$/i.test(input.registryMirror.trim())) next.registryMirror = input.registryMirror.trim()
  for (const key of ['runnerImage', 'browserImage'] as const) {
    if (typeof input[key] === 'string' && /^[a-z0-9][\w./:@-]{0,200}$/i.test((input[key] as string).trim())) next[key] = (input[key] as string).trim()
  }
  const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined
  next.defaultCapUsd = number(input.defaultCapUsd, 0.01, 100) ?? next.defaultCapUsd
  next.defaultMinutes = number(input.defaultMinutes, 1, 240) ?? next.defaultMinutes
  next.maxSteps = Math.round(number(input.maxSteps, 1, 200) ?? next.maxSteps)
  return next
}

export function newRunId(now = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${stamp.slice(0, 8)}-${stamp.slice(8)}-${randomBytes(2).toString('hex')}`
}

const RUN_ID = /^\d{8}-\d{6}-[a-f0-9]{4}$/

/** Why the gateway refused the agent: the cost cap, the time limit, another run limit, or (undefined) a model outside the pin. */
export function refusalReason(message: string): StopReason | undefined {
  if (/pinned to/.test(message)) return undefined
  if (/cost limit/i.test(message)) return 'cap'
  if (/time limit/i.test(message)) return 'time'
  return 'limit'
}

/** Pass / fail of a finished run from its report and why it stopped. */
export function outcome(report: ParsedReport | undefined, stopReason?: StopReason): RunStatus {
  if (stopReason) return 'stopped'
  if (!report || !report.checks.length) return 'error'
  return report.failed ? 'failed' : 'passed'
}

export class TestLabService {
  private readonly active = new Map<string, { timer: ReturnType<typeof setInterval>; tunnel: Server; gateway?: GatewayRegistration; runner?: string; socketDir: string; progressOffset: number; finishing: boolean; deadline: number; lastOpenRouter: number; stopReason?: StopReason }>()

  constructor(private readonly deps: TestLabDeps) {}

  private now() { return this.deps.now?.() ?? Date.now() }
  private home() { return this.deps.home() }
  private runDir(id: string) {
    if (!RUN_ID.test(id)) throw new TestLabError('Unknown run', 404, 'test_lab_run_missing')
    return join(this.home(), 'runs', id)
  }

  // --- settings, templates, status ---------------------------------------------

  settings(): TestLabSettings { return sanitizeSettings(readJson(join(this.home(), 'settings.json'), {})) }

  saveSettings(input: unknown): TestLabSettings {
    const next = sanitizeSettings(input, this.settings())
    writeJson(join(this.home(), 'settings.json'), next)
    return next
  }

  templateDirs() {
    return [{ dir: builtinTemplateDir(), source: 'builtin' as const }, { dir: join(this.home(), 'templates'), source: 'custom' as const }]
  }

  templates(): { templates: LoadedTemplate[]; problems: TemplateProblem[] } { return loadTemplates(this.templateDirs()) }

  async status(userId: number, profile?: string) {
    const docker = await this.deps.docker.status()
    const { templates, problems } = this.templates()
    return {
      docker,
      settings: this.settings(),
      templates: templates.map(template => ({
        id: template.id, name: template.name, description: template.description, image: template.image || null,
        build: template.build?.git ?? (template.build ? '' : null), needsBuildUrl: !!template.build && !template.build.git && !template.image,
        sizeMb: template.sizeMb ?? null, port: template.port, logins: template.logins, source: template.source,
      })),
      problems: problems.map(problem => ({ file: basename(problem.file), errors: problem.errors })),
      models: docker.available ? await this.deps.models(userId, profile).catch(() => []) : [],
      customTemplateDir: join(this.home(), 'templates'),
    }
  }

  // --- runs on disk ---------------------------------------------------------------

  read(id: string): TestLabRun {
    const run = readJson<TestLabRun | null>(join(this.runDir(id), 'run.json'), null)
    if (!run) throw new TestLabError('This run is no longer known. Check the run list', 404, 'test_lab_run_missing')
    return run
  }

  private save(run: TestLabRun) { writeJson(join(this.runDir(run.id), 'run.json'), run) }

  private update(id: string, change: (run: TestLabRun) => void): TestLabRun {
    const run = this.read(id)
    change(run)
    this.save(run)
    return run
  }

  list(): Array<Pick<TestLabRun, 'id' | 'createdAt' | 'finishedAt' | 'status' | 'stopReason' | 'model' | 'removed' | 'keepRunning'> & { apps: string[]; passed?: number; failed?: number; costUsd: number }> {
    let ids: string[] = []
    try { ids = readdirSync(join(this.home(), 'runs')).filter(id => RUN_ID.test(id)) } catch { /* none yet */ }
    return ids.flatMap(id => {
      try {
        const run = this.read(id)
        return [{ id, createdAt: run.createdAt, finishedAt: run.finishedAt, status: run.status, stopReason: run.stopReason, model: run.model, removed: run.removed, keepRunning: run.keepRunning,
          apps: run.apps.map(app => app.name), passed: run.report?.passed, failed: run.report?.failed, costUsd: run.cost.openrouterUsd ?? run.cost.gatewayUsd }]
      } catch { return [] }
    }).sort((a, b) => b.createdAt - a.createdAt)
  }

  detail(id: string) {
    const run = this.read(id)
    return { ...run, active: this.active.has(id) }
  }

  // --- starting a run ---------------------------------------------------------------

  async start(userId: number, input: StartRunInput, profile?: string): Promise<TestLabRun> {
    const docker = await this.deps.docker.status()
    if (!docker.available) throw new TestLabError('Docker is not reachable. Run the sandbox-docker sidecar and set STUDIO_SANDBOX_DOCKER_HOST (see the Test Lab page)', 503, 'test_lab_no_docker')
    if (this.active.size || this.list().some(run => ACTIVE.includes(run.status))) throw new TestLabError('A Test Lab run is already going. Wait for it or stop it first', 409, 'test_lab_busy')
    const settings = this.settings()
    const models = await this.deps.models(userId, profile)
    const model = models.find(entry => entry.id === input.model)
    if (!model) throw new TestLabError('Pick a model from the list', 400, 'test_lab_model')
    const { templates } = this.templates()
    const ids = [...new Set((input.apps || []).map(String))]
    const chosen = ids.map(id => templates.find(template => template.id === id))
    if (!ids.length || chosen.some(template => !template)) throw new TestLabError('Pick at least one app from the list', 400, 'test_lab_apps')
    const capUsd = typeof input.capUsd === 'number' && input.capUsd > 0 && input.capUsd <= 100 ? Math.round(input.capUsd * 10000) / 10000 : settings.defaultCapUsd
    const minutes = typeof input.minutes === 'number' && input.minutes >= 1 && input.minutes <= 240 ? input.minutes : settings.defaultMinutes
    const builds = input.builds && typeof input.builds === 'object' ? input.builds : {}
    const forge = this.deps.forge !== undefined ? this.deps.forge : forgeConfig()
    for (const [app, url] of Object.entries(builds)) {
      if (url && !isBuildUrl(String(url), forge)) throw new TestLabError(`The git address for ${app} must be an https URL, or your forge's address (optionally with #branch)`, 400, 'test_lab_build_url')
    }
    const now = this.now()
    const id = newRunId(now)
    const dir = this.runDir(id)
    for (const sub of ['out', join('out', 'screenshots'), 'logs', 'lab']) mkdirSync(join(dir, sub), { recursive: true })
    for (const sub of ['out', join('out', 'screenshots')]) chmodSync(join(dir, sub), 0o777)
    copyFileSync(runnerScriptFile(), join(dir, 'lab', 'runner.mjs'))
    const run: TestLabRun = {
      id, createdAt: now, createdBy: userId, status: 'starting', model, capUsd, minutes,
      instructions: String(input.instructions || '').trim().slice(0, 4000) || 'Open each app, sign in, use its main pages and menus, and report what works and what does not.',
      keepRunning: !!input.keepRunning, browser: input.browser !== false,
      steps: STEP_KEYS.map(key => ({ key, state: 'pending' as StepState })),
      apps: (chosen as LoadedTemplate[]).map(template => ({ id: template.id, name: template.name, url: `http://${template.id}:${template.port}`, state: 'pending' as AppState, logins: template.logins })),
      transcript: [], screenshots: [], logs: [],
      cost: { gatewayUsd: 0, tokens: 0, unpricedCalls: 0 },
    }
    this.save(run)
    void this.launch(run, chosen as LoadedTemplate[], builds, settings).catch(error => this.fail(id, error))
    return run
  }

  private step(id: string, key: StepKey, state: StepState, detail?: string) {
    this.update(id, run => {
      const step = run.steps.find(item => item.key === key)
      if (step) { step.state = state; if (detail !== undefined) step.detail = detail; else delete step.detail }
    })
  }

  private app(id: string, appId: string, patch: Partial<RunApp>) {
    this.update(id, run => {
      const app = run.apps.find(item => item.id === appId)
      if (app) Object.assign(app, patch)
    })
  }

  private async hostPath(path: string): Promise<string> {
    const mounts = await this.deps.docker.ownMounts()
    if (!mounts.length) return path
    const mount = mounts.find(entry => path === entry.inside || path.startsWith(`${entry.inside}/`))
    if (!mount) throw new TestLabError(`Test Lab needs ${path} on a mounted volume: Docker cannot see Studio's own files`, 400, 'test_lab_mount')
    return mount.host + path.slice(mount.inside.length)
  }

  /** Pull an image (through the mirror for Docker Hub images); the reference to run. */
  private async ensureImage(image: string, mirror: string): Promise<string> {
    const { from, fallback } = pullReference(image, mirror)
    for (const ref of [from, fallback].filter(Boolean) as string[]) if (await this.deps.docker.hasImage(ref)) return ref
    try {
      await this.deps.docker.pull(from)
      return from
    } catch (error) {
      if (!fallback) throw error
      await this.deps.docker.pull(fallback)
      return fallback
    }
  }

  private async launch(run: TestLabRun, templates: LoadedTemplate[], builds: Record<string, string>, settings: TestLabSettings) {
    const { id } = run
    const docker = this.deps.docker
    const instance = this.deps.instance
    const labels = (extra: Record<string, string> = {}) => runLabels(id, instance, run.createdAt, extra)
    const sessionId = testLabSessionId(id)

    // Images: pull (mirror first) or build from git; an app that cannot get one is skipped.
    this.step(id, 'images', 'running')
    const images = new Map<string, string>()
    for (const template of templates) {
      const gitUrl = String(builds[template.id] || template.build?.git || '')
      try {
        if (template.image) {
          this.app(id, template.id, { state: 'pulling' })
          images.set(template.id, await this.ensureImage(template.image, settings.registryMirror))
        } else if (gitUrl) {
          this.app(id, template.id, { state: 'building', message: gitUrl })
          const tag = `studio-testlab/${template.id}:${id}`
          const forge = this.deps.forge !== undefined ? this.deps.forge : forgeConfig()
          if (forge && buildsFromForge(gitUrl, forge)) {
            // Private forge repos: Studio clones with FORGE_TOKEN and sends the files; Docker never sees the token.
            const context = await (this.deps.forgeContext || forgeBuildContext)(gitUrl, forge)
            await docker.buildContext(context, tag, labels({ [LABEL_APP]: template.id }), template.build?.dockerfile)
          } else {
            await docker.build(gitUrl, tag, labels({ [LABEL_APP]: template.id }), template.build?.dockerfile)
          }
          images.set(template.id, tag)
        } else {
          this.app(id, template.id, { state: 'skipped', message: `${template.name} has no image: give its git address to build it` })
        }
      } catch (error) {
        this.app(id, template.id, { state: 'failed', message: `${template.image ? 'Pull' : 'Build'} failed: ${(error as Error).message}`.slice(0, 500) })
      }
    }
    let runnerImage = '', browserImage = ''
    try { runnerImage = await this.ensureImage(settings.runnerImage, settings.registryMirror) } catch (error) {
      throw new TestLabError(`Could not get the runner image ${settings.runnerImage}: ${(error as Error).message}`, 502)
    }
    if (run.browser) {
      try { browserImage = await this.ensureImage(settings.browserImage, settings.registryMirror) } catch (error) {
        this.update(id, next => { next.message = `No browser: ${(error as Error).message}`.slice(0, 400) })
      }
    }
    if (!images.size) {
      this.step(id, 'images', 'failed', 'No app could be pulled or built')
      throw new TestLabError('No app could be pulled or built', 502)
    }
    this.step(id, 'images', 'done')
    if (this.read(id).stopReason) return this.finish(id)

    // Network: private and internal (no internet, no LAN).
    this.step(id, 'network', 'running')
    const network = `studio-testlab-${id}`
    await docker.createNetwork(network, labels())
    this.update(id, next => { next.network = network })
    this.step(id, 'network', 'done', network)

    // Apps.
    this.step(id, 'apps', 'running')
    for (const template of templates) {
      const image = images.get(template.id)
      if (!image) continue
      try {
        this.app(id, template.id, { state: 'starting', image })
        const spec: ContainerSpec = {
          name: `studio-testlab-${id}-${template.id}`, image, network, aliases: [template.id],
          labels: labels({ [LABEL_APP]: template.id }), env: template.env, entrypoint: template.entrypoint, cmd: template.cmd,
          memoryBytes: memoryBytes(template.memory) ?? 1024 ** 3, nanoCpus: 2e9, pidsLimit: 2048,
        }
        const containerId = await docker.createContainer(spec)
        await docker.start(containerId)
        this.app(id, template.id, { state: 'running', containerId, message: undefined })
      } catch (error) {
        this.app(id, template.id, { state: 'failed', message: `Could not start: ${(error as Error).message}`.slice(0, 500) })
      }
    }
    if (browserImage) {
      try {
        const browserId = await docker.createContainer({
          name: `studio-testlab-${id}-browser`, image: browserImage, network, aliases: ['browser'],
          labels: labels({ [LABEL_APP]: 'browser' }), memoryBytes: 1024 ** 3, nanoCpus: 2e9, pidsLimit: 1024,
        })
        await docker.start(browserId)
      } catch (error) {
        this.update(id, next => { next.message = `No browser: ${(error as Error).message}`.slice(0, 400) })
        browserImage = ''
      }
    }
    const started = this.read(id).apps.filter(app => app.state === 'running')
    if (!started.length) {
      this.step(id, 'apps', 'failed', 'No app started')
      throw new TestLabError('No app started', 502)
    }
    this.step(id, 'apps', 'done')
    if (this.read(id).stopReason) return this.finish(id)

    // The model: pinned, capped, reached only through Studio's tunnel.
    const token = `hwui_testlab_${randomBytes(24).toString('base64url')}`
    pinModel(sessionId, { provider: run.model.provider, model: run.model.model, routeId: run.model.id })
    this.deps.limits.set(sessionId, run.capUsd, run.minutes)
    try {
      const before = await this.deps.openRouterUsage(run.model, run.createdBy)
      if (before !== null) this.update(id, next => { next.cost.openrouterBefore = before })
    } catch (error) {
      this.update(id, next => { next.cost.openrouterError = `OpenRouter usage could not be read: ${(error as Error).message}`.slice(0, 300) })
    }
    const gateway = await this.deps.registerGateway({ userId: run.createdBy, model: run.model, sessionId, runId: id, token })
    const socketDir = join(this.home(), 's', createHash('sha1').update(id).digest('hex').slice(0, 10))
    const tunnel = await this.openTunnel(socketDir, token)
    const state = { timer: setInterval(() => { void this.poll(id) }, this.deps.pollMs ?? 2000), tunnel, gateway, socketDir, progressOffset: 0, finishing: false,
      deadline: this.now() + (run.minutes + 30) * 60_000, lastOpenRouter: 0 } as any
    this.active.set(id, state)

    // The runner: one container, read-only, no capabilities, on the private network only.
    const dir = this.runDir(id)
    const templatesById = new Map(templates.map(template => [template.id, template]))
    const apps = this.read(id).apps.filter(app => app.state === 'running').map(app => {
      const template = templatesById.get(app.id)!
      return { id: app.id, name: app.name, baseUrl: app.url, health: template.health, seed: template.seed || [], logins: template.logins, notes: template.notes, start: template.start }
    })
    this.update(id, next => { next.status = 'running' })
    this.step(id, 'health', 'running')
    const runnerId = await docker.createContainer({
      name: `studio-testlab-${id}-runner`, image: runnerImage, network, aliases: ['runner'],
      labels: labels({ [LABEL_APP]: 'runner' }), user: '1000:1000', workingDir: '/out',
      cmd: ['node', '/lab/runner.mjs'],
      env: {
        LAB_MODEL: run.model.id, LAB_MAX_STEPS: String(settings.maxSteps), LAB_APPS: JSON.stringify(apps),
        LAB_INSTRUCTIONS: run.instructions, LAB_BROWSER: browserImage ? 'browser:9222' : '', LAB_OUT: '/out', LAB_TUNNEL: '/tunnel/lab.sock',
      },
      binds: [`${await this.hostPath(join(dir, 'lab'))}:/lab:ro`, `${await this.hostPath(join(dir, 'out'))}:/out:rw`, `${await this.hostPath(socketDir)}:/tunnel:rw`],
      readOnlyRoot: true, dropAllCaps: true, tmpfs: { '/tmp': 'rw,noexec,nosuid,size=256m' },
      memoryBytes: 768 * 1024 ** 2, nanoCpus: 1e9, pidsLimit: 256,
    })
    state.runner = runnerId
    await docker.start(runnerId)
  }

  /** Studio's side of the runner's model tunnel: chat completions only, with the run's credential added here. */
  private openTunnel(dir: string, token: string): Promise<Server> {
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o777)
    const path = join(dir, 'lab.sock')
    if (Buffer.byteLength(path) > 103) throw new TestLabError(`The Test Lab socket path is too long for a Unix socket (${path}): use a shorter HERMES_WEB_UI_HOME`, 500)
    rmSync(path, { force: true })
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Test Lab can only reach its model' } }))
        return
      }
      const upstream = httpRequest({ host: '127.0.0.1', port: this.deps.gatewayPort(), method: 'POST', path: '/api/ekko-studio/models/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}) } }, answer => {
        res.writeHead(answer.statusCode || 502, { 'content-type': String(answer.headers['content-type'] || 'application/json') })
        answer.pipe(res)
      })
      upstream.on('error', error => { if (!res.headersSent) res.writeHead(502).end(JSON.stringify({ error: { message: `Studio's gateway: ${error.message}` } })); else res.destroy() })
      req.pipe(upstream)
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => { try { chmodSync(path, 0o666) } catch { /* the runner cannot connect */ } resolve(server) })
    })
  }

  // --- following a run ---------------------------------------------------------------

  private readProgress(id: string, offset: number): { events: any[]; offset: number } {
    const file = join(this.runDir(id), 'out', 'progress.jsonl')
    if (!existsSync(file)) return { events: [], offset }
    const size = statSync(file).size
    if (size <= offset) return { events: [], offset }
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024))
      readSync(fd, buffer, 0, buffer.length, offset)
      const text = buffer.toString('utf8')
      const end = text.lastIndexOf('\n')
      if (end < 0) return { events: [], offset }
      const events = text.slice(0, end).split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
      return { events, offset: offset + Buffer.byteLength(text.slice(0, end + 1)) }
    } finally { closeSync(fd) }
  }

  private applyEvents(id: string, events: any[]) {
    if (!events.length) return
    this.update(id, run => {
      const set = (key: StepKey, state: StepState, detail?: string) => {
        const step = run.steps.find(item => item.key === key)
        if (step && (step.state !== 'done' || state === 'failed')) { step.state = state; if (detail) step.detail = detail }
      }
      for (const event of events) {
        const app = run.apps.find(item => item.id === event.app)
        if (event.type === 'health' && app) {
          app.state = event.ok ? 'healthy' : 'unhealthy'
          app.message = event.ok ? undefined : String(event.error || '').slice(0, 400)
          if (!app.message) delete app.message
        } else if (event.type === 'seed' && app) {
          set('health', 'done'); set('seed', 'running')
          if (!event.ok) app.message = `Test data: "${event.step}" failed${event.optional ? ' (optional)' : ''}: ${String(event.error || '').slice(0, 300)}`
        } else if (event.type === 'screenshot') {
          if (!run.screenshots.includes(event.file)) run.screenshots.push(event.file)
        } else if (event.type === 'agent') {
          set('health', 'done'); set('seed', run.steps.find(step => step.key === 'seed')?.state === 'running' ? 'done' : 'skipped'); set('agent', 'running')
          run.transcript.push({ at: event.at, role: event.role === 'tool' ? 'tool' : 'assistant', ...(event.tool ? { tool: event.tool } : {}), text: String(event.text || '') })
          if (run.transcript.length > MAX_TRANSCRIPT) run.transcript.splice(0, run.transcript.length - MAX_TRANSCRIPT)
        } else if (event.type === 'stopped') {
          run.transcript.push({ at: event.at, role: 'system', text: String(event.message || event.reason || '') })
          if (event.reason === 'refused' && !run.stopReason) run.stopReason = refusalReason(String(event.message || ''))
        } else if (event.type === 'report') {
          set('agent', 'done')
        } else if (event.type === 'browser' && !event.ok) {
          run.message = `No browser: ${String(event.error || '').slice(0, 300)}`
        }
      }
      if (run.apps.every(item => !['running', 'starting'].includes(item.state))) set('health', 'done')
    })
  }

  private async poll(id: string) {
    const state = this.active.get(id)
    if (!state || state.finishing) return
    try {
      const progress = this.readProgress(id, state.progressOffset)
      state.progressOffset = progress.offset
      this.applyEvents(id, progress.events)
      const spent = this.deps.limits.spent(testLabSessionId(id))
      if (spent) this.update(id, run => { run.cost.gatewayUsd = spent.costUsd; run.cost.tokens = spent.tokens; run.cost.unpricedCalls = spent.unpricedCalls })
      const run = this.read(id)
      // The spending cap: Studio's own count, then OpenRouter's counter for the key.
      if (run.cost.gatewayUsd >= run.capUsd) return this.stop(id, 'cap')
      if (run.cost.openrouterBefore !== undefined && this.now() - state.lastOpenRouter >= 15_000) {
        state.lastOpenRouter = this.now()
        try {
          const usage = await this.deps.openRouterUsage(run.model, run.createdBy)
          if (usage !== null) {
            this.update(id, next => { next.cost.openrouterAfter = usage; next.cost.openrouterUsd = Math.round((usage - (next.cost.openrouterBefore ?? usage)) * 10000) / 10000 })
            if (usage - run.cost.openrouterBefore >= run.capUsd) return this.stop(id, 'cap')
          }
        } catch { /* read again next time */ }
      }
      if (this.now() > state.deadline) return this.stop(id, 'time')
      if (state.runner) {
        const info = await this.deps.docker.inspect(state.runner)
        if (!info || info.State?.Running === false) return this.finish(id)
      }
    } catch (error) {
      this.deps.log?.(`[test-lab] ${id}: ${(error as Error).message}`)
    }
  }

  /** Stop a run now (Stop, the cap or the time limit): the runner is killed, then the run is wrapped up. */
  async stop(id: string, reason: StopReason = 'user'): Promise<TestLabRun> {
    const run = this.read(id)
    const state = this.active.get(id)
    if (!state && ACTIVE.includes(run.status)) {
      // Still pulling or building: the launch sees the stop when it gets there.
      return this.update(id, next => { next.stopReason = reason })
    }
    if (!state) return run
    if (!run.stopReason) this.update(id, next => { next.stopReason = reason })
    if (state.runner) await this.deps.docker.kill(state.runner).catch(() => undefined)
    return this.finish(id)
  }

  private async finish(id: string): Promise<TestLabRun> {
    const state = this.active.get(id)
    if (state?.finishing) return this.read(id)
    if (state) { state.finishing = true; clearInterval(state.timer) }
    const docker = this.deps.docker
    const sessionId = testLabSessionId(id)
    // The model is closed to this run from here on.
    unpinModel(sessionId)
    try { state?.gateway?.dispose() } catch { /* already gone */ }
    if (state?.tunnel) await new Promise<void>(done => state.tunnel.close(() => done()))
    if (state?.socketDir) rmSync(state.socketDir, { recursive: true, force: true })
    if (state) {
      const progress = this.readProgress(id, state.progressOffset)
      this.applyEvents(id, progress.events)
    }
    const spent = this.deps.limits.spent(sessionId)
    this.deps.limits.forget(sessionId)
    // Report.
    const dir = this.runDir(id)
    let report: ParsedReport | undefined
    try { report = parseReport(readFileSync(join(dir, 'out', 'report.md'), 'utf8')) } catch { report = undefined }
    // Logs: the tail of each container of this run.
    const logs: string[] = []
    try {
      for (const container of await docker.containers([`studio.testlab.run=${id}`, `studio.testlab.instance=${this.deps.instance}`])) {
        const name = container.Labels?.[LABEL_APP]
        if (!name || !/^[a-z][a-z0-9-]{0,40}$/.test(name)) continue
        try {
          writeFileSync(join(dir, 'logs', `${name}.log`), await docker.logs(container.Id, 300))
          logs.push(name)
        } catch { /* the container is gone */ }
      }
    } catch (error) { this.deps.log?.(`[test-lab] logs for ${id}: ${(error as Error).message}`) }
    let screenshots: string[] = []
    try { screenshots = readdirSync(join(dir, 'out', 'screenshots')).filter(name => /^[\w.-]+\.png$/.test(name)).sort() } catch { /* none */ }
    let openrouterAfter: number | null = null
    let openrouterError = ''
    if (this.read(id).cost.openrouterBefore !== undefined) {
      try { openrouterAfter = await this.deps.openRouterUsage(this.read(id).model, this.read(id).createdBy) } catch (error) { openrouterError = (error as Error).message }
    }
    const finished = this.update(id, run => {
      if (spent) { run.cost.gatewayUsd = spent.costUsd; run.cost.tokens = spent.tokens; run.cost.unpricedCalls = spent.unpricedCalls }
      if (openrouterAfter !== null && run.cost.openrouterBefore !== undefined) {
        run.cost.openrouterAfter = openrouterAfter
        run.cost.openrouterUsd = Math.round((openrouterAfter - run.cost.openrouterBefore) * 10000) / 10000
      }
      if (openrouterError) run.cost.openrouterError = `OpenRouter usage could not be read after the run: ${openrouterError}`.slice(0, 300)
      run.report = report
      run.logs = logs
      run.screenshots = screenshots
      run.status = outcome(report, run.stopReason)
      run.finishedAt = this.now()
      for (const step of run.steps) {
        if (step.key === 'report') step.state = report?.checks.length ? 'done' : 'failed'
        else if (step.state === 'running') step.state = run.stopReason ? 'failed' : 'done'
        else if (step.state === 'pending' && step.key !== 'cleanup') step.state = 'skipped'
      }
    })
    this.active.delete(id)
    if (!finished.keepRunning) await this.remove(id).catch(error => this.deps.log?.(`[test-lab] cleanup ${id}: ${(error as Error).message}`))
    else this.step(id, 'cleanup', 'skipped', 'kept running')
    return this.read(id)
  }

  private fail(id: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    this.deps.log?.(`[test-lab] ${id} failed: ${message}`)
    try { this.update(id, run => { run.message = message.slice(0, 600) }) } catch { /* the record is gone */ }
    void this.finish(id).then(() => {
      this.update(id, run => { run.status = run.stopReason ? 'stopped' : 'error'; run.message = message.slice(0, 600) })
    }).catch(() => undefined)
  }

  /** Remove everything this run made on Docker (only objects with its labels). */
  async remove(id: string): Promise<TestLabRun> {
    if (this.active.has(id)) throw new TestLabError('Stop the run before removing it', 409, 'test_lab_active')
    this.read(id)
    this.step(id, 'cleanup', 'running')
    try {
      const removed = await this.deps.docker.removeRun(this.deps.instance, id)
      return this.update(id, run => {
        run.removed = true
        run.removedAt = this.now()
        for (const app of run.apps) if (app.state !== 'skipped') app.state = 'removed'
        const step = run.steps.find(item => item.key === 'cleanup')!
        step.state = 'done'
        step.detail = `${removed.containers.length} containers, ${removed.networks.length} network${removed.networks.length === 1 ? '' : 's'}${removed.images.length ? `, ${removed.images.length} built images` : ''}`
      })
    } catch (error) {
      this.step(id, 'cleanup', 'failed', (error as Error).message.slice(0, 300))
      throw error
    }
  }

  /** At startup: runs cut short by a restart end, and left-behind runs older than a day are removed. */
  async sweep(): Promise<{ removed: string[] }> {
    const removed: string[] = []
    for (const item of this.list()) {
      if (ACTIVE.includes(item.status) && !this.active.has(item.id)) {
        this.update(item.id, run => { run.status = 'stopped'; run.stopReason = 'restart'; run.finishedAt = this.now(); run.message = 'Studio restarted during this run' })
      }
    }
    const status = await this.deps.docker.status()
    if (!status.available) return { removed }
    const runs = await this.deps.docker.labelledRuns(this.deps.instance)
    for (const [id, createdAt] of runs) {
      if (this.active.has(id)) continue
      let record: TestLabRun | null = null
      try { record = RUN_ID.test(id) ? this.read(id) : null } catch { record = null }
      const stale = this.now() - createdAt > DAY
      const interrupted = record && record.stopReason === 'restart' && !record.keepRunning
      if (!stale && !interrupted) continue
      await this.deps.docker.removeRun(this.deps.instance, id)
      if (record) this.update(id, run => { run.removed = true; run.removedAt = this.now(); const step = run.steps.find(item => item.key === 'cleanup'); if (step) { step.state = 'done'; step.detail = 'removed at startup' } })
      removed.push(id)
    }
    return { removed }
  }

  // --- files ---------------------------------------------------------------------------

  screenshot(id: string, name: string): Buffer {
    if (!/^[\w.-]+\.png$/.test(name)) throw new TestLabError('Unknown screenshot', 404)
    const file = join(this.runDir(id), 'out', 'screenshots', name)
    if (!existsSync(file)) throw new TestLabError('Unknown screenshot', 404)
    return readFileSync(file)
  }

  log(id: string, app: string): string {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(app)) throw new TestLabError('Unknown log', 404)
    const file = join(this.runDir(id), 'logs', `${app}.log`)
    if (!existsSync(file)) throw new TestLabError('Unknown log', 404)
    return readFileSync(file, 'utf8')
  }

  zip(id: string): Buffer {
    const run = this.read(id)
    const dir = this.runDir(id)
    const zip = new AdmZip()
    zip.addFile('run.json', Buffer.from(JSON.stringify(run, null, 2)))
    for (const name of ['report.md', 'report.json', 'progress.jsonl']) {
      const file = join(dir, 'out', name)
      if (existsSync(file)) zip.addLocalFile(file, '', name)
    }
    for (const name of run.screenshots) {
      const file = join(dir, 'out', 'screenshots', name)
      if (existsSync(file)) zip.addLocalFile(file, 'screenshots')
    }
    for (const name of run.logs) {
      const file = join(dir, 'logs', `${name}.log`)
      if (existsSync(file)) zip.addLocalFile(file, 'logs')
    }
    return zip.toBuffer()
  }

  close() {
    for (const state of this.active.values()) { clearInterval(state.timer); state.tunnel.close() }
  }
}
