import { failure, lastLine, parseJson, runCli, type CliResult, type CliRunner } from './cli'

/**
 * The `skillshare` CLI (runkids/skillshare) on the Studio server, the way its
 * herdr panel shows it: what needs a sync, every target, the library, and
 * Sync / Update / Install. Global scope only; every command is an argument
 * array, and writes run one at a time.
 */

export type SkillshareKind = 'skills' | 'agents' | 'mcp' | 'plugins' | 'extras'
export type SkillshareState = 'ok' | 'sync' | 'missing' | 'update' | 'off' | 'broken'

export interface SkillshareItem {
  key: string
  kind: SkillshareKind
  name: string
  state: SkillshareState
  source: string
  targets: string[]
  reason?: string
}

export interface SkillshareKindSummary { kind: SkillshareKind; total: number; needsSync: number; updates: number }

export interface SkillshareOverview {
  installed: boolean
  version?: string
  source?: string
  error?: string
  /** waiting: resources still to sync to that target. */
  targets: Array<{ name: string; path: string; waiting: number }>
  kinds: SkillshareKindSummary[]
  items: SkillshareItem[]
  /** Updates were asked for (slow: every source's remote). */
  checked: boolean
  checkedAt: number
}

export interface SkillshareRaw {
  status?: any
  list?: any
  diff?: any
  mcp?: any
  plugins?: any
  extras?: any
  check?: any
  checkAgents?: any
}

const KINDS: SkillshareKind[] = ['skills', 'agents', 'mcp', 'plugins', 'extras']

const shortSource = (value: unknown) => String(value || '').replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/\.git$/, '')

/** The panel's model, reduced to what the dock shows. Pure: the tests feed it CLI JSON. */
export function buildOverview(raw: SkillshareRaw, now = Date.now()): Omit<SkillshareOverview, 'installed' | 'error'> {
  const items: SkillshareItem[] = []
  const drift = new Map<string, { action: string; reason: string; targets: string[] }>()
  const waiting = new Map<string, number>()
  for (const target of raw.diff?.targets || []) {
    let n = 0
    for (const item of target.items || []) {
      if (!item?.is_sync) continue
      n++
      const kind = item.kind === 'agent' ? 'agents' : 'skills'
      const key = `${kind}:${String(item.name || '').replace(/\.md$/, '')}`
      const was = drift.get(key)
      drift.set(key, { action: was?.action === 'modify' ? 'modify' : String(item.action || ''), reason: was?.reason || String(item.reason || ''), targets: [...(was?.targets || []), String(target.name)] })
    }
    waiting.set(String(target.name), n)
  }
  const checks = new Map<string, any>()
  for (const skill of raw.check?.skills || []) checks.set(`skills:${skill.name}`, skill)
  for (const agent of Array.isArray(raw.checkAgents) ? raw.checkAgents : []) checks.set(`agents:${agent.name}`, agent)
  const behind = new Map<string, any>((raw.check?.tracked_repos || []).map((repo: any) => [repo.name, repo]))

  for (const entry of Array.isArray(raw.list) ? raw.list : []) {
    const kind: SkillshareKind = entry.kind === 'agent' ? 'agents' : 'skills'
    const rel = String(entry.relPath ?? entry.name ?? '').replace(/\.md$/, '')
    const name = kind === 'agents' ? String(entry.name || '').replace(/\.md$/, '') : String(entry.name || '')
    const check = checks.get(`${kind}:${rel}`) ?? checks.get(`${kind}:${name}`)
    const repo = entry.repoName ? behind.get(entry.repoName) : null
    const d = drift.get(`${kind}:${name}`)
    let state: SkillshareState = 'ok'
    if (entry.disabled) state = 'off'
    else if (check?.status === 'update_available' || repo?.status === 'behind') state = 'update'
    else if (d) state = d.action === 'add' ? 'missing' : 'sync'
    items.push({
      key: `${kind}:${rel || name}`,
      kind,
      name: rel || name,
      state,
      source: shortSource(check?.source ?? entry.source) || (entry.repoName ? `tracked repo ${entry.repoName}` : 'local'),
      targets: d?.targets || [],
      ...(d?.reason ? { reason: d.reason } : {}),
    })
  }

  const mcp = new Map<string, { targets: string[]; pending: string[] }>()
  for (const change of raw.mcp?.changes || []) {
    const entry = mcp.get(change.name) || { targets: [], pending: [] }
    if (change.target) entry.targets.push(change.target)
    if (change.action && change.action !== 'unchanged') entry.pending.push(`${change.target}: ${change.action}`)
    mcp.set(change.name, entry)
  }
  for (const [name, entry] of mcp) {
    items.push({ key: `mcp:${name}`, kind: 'mcp', name, state: entry.pending.length ? 'sync' : 'ok', source: 'MCP server', targets: entry.targets, ...(entry.pending.length ? { reason: entry.pending.join(', ') } : {}) })
  }
  for (const [name, plugin] of Object.entries<any>(raw.plugins?.packages || {})) {
    const bindings = Object.entries<any>(plugin?.bindings || {})
    const pending = bindings.filter(([, binding]) => binding?.pending || binding?.sync === false).map(([target]) => target)
    items.push({
      key: `plugins:${name}`, kind: 'plugins', name,
      state: pending.length ? 'sync' : bindings.length ? 'ok' : 'missing',
      source: shortSource(plugin?.source) || 'plugin',
      targets: bindings.map(([target]) => target),
      ...(pending.length ? { reason: `pending in ${pending.join(', ')}` } : {}),
    })
  }
  for (const extra of Array.isArray(raw.extras) ? raw.extras : []) {
    const rows = Array.isArray(extra?.targets) ? extra.targets : []
    const gone = extra?.source_exists === false || rows.some((row: any) => row?.status === 'no source')
    const lag = rows.filter((row: any) => !['synced', 'no source'].includes(String(row?.status || '')))
    items.push({
      key: `extras:${extra.name}`, kind: 'extras', name: String(extra.name || ''),
      state: gone ? 'broken' : lag.length ? 'sync' : 'ok',
      source: gone ? 'source missing' : extra.file ? String(extra.file) : `${extra.file_count ?? 0} files`,
      targets: rows.map((row: any) => String(row?.path || '')).filter(Boolean),
    })
  }

  const kinds = KINDS.map(kind => {
    const own = items.filter(item => item.kind === kind)
    return {
      kind,
      total: own.length,
      needsSync: own.filter(item => item.state === 'sync' || item.state === 'missing').length,
      updates: own.filter(item => item.state === 'update').length,
    }
  })
  const targets = (raw.status?.targets || []).map((target: any) => ({ name: String(target.name), path: String(target.path || ''), waiting: waiting.get(String(target.name)) || 0 }))
  for (const [name, n] of waiting) if (!targets.some((target: { name: string }) => target.name === name)) targets.push({ name, path: '', waiting: n })
  return {
    version: raw.status?.version ? String(raw.status.version) : undefined,
    source: raw.status?.source?.path ? String(raw.status.source.path) : undefined,
    targets,
    kinds,
    items,
    checked: raw.check != null,
    checkedAt: now,
  }
}

export interface SkillshareResult { ok: boolean; message: string }

/** `skillshare update --json`: an audit block or a failed item is an error. */
export function updateOutcome(result: CliResult): SkillshareResult {
  const body = parseJson<any>(result.stdout)
  const all = [...(body?.items || []), ...(body?.agents || [])]
  const blocked = all.filter((item: any) => item?.status === 'security_blocked').map((item: any) => item.name)
  if (blocked.length) return { ok: false, message: `skillshare's audit blocked ${blocked.join(', ')}. Audit it before updating.` }
  if (result.code !== 0 && !body) return { ok: false, message: failure(result, 'skillshare update') }
  const failed = all.filter((item: any) => item?.status === 'failed')
  if (failed.length) return { ok: false, message: `Could not update ${failed.map((item: any) => item.name).join(', ')}: ${failed[0].error ?? failed[0].message ?? 'see skillshare update'}` }
  const updated = Number(body?.updated ?? all.filter((item: any) => item?.status === 'updated').length) || 0
  return { ok: true, message: updated ? `Updated ${updated}. Targets get it on the next sync.` : 'Already up to date' }
}

/** `skillshare install --json`: the exit status stays authoritative; its own audit can stop an install. */
export function installOutcome(result: CliResult): SkillshareResult {
  const body = parseJson<any>(result.stdout)
  const done: string[] = body?.skills || []
  const failed: string[] = body?.failed || []
  const skipped: string[] = body?.skipped || []
  if (body?.error) return { ok: false, message: String(body.error) }
  if (result.code !== 0) {
    return { ok: false, message: [done.length ? `Installed: ${done.join(', ')}.` : '', failed.length ? `Failed: ${failed.join(', ')}.` : '', lastLine(result.stderr), `skillshare install exited with ${result.code}.`].filter(Boolean).join(' ') }
  }
  if (failed.length) return { ok: false, message: `Installed ${done.length}; ${failed.join(', ')} failed. skillshare's audit can stop one.` }
  if (!body) return { ok: false, message: failure(result, 'skillshare install returned no JSON') }
  if (skipped.length) return { ok: true, message: `Installed ${done.length}; ${skipped.join(', ')} already installed.` }
  return { ok: true, message: done.length ? `Installed ${done.join(', ')}. Sync sends it to every target.` : 'Nothing to install' }
}

const SOURCE = /^(https:\/\/|git@|\w[\w.-]*\/[\w.-]+)/
const NAME = /^\w[\w@.\/-]*$/

export class Skillshare {
  private checks: { check: any; checkAgents: any } | null = null
  private busy: Promise<unknown> = Promise.resolve()

  constructor(private readonly run: CliRunner = runCli, private readonly bin = 'skillshare', private readonly now: () => number = Date.now) {}

  private cli(args: string[], timeoutMs = 30_000) {
    return this.run(this.bin, args, { timeoutMs, env: { SKILLSHARE_NO_UPDATE_CHECK: '1', CI: '1' } })
  }

  /** One write at a time, in order. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.busy.then(work, work)
    this.busy = next.catch(() => undefined)
    return next
  }

  async overview(): Promise<SkillshareOverview> {
    const empty = { targets: [], kinds: [], items: [], checked: false, checkedAt: this.now() }
    const status = await this.cli(['status', '--json', '-g'])
    if (status.missing) return { installed: false, ...empty }
    const statusBody = parseJson(status.stdout)
    if (status.code !== 0 || !statusBody) return { installed: true, error: failure(status, 'skillshare status'), ...empty }
    const read = async (args: string[]) => {
      const result = await this.cli([...args, '--json', '-g'])
      return result.code === 0 ? parseJson(result.stdout) : null
    }
    const [list, diff, mcp, plugins, extras] = await Promise.all([
      read(['list', '--all']), read(['diff']), read(['mcp', 'list']), read(['plugin', 'list']), read(['extras', 'list']),
    ])
    return { installed: true, ...buildOverview({ status: statusBody, list, diff, mcp, plugins, extras, ...(this.checks || {}) }, this.now()) }
  }

  /** Ask every source's remote for updates (slow); later overviews show them. */
  async checkUpdates(): Promise<SkillshareOverview> {
    const [check, checkAgents] = await Promise.all([this.cli(['check', '--json', '-g'], 120_000), this.cli(['check', 'agents', '--json', '-g'], 120_000)])
    if (check.missing) return this.overview()
    this.checks = { check: parseJson(check.stdout) || { skills: [], tracked_repos: [] }, checkAgents: parseJson(checkAgents.stdout) || [] }
    return this.overview()
  }

  sync(): Promise<SkillshareResult> {
    return this.serial(async () => {
      const result = await this.cli(['sync', '--all', '--json', '-g'], 120_000)
      return result.code === 0 ? { ok: true, message: 'Synced every target' } : { ok: false, message: failure(result, 'skillshare sync') }
    })
  }

  update(input: { kind?: string; name?: string; all?: boolean }): Promise<SkillshareResult> {
    const kind = input.kind === 'agents' ? 'agents' : 'skills'
    const name = String(input.name || '')
    if (!input.all && !NAME.test(name)) return Promise.resolve({ ok: false, message: 'Pick a skill or agent to update' })
    return this.serial(async () => {
      const result = await this.cli(['update', ...(kind === 'agents' ? ['agents'] : []), ...(input.all ? ['--all'] : [name]), '--json', '-g'], 300_000)
      const outcome = updateOutcome(result)
      if (outcome.ok) this.checks = null
      return outcome
    })
  }

  install(source: string): Promise<SkillshareResult> {
    const value = String(source || '').trim()
    if (!SOURCE.test(value) || /\s/.test(value)) return Promise.resolve({ ok: false, message: 'Give a GitHub owner/repo or a git URL' })
    return this.serial(async () => installOutcome(await this.cli(['install', value, '--json', '-g'], 300_000)))
  }
}
