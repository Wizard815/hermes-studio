import type { Context } from 'koa'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { readConfigYamlForProfile } from '../../studio/public/profile-config'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { getHermesBin } from '../services/runtime/path'
import { execHermesWithBin, spawnHermesWithBin } from '../services/runtime/process'
import { readSetupRecord } from './mattermost-setup'
import { hermesGatewayRoute } from '../../studio/public/provider-projection'
import { logicalModelSelection } from '../../studio/public/model-routing'

const TIMEOUT_MS = 60_000

type JobRecord = Record<string, any>

interface DeliveryTargetRecord {
  platform: string
  id: string
  name: string
  type: string | null
  thread_id: string | null
  value: string
}

function resolveProfile(ctx: Context): string {
  const requestedProfile = ctx.state?.profile?.name
  return requestedProfile || getActiveProfileName()
}

function resolveProfileDir(profile: string): string {
  return getProfileDir(profile || 'default')
}

function getJobsPath(profile: string): string {
  return join(resolveProfileDir(profile), 'cron', 'jobs.json')
}

function getChannelDirectoryPath(profile: string): string {
  return join(resolveProfileDir(profile), 'channel_directory.json')
}

function readDeliveryTargets(profile: string): { updated_at: string | null; targets: DeliveryTargetRecord[] } {
  const directory = readDirectoryTargets(profile)
  return { ...directory, targets: withMattermostSetupTargets(profile, directory.targets) }
}

/**
 * Channels Studio's Mattermost setup created (#hermes, #home-alerts, #server-alerts) are delivery
 * targets even before anyone has talked in them, which is when Hermes's own directory lists a channel.
 */
function withMattermostSetupTargets(profile: string, targets: DeliveryTargetRecord[]): DeliveryTargetRecord[] {
  const record = readSetupRecord(profile)
  if (!record) return targets
  const merged = targets.filter((t) => !(t.platform === 'mattermost' && record.channels.some((c) => c.id === t.id)))
  for (const channel of record.channels) {
    merged.push({ platform: 'mattermost', id: channel.id, name: `#${channel.name}`, type: 'channel', thread_id: null, value: `mattermost:${channel.id}` })
  }
  return merged.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

function readDirectoryTargets(profile: string): { updated_at: string | null; targets: DeliveryTargetRecord[] } {
  const directoryPath = getChannelDirectoryPath(profile)
  if (!existsSync(directoryPath)) return { updated_at: null, targets: [] }

  try {
    const parsed = JSON.parse(readFileSync(directoryPath, 'utf-8'))
    const platforms = parsed?.platforms
    if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
      return { updated_at: null, targets: [] }
    }

    const targets: DeliveryTargetRecord[] = []
    const seen = new Set<string>()
    for (const [rawPlatform, rawChannels] of Object.entries(platforms)) {
      const platform = String(rawPlatform || '').trim().toLowerCase()
      if (!platform || !Array.isArray(rawChannels)) continue

      for (const rawChannel of rawChannels) {
        if (!rawChannel || typeof rawChannel !== 'object') continue
        const channel = rawChannel as Record<string, unknown>
        const id = String(channel.id ?? channel.chat_id ?? '').trim()
        if (!id) continue

        const value = `${platform}:${id}`
        if (seen.has(value)) continue
        seen.add(value)

        const name = String(channel.name ?? id).trim() || id
        const type = channel.type == null ? null : String(channel.type).trim() || null
        const threadId = channel.thread_id == null ? null : String(channel.thread_id).trim() || null
        targets.push({ platform, id, name, type, thread_id: threadId, value })
      }
    }

    targets.sort((a, b) => {
      const platformOrder = a.platform.localeCompare(b.platform)
      return platformOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    })

    const updatedAt = typeof parsed.updated_at === 'string' && parsed.updated_at.trim()
      ? parsed.updated_at
      : null
    return { updated_at: updatedAt, targets }
  } catch {
    return { updated_at: null, targets: [] }
  }
}

function normalizeJob(job: JobRecord): JobRecord {
  const id = job.job_id || job.id
  const skills = Array.isArray(job.skills)
    ? job.skills
    : (job.skill ? [job.skill] : [])

  return {
    ...job,
    id,
    job_id: id,
    skills,
    skill: job.skill ?? skills[0] ?? null,
    model: job.model ?? null,
    provider: job.provider ?? null,
    base_url: job.base_url ?? null,
    script: job.script ?? null,
    schedule_display: job.schedule_display ?? job.schedule?.display ?? job.schedule?.expr ?? '',
    repeat: job.repeat ?? { times: null, completed: 0 },
    enabled: job.enabled ?? true,
    state: job.state ?? ((job.enabled ?? true) ? 'scheduled' : 'paused'),
    paused_at: job.paused_at ?? null,
    paused_reason: job.paused_reason ?? null,
    created_at: job.created_at ?? '',
    next_run_at: job.next_run_at ?? null,
    last_run_at: job.last_run_at ?? null,
    last_status: job.last_status ?? null,
    last_error: job.last_error ?? null,
    deliver: job.deliver ?? 'local',
    origin: job.origin ?? null,
    last_delivery_error: job.last_delivery_error ?? null,
  }
}

function resolveJobDefaults(jobs: JobRecord[], config: Record<string, any>): JobRecord[] {
  const modelSection = config.model
  let defaultModel = ''
  let defaultProvider = ''
  if (typeof modelSection === 'object' && modelSection !== null) {
    defaultModel = String(modelSection.default || '').trim()
    defaultProvider = String(modelSection.provider || '').trim()
    // Resolve 'custom' provider from custom_providers matching base_url+model
    if (defaultProvider === 'custom' && defaultModel) {
      const cps = Array.isArray(config.custom_providers) ? config.custom_providers : []
      const match = cps.find((cp: any) =>
        String(cp.base_url || '').replace(/\/$/, '') === String(modelSection.base_url || '').replace(/\/$/, '')
        && String(cp.model || '') === defaultModel
      ) || cps.find((cp: any) =>
        String(cp.base_url || '').replace(/\/$/, '') === String(modelSection.base_url || '').replace(/\/$/, '')
      )
      if (match) defaultProvider = 'custom:' + String(match.name || '').trim()
    }
  } else if (typeof modelSection === 'string') {
    defaultModel = modelSection.trim()
  }
  if (!defaultModel && !defaultProvider) return jobs
  return jobs.map(job => ({
    ...job,
    provider: job.provider || defaultProvider || null,
    model: job.model || defaultModel || null,
  }))
}

const GATEWAY_PROVIDERS = new Set(['ekkostudio', 'custom:ekkostudio', 'moa'])

/** A job's own model runs through Studio's model gateway, like Hermes's main model. */
async function gatewayJobInference(profile: string, provider: unknown, model: unknown): Promise<{ provider: string; model: string; base_url: null } | null> {
  const p = typeof provider === 'string' ? provider.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  if (!p || !m || GATEWAY_PROVIDERS.has(p)) return null
  const route = await hermesGatewayRoute(profile, p, m)
  return route ? { ...route, base_url: null } : null
}

async function withGatewayInference(profile: string, updates: Record<string, string | null>, existing?: JobRecord | null): Promise<Record<string, string | null>> {
  if (!('provider' in updates) && !('model' in updates)) return updates
  const provider = 'provider' in updates ? updates.provider : existing?.provider
  const model = 'model' in updates ? updates.model : existing?.model
  // An unchanged gateway job edited with its displayed (logical) model keeps working.
  const moved = await gatewayJobInference(profile, provider, model).catch(() => null)
  return moved ? { ...updates, ...moved } : updates
}

/** Shows a gateway job's model the way Studio's pickers name it. */
function logicalJob(profile: string, job: JobRecord): JobRecord {
  if (!['ekkostudio', 'custom:ekkostudio'].includes(job.provider) || typeof job.model !== 'string' || !job.model) return job
  try { return { ...job, ...logicalModelSelection(profile, job.provider, job.model) } } catch { return job }
}

function keepPreGatewayJobs(profile: string, jobsPath: string): void {
  const dir = join(resolveProfileDir(profile), 'pre-studio-gateway')
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!existsSync(join(dir, 'cron-jobs.json'))) copyFileSync(jobsPath, join(dir, 'cron-jobs.json'))
  } catch { /* the move still goes ahead */ }
}

const migratedJobs = new Map<string, number>()
/**
 * Jobs saved with one of Hermes's own providers (before Studio's model gateway,
 * which took those providers out of Hermes's config) move onto the gateway.
 */
export async function migrateJobModels(profile: string): Promise<number> {
  const jobsPath = getJobsPath(profile)
  let mtime = 0
  try { mtime = statSync(jobsPath).mtimeMs } catch { return 0 }
  if (migratedJobs.get(jobsPath) === mtime) return 0
  let moved = 0
  for (const job of readJobs(profile, true)) {
    const update = await gatewayJobInference(profile, job.provider, job.model).catch(() => null)
    // Hermes's own list stays beside it once (`pre-studio-gateway/cron-jobs.json`), for going back.
    if (update && !moved) keepPreGatewayJobs(profile, jobsPath)
    if (update && patchJobFields(profile, job.job_id || job.id, update)) moved += 1
  }
  try { migratedJobs.set(jobsPath, statSync(jobsPath).mtimeMs) } catch {}
  return moved
}

function writeJobs(profile: string, jobs: JobRecord[], asArray = false): void {
  const jobsPath = getJobsPath(profile)
  const payload = asArray ? jobs : { jobs }
  writeFileSync(jobsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}

function readJobs(profile: string, includeDisabled = true): JobRecord[] {
  const jobsPath = getJobsPath(profile)
  if (!existsSync(jobsPath)) return []

  const parsed = JSON.parse(readFileSync(jobsPath, 'utf-8'))
  const rawJobs = Array.isArray(parsed) ? parsed : parsed?.jobs
  const jobs = Array.isArray(rawJobs) ? rawJobs.map(normalizeJob) : []

  if (includeDisabled) return jobs
  return jobs.filter((job) => job.enabled !== false)
}

function findJob(profile: string, jobId: string): JobRecord | null {
  return readJobs(profile, true).find((job) => job.job_id === jobId || job.id === jobId) ?? null
}

function boolQuery(value: unknown, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  const text = String(value).toLowerCase()
  return text === '1' || text === 'true' || text === 'yes'
}

function getBody(ctx: Context): Record<string, any> {
  return (ctx.request.body && typeof ctx.request.body === 'object')
    ? ctx.request.body as Record<string, any>
    : {}
}

function getRepeatValue(repeat: unknown): number | null {
  if (repeat == null || repeat === '') return null
  if (typeof repeat === 'number' && Number.isFinite(repeat)) return repeat
  if (typeof repeat === 'object') {
    const times = (repeat as any).times
    if (typeof times === 'number' && Number.isFinite(times)) return times
    if (typeof times === 'string' && times.trim()) {
      const parsed = Number(times)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }
  const parsed = Number(repeat)
  return Number.isFinite(parsed) ? parsed : null
}

function hasRepeatField(body: Record<string, any>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'repeat')
}

function normalizeOptionalText(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text ? text : null
}

function hasOwn(body: Record<string, any>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field)
}

function buildInferenceUpdates(body: Record<string, any>): Record<string, string | null> {
  const updates: Record<string, string | null> = {}
  if (hasOwn(body, 'provider')) updates.provider = normalizeOptionalText(body.provider)
  if (hasOwn(body, 'model')) updates.model = normalizeOptionalText(body.model)
  if (hasOwn(body, 'base_url')) updates.base_url = normalizeOptionalText(body.base_url)
  return updates
}

function patchJobFields(profile: string, jobId: string, fields: Record<string, any>): JobRecord | null {
  const updates = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
  if (Object.keys(updates).length === 0) return findJob(profile, jobId)

  const jobsPath = getJobsPath(profile)
  if (!existsSync(jobsPath)) return null
  const parsed = JSON.parse(readFileSync(jobsPath, 'utf-8'))
  const parsedAsArray = Array.isArray(parsed)
  const rawJobs = parsedAsArray ? parsed : parsed?.jobs
  if (!Array.isArray(rawJobs)) return null

  const index = rawJobs.findIndex((job: JobRecord) => (job.job_id || job.id) === jobId || job.id === jobId)
  if (index === -1) return null
  rawJobs[index] = {
    ...rawJobs[index],
    ...updates,
  }
  writeJobs(profile, rawJobs, parsedAsArray)
  return normalizeJob(rawJobs[index])
}

function getSkills(body: Record<string, any>): string[] | null {
  if (Array.isArray(body.skills)) {
    return body.skills.map((skill) => String(skill || '').trim()).filter(Boolean)
  }
  if (typeof body.skill === 'string') {
    const skill = body.skill.trim()
    return skill ? [skill] : []
  }
  return null
}

async function runHermesCron(profile: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const profileDir = resolveProfileDir(profile)
  try {
    return await execHermesWithBin(getHermesBin(), args, {
      cwd: process.cwd(),
      env: { ...process.env, HERMES_HOME: profileDir },
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
  } catch (error: any) {
    throw Object.assign(new Error(cronFailureMessage(error?.stderr, error?.stdout) || error?.message || 'Hermes cron command failed'),
      { status: /\b(?:failed to (?:create|update|edit)|invalid|unknown|not found|must|cannot)\b/i.test(`${error?.stderr}\n${error?.stdout}`) ? 400 : 500 })
  }
}

/**
 * What a failed `hermes cron` said, without Hermes's own install warnings
 * ("⚠ install out of sync ..." on every command in the Docker image).
 */
export function cronFailureMessage(stderr: unknown, stdout: unknown): string {
  const lines = [stderr, stdout].flatMap(output => String(output || '').split(/\r?\n/))
    .map(line => line.trim()).filter(line => line && !/^⚠\s/.test(line))
  const failure = lines.find(line => /^(?:failed|error|invalid)\b/i.test(line))
  return failure || lines.join('\n')
}

function reportedCommandFailure(result: { stdout: string; stderr: string }): string | null {
  for (const output of [result.stderr, result.stdout]) {
    const message = String(output || '').trim()
    if (/^(?:failed|error)\b/im.test(message)) return cronFailureMessage(message, '')
  }
  return null
}

async function startHermesCronInBackground(profile: string, args: string[]): Promise<void> {
  const profileDir = resolveProfileDir(profile)
  const child = spawnHermesWithBin(getHermesBin(), args, {
    cwd: process.cwd(),
    env: { ...process.env, HERMES_HOME: profileDir },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function getCronArgs(profile: string, command: string, ...args: string[]): string[] {
  return ['cron', command, '--profile', profile, ...args]
}

function sendJobNotFound(ctx: Context): void {
  ctx.status = 404
  ctx.body = { error: { message: 'Job not found' } }
}

function sendCommandError(ctx: Context, error: any): void {
  ctx.status = error?.status === 400 ? 400 : 500
  ctx.body = { error: { message: error?.message || 'Hermes cron command failed' } }
}

function findCreatedJob(beforeJobs: JobRecord[], afterJobs: JobRecord[]): JobRecord | null {
  const beforeIds = new Set(beforeJobs.map((job) => job.job_id || job.id))
  return afterJobs.find((job) => !beforeIds.has(job.job_id || job.id)) ?? null
}

export async function list(ctx: Context) {
  const profile = resolveProfile(ctx)
  const includeDisabled = boolQuery(ctx.query.include_disabled, false)
  const jobs = readJobs(profile, includeDisabled)
  const config = await readConfigYamlForProfile(profile)
  ctx.body = { jobs: resolveJobDefaults(jobs, config).map(job => logicalJob(profile, job)) }
}

export function deliveryTargets(ctx: Context) {
  ctx.body = readDeliveryTargets(resolveProfile(ctx))
}

export async function get(ctx: Context) {
  const profile = resolveProfile(ctx)
  const job = findJob(profile, ctx.params.id)
  if (!job) return sendJobNotFound(ctx)
  ctx.body = { job: logicalJob(profile, job) }
}

export async function create(ctx: Context) {
  const profile = resolveProfile(ctx)
  const body = getBody(ctx)
  const name = String(body.name || '').trim()
  const schedule = String(body.schedule || body.schedule_display || '').trim()
  const prompt = String(body.prompt || '').trim()
  const skills = getSkills(body)
  const script = String(body.script || '').trim()

  if (!name) {
    ctx.status = 400
    ctx.body = { error: { message: 'Name is required' } }
    return
  }
  if (!schedule) {
    ctx.status = 400
    ctx.body = { error: { message: 'Schedule is required' } }
    return
  }
  if (!prompt && !skills?.length && !script) {
    ctx.status = 400
    ctx.body = { error: { message: 'Prompt, skill, or script is required' } }
    return
  }

  const beforeJobs = readJobs(profile, true)
  const args = getCronArgs(profile, 'create')
  args.push('--name', name)
  if (body.deliver != null && String(body.deliver).trim()) args.push('--deliver', String(body.deliver).trim())

  const repeat = getRepeatValue(body.repeat)
  if (repeat != null) {
    args.push('--repeat', String(repeat))
  } else if (hasRepeatField(body)) {
    // Hermes CLI normalizes repeat <= 0 to an unbounded/null repeat.
    args.push('--repeat', '0')
  }

  for (const skill of skills || []) args.push('--skill', skill)

  if (script) args.push('--script', script)
  if (body.workdir != null) args.push('--workdir', String(body.workdir))
  if (body.no_agent === true) args.push('--no-agent')

  args.push(schedule)
  if (prompt) args.push(prompt)

  try {
    const result = await runHermesCron(profile, args)
    const job = findCreatedJob(beforeJobs, readJobs(profile, true))
    if (!job) {
      const reportedFailure = reportedCommandFailure(result)
      if (reportedFailure) {
        ctx.status = 400
        ctx.body = { error: { message: reportedFailure } }
        return
      }
      throw new Error('Hermes cron command completed without creating a job')
    }
    const inferenceUpdates = await withGatewayInference(profile, buildInferenceUpdates(body))
    const patchedJob = patchJobFields(profile, job.job_id || job.id, inferenceUpdates)
    ctx.body = { job: logicalJob(profile, patchedJob || job) }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function update(ctx: Context) {
  const profile = resolveProfile(ctx)
  const body = getBody(ctx)
  const existing = findJob(profile, ctx.params.id)
  if (!existing) return sendJobNotFound(ctx)

  const args = getCronArgs(profile, 'edit', ctx.params.id)
  if (body.schedule != null || body.schedule_display != null) {
    args.push('--schedule', String(body.schedule ?? body.schedule_display))
  }
  if (body.prompt != null) args.push('--prompt', String(body.prompt))
  if (body.name != null) args.push('--name', String(body.name))
  if (body.deliver != null) args.push('--deliver', String(body.deliver))

  const repeat = getRepeatValue(body.repeat)
  if (repeat != null) {
    args.push('--repeat', String(repeat))
  } else if (hasRepeatField(body)) {
    // Hermes CLI normalizes repeat <= 0 to an unbounded/null repeat.
    args.push('--repeat', '0')
  }

  const skills = getSkills(body)
  if (skills) {
    if (skills.length === 0) {
      args.push('--clear-skills')
    } else {
      for (const skill of skills) args.push('--skill', skill)
    }
  }

  if (body.script != null) args.push('--script', String(body.script))
  if (body.workdir != null) args.push('--workdir', String(body.workdir))
  if (body.no_agent === true) args.push('--no-agent')
  if (body.no_agent === false) args.push('--agent')

  try {
    const inferenceUpdates = await withGatewayInference(profile, buildInferenceUpdates(body), existing)
    const hasCliUpdates = args.length > 5
    if (hasCliUpdates) {
      await runHermesCron(profile, args)
    }
    const patchedJob = patchJobFields(profile, ctx.params.id, inferenceUpdates)
    const job = patchedJob || findJob(profile, ctx.params.id)
    if (!job) return sendJobNotFound(ctx)
    ctx.body = { job: logicalJob(profile, job) }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function remove(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, getCronArgs(profile, 'remove', ctx.params.id))
    ctx.body = { ok: true }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function pause(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, getCronArgs(profile, 'pause', ctx.params.id))
    const job = findJob(profile, ctx.params.id)
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function resume(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await runHermesCron(profile, getCronArgs(profile, 'resume', ctx.params.id))
    const job = findJob(profile, ctx.params.id)
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}

export async function run(ctx: Context) {
  const profile = resolveProfile(ctx)
  if (!findJob(profile, ctx.params.id)) return sendJobNotFound(ctx)

  try {
    await startHermesCronInBackground(profile, getCronArgs(profile, 'run', ctx.params.id))
    const job = findJob(profile, ctx.params.id)
    ctx.status = 202
    ctx.body = { job }
  } catch (error: any) {
    sendCommandError(ctx, error)
  }
}
