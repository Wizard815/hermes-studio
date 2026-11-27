import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { config } from '../../public/config'
import { logger } from '../../public/logging'
import { safeFileStore } from '../../public/safe-file-store'
import { readAppConfig } from '../config/app-config'
import { getCodingAgentGlobalHome } from '../../public/coding-agent-global-home'

/**
 * UI skills (bundled), docs/ui-skills.md: design and frontend skills from
 * jakubkrehel/skills (MIT), copied once into every Hermes profile, every Ekko
 * profile and the coding agents' skill folders. Each copy is recorded in Web
 * UI state; a copy the user removes stays removed, a copy the user edits is
 * never overwritten, and a folder of the same name made by the user is left alone.
 */

export const UI_SKILLS_ENV = 'STUDIO_UI_SKILLS'
/** Hermes and Ekko group them in this category folder (the Skills page shows it as "UI skills (bundled)"). */
export const UI_SKILLS_CATEGORY = 'ui-skills'
export const UI_SKILLS_SOURCE = {
  repo: 'https://github.com/jakubkrehel/skills',
  author: 'Jakub Krehel',
  licence: 'MIT',
  commit: '672ae44ace6aaed65b86cbb1e2fd6fbea0e79578',
}

const CATEGORY_DESCRIPTION = 'UI skills (bundled): design and frontend guides by Jakub Krehel (MIT), installed once by Studio.\n'
const HASH_IGNORED = new Set(['.DS_Store', 'Thumbs.db'])

export type UiSkillTargetKind = 'hermes' | 'ekko' | 'claude-code' | 'shared'

export interface UiSkillTarget {
  kind: UiSkillTargetKind
  /** Shown on the Skills page, e.g. "Hermes profile work" or "Claude Code". */
  label: string
  profile?: string
  /** The folder the skill folders go in. */
  dir: string
  /** Write a DESCRIPTION.md so Hermes shows the folder as a category. */
  category?: boolean
}

export type UiSkillOutcome = 'installed' | 'kept-existing'

export interface UiSkillRecord {
  outcome: UiSkillOutcome
  at: string
  /** Hash of the copy Studio wrote: a different one on disk means the user edited it. */
  hash?: string
  /** Hash of the bundle it came from: a newer bundle updates an unedited copy. */
  source?: string
}

export interface UiSkillsState {
  version: 1
  /** Keyed by the target folder. */
  targets: Record<string, { kind: UiSkillTargetKind; label: string; skills: Record<string, UiSkillRecord> }>
}

/** What each skill is in a target now. */
export type UiSkillStatus = 'installed' | 'removed' | 'edited' | 'kept-existing' | 'pending'

export interface UiSkillsRunResult {
  dir: string
  installed: string[]
  updated: string[]
  kept: string[]
  skipped: string[]
  error?: string
}

export interface BundledUiSkill { name: string; description: string }

export function resolveUiSkillsSourceDir(env: NodeJS.ProcessEnv = process.env, baseDir = __dirname): string {
  const override = env.STUDIO_UI_SKILLS_DIR?.trim()
  if (override) return resolve(override)
  const candidates = [
    // Production bundle: dist/server/index.js with dist/ui-skills copied by the build.
    resolve(baseDir, '../ui-skills'),
    // Source tree: packages/server/src/modules/studio/services/ui-skills -> packages/ui-skills.
    resolve(baseDir, '../../../../../../ui-skills'),
    resolve(process.cwd(), 'packages/ui-skills'),
  ]
  return candidates.find(candidate => existsSync(join(candidate, 'better-interface', 'SKILL.md'))) || candidates[0]
}

function frontmatterValue(text: string, key: string): string {
  const block = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
  return block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || ''
}

/** The skill folders in the bundle (each has a SKILL.md). */
export function listBundledUiSkills(sourceDir = resolveUiSkillsSourceDir()): BundledUiSkill[] {
  try {
    return readdirSync(sourceDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(sourceDir, entry.name, 'SKILL.md')))
      .map(entry => ({ name: entry.name, description: frontmatterValue(readFileSync(join(sourceDir, entry.name, 'SKILL.md'), 'utf8'), 'description') }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function uiSkillsStateFile(): string {
  return join(config.appHome, 'ui-skills.json')
}

function emptyState(): UiSkillsState {
  return { version: 1, targets: {} }
}

function parseState(raw: string): UiSkillsState {
  if (!raw.trim()) return emptyState()
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.version !== 1 || typeof parsed.targets !== 'object' || Array.isArray(parsed.targets)) throw new Error('Unsupported UI skills state')
  return parsed as UiSkillsState
}

export async function readUiSkillsState(stateFile = uiSkillsStateFile()): Promise<UiSkillsState> {
  try {
    return parseState(await safeFileStore.readText(stateFile))
  } catch (err: any) {
    if (err?.code === 'ENOENT') return emptyState()
    throw err
  }
}

function envDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(0|false|no|off)$/i.test(String(env[UI_SKILLS_ENV] || '').trim())
}

/** On unless STUDIO_UI_SKILLS=0 or the Settings switch is off. */
export async function uiSkillsSetting(env: NodeJS.ProcessEnv = process.env): Promise<{ enabled: boolean; disabledByEnv: boolean }> {
  const disabledByEnv = envDisabled(env)
  const saved = (await readAppConfig()).uiSkills !== false
  return { enabled: saved && !disabledByEnv, disabledByEnv }
}

async function hashDir(dir: string): Promise<string> {
  const hash = createHash('sha256')
  async function walk(current: string, rel: string) {
    const entries = (await readdir(current, { withFileTypes: true }))
      .filter(entry => !HASH_IGNORED.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        hash.update(`dir\0${path}\0`)
        await walk(join(current, entry.name), path)
      } else if (entry.isFile()) {
        hash.update(`file\0${path}\0`)
        hash.update(await readFile(join(current, entry.name)))
        hash.update('\0')
      }
    }
  }
  await walk(dir, '')
  return hash.digest('hex')
}

async function copyDir(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyDir(join(source, entry.name), join(target, entry.name))
    else if (entry.isFile()) await copyFile(join(source, entry.name), join(target, entry.name))
  }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

export interface ApplyUiSkillsOptions {
  sourceDir?: string
  stateFile?: string
  now?: () => Date
  /** The DESCRIPTION.md written into a new category folder (another bundle, e.g. homelab skills, has its own). */
  categoryDescription?: string
}

/**
 * Copies the bundled skills a target has not had yet. Never throws; a target
 * that fails is retried on the next start.
 */
export async function applyUiSkills(targets: UiSkillTarget[], options: ApplyUiSkillsOptions = {}): Promise<UiSkillsRunResult[]> {
  const sourceDir = options.sourceDir || resolveUiSkillsSourceDir()
  const stateFile = options.stateFile || uiSkillsStateFile()
  const now = options.now || (() => new Date())
  const bundled = listBundledUiSkills(sourceDir)
  if (!bundled.length) {
    logger.warn('[ui-skills] no bundled UI skills at %s', sourceDir)
    return []
  }
  let state: UiSkillsState
  try {
    state = await readUiSkillsState(stateFile)
  } catch (err) {
    logger.warn(err, '[ui-skills] state file unreadable; not touching any skills folder')
    return []
  }
  const sourceHashes = new Map<string, string>()
  for (const skill of bundled) sourceHashes.set(skill.name, await hashDir(join(sourceDir, skill.name)))

  const results: UiSkillsRunResult[] = []
  const changes = new Map<string, { target: UiSkillTarget; records: Record<string, UiSkillRecord> }>()
  for (const target of targets) {
    const dir = resolve(target.dir)
    const result: UiSkillsRunResult = { dir, installed: [], updated: [], kept: [], skipped: [] }
    const known = state.targets[dir]?.skills || {}
    const records: Record<string, UiSkillRecord> = {}
    try {
      for (const skill of bundled) {
        const dest = join(dir, skill.name)
        const source = sourceHashes.get(skill.name)!
        const record = known[skill.name]
        const at = now().toISOString()
        if (!record) {
          if (existsSync(dest)) {
            // The user's own folder of that name: never replaced.
            records[skill.name] = { outcome: 'kept-existing', at }
            result.kept.push(skill.name)
            continue
          }
          await copyDir(join(sourceDir, skill.name), dest)
          records[skill.name] = { outcome: 'installed', at, hash: await hashDir(dest), source }
          result.installed.push(skill.name)
          continue
        }
        // Done before: removed or edited copies stay as the user left them.
        if (record.outcome !== 'installed' || !isDir(dest) || record.source === source) { result.skipped.push(skill.name); continue }
        if (await hashDir(dest) !== record.hash) { result.skipped.push(skill.name); continue }
        // An unedited copy of an older bundle: replace it with the new one.
        await rm(dest, { recursive: true, force: true })
        await copyDir(join(sourceDir, skill.name), dest)
        records[skill.name] = { outcome: 'installed', at, hash: await hashDir(dest), source }
        result.updated.push(skill.name)
      }
      if (target.category && result.installed.length && !existsSync(join(dir, 'DESCRIPTION.md'))) {
        await writeFile(join(dir, 'DESCRIPTION.md'), options.categoryDescription || CATEGORY_DESCRIPTION, 'utf8')
      }
    } catch (err: any) {
      result.error = String(err?.message || err).slice(0, 300)
      logger.warn('[ui-skills] could not install into %s: %s (retry on next start)', dir, result.error)
    }
    if (Object.keys(records).length) changes.set(dir, { target, records })
    results.push(result)
  }

  if (changes.size) {
    try {
      await safeFileStore.updateText(stateFile, (current) => {
        const next = parseState(current)
        for (const [dir, { target, records }] of changes) {
          const entry = next.targets[dir] || { kind: target.kind, label: target.label, skills: {} }
          entry.kind = target.kind
          entry.label = target.label
          entry.skills = { ...entry.skills, ...records }
          next.targets[dir] = entry
        }
        return JSON.stringify(next, null, 2) + '\n'
      }, { backup: true })
    } catch (err) {
      logger.warn(err, '[ui-skills] could not save state')
    }
  }
  for (const result of results) {
    if (result.installed.length || result.updated.length) {
      logger.info('[ui-skills] %s: installed %s; updated %s', result.dir, result.installed.join(', ') || '-', result.updated.join(', ') || '-')
    }
  }
  return results
}

/** Each bundled skill's status in a target, from the state and the folder on disk. */
export async function uiSkillStatuses(target: UiSkillTarget, state: UiSkillsState, bundled: BundledUiSkill[]): Promise<Record<string, UiSkillStatus>> {
  const dir = resolve(target.dir)
  const known = state.targets[dir]?.skills || {}
  const statuses: Record<string, UiSkillStatus> = {}
  for (const skill of bundled) {
    const record = known[skill.name]
    const dest = join(dir, skill.name)
    if (!record) statuses[skill.name] = 'pending'
    else if (record.outcome === 'kept-existing') statuses[skill.name] = 'kept-existing'
    else if (!isDir(dest)) statuses[skill.name] = 'removed'
    else statuses[skill.name] = record.hash && await hashDir(dest).catch(() => '') !== record.hash ? 'edited' : 'installed'
  }
  return statuses
}

// ---- targets -----------------------------------------------------------------

type TargetProvider = () => UiSkillTarget[] | Promise<UiSkillTarget[]>
const providers = new Map<string, TargetProvider>()

/** Hermes, Ekko and the coding agents each say where their skills go (registered by bootstrap). */
export function registerUiSkillTargetProvider(name: string, provider: TargetProvider): void {
  providers.set(name, provider)
}

/** Claude Code reads ~/.claude/skills; Codex, OpenCode, Pi, Grok, DSH, Cursor and Antigravity read ~/.agents/skills. */
export function codingAgentUiSkillTargets(home = getCodingAgentGlobalHome()): UiSkillTarget[] {
  return [
    { kind: 'claude-code', label: 'Claude Code', dir: join(home, '.claude', 'skills') },
    { kind: 'shared', label: 'Shared agent skills (~/.agents/skills)', dir: join(home, '.agents', 'skills') },
  ]
}

export async function allUiSkillTargets(): Promise<UiSkillTarget[]> {
  const targets: UiSkillTarget[] = []
  for (const [name, provider] of providers) {
    try { targets.push(...await provider()) } catch (err) { logger.warn(err, '[ui-skills] %s targets unavailable', name) }
  }
  const seen = new Set<string>()
  return targets.filter(target => {
    const dir = resolve(target.dir)
    if (seen.has(dir)) return false
    seen.add(dir)
    return true
  })
}

/**
 * The bundle mirrored into Web UI state, which is on a mounted volume when
 * Studio runs in Docker (clean rooms mount it read-only from there).
 */
export function uiSkillsMirrorDir(): string {
  return join(config.appHome, 'ui-skills', 'bundle')
}

async function refreshMirror(sourceDir: string): Promise<void> {
  const mirror = uiSkillsMirrorDir()
  for (const skill of listBundledUiSkills(sourceDir)) {
    const from = join(sourceDir, skill.name)
    const to = join(mirror, skill.name)
    if (isDir(to) && await hashDir(to) === await hashDir(from)) continue
    await rm(to, { recursive: true, force: true })
    await copyDir(from, to)
  }
}

let running: Promise<void> = Promise.resolve()

/** Runs in the background after anything already queued; never throws. */
export function scheduleUiSkillsInstall(options: ApplyUiSkillsOptions = {}): Promise<void> {
  running = running.then(async () => {
    try {
      const setting = await uiSkillsSetting()
      if (!setting.enabled) {
        logger.info('[ui-skills] install is off (%s)', setting.disabledByEnv ? UI_SKILLS_ENV : 'Settings')
        return
      }
      const sourceDir = options.sourceDir || resolveUiSkillsSourceDir()
      await refreshMirror(sourceDir).catch(err => logger.warn(err, '[ui-skills] could not mirror the bundle for clean rooms'))
      await applyUiSkills(await allUiSkillTargets(), { ...options, sourceDir })
    } catch (err) {
      logger.warn(err, '[ui-skills] run failed (retry on next start)')
    }
  })
  return running
}

// ---- what agents without a skills folder and clean rooms get -------------------

let enabledCache: { at: number; value: boolean } | null = null

/** The setting, read at most every few seconds (asked for on every agent launch). */
async function enabledNow(): Promise<boolean> {
  if (enabledCache && Date.now() - enabledCache.at < 5000) return enabledCache.value
  const value = (await uiSkillsSetting().catch(() => ({ enabled: false }))).enabled
  enabledCache = { at: Date.now(), value }
  return value
}

export function forgetUiSkillsSettingCache(): void {
  enabledCache = null
}

/**
 * A short pointer for agents Studio cannot give a skills folder (Qwen, Kimi,
 * CodeBuddy, Qoder, Copilot, ZCode): which guides are in ~/.agents/skills.
 */
export async function uiSkillsPointer(home = getCodingAgentGlobalHome()): Promise<string> {
  if (!await enabledNow()) return ''
  const shared = join(home, '.agents', 'skills')
  const names = listBundledUiSkills().map(skill => skill.name).filter(name => existsSync(join(shared, name, 'SKILL.md')))
  if (!names.length) return ''
  return `UI skills: before you build, change or review a user interface, read the matching guide in ~/.agents/skills/<name>/SKILL.md (${names.join(', ')}). Start with better-interface for a review.`
}

export interface CleanRoomUiSkillMount { source: string; inside: string }

/**
 * Read-only mounts that give a clean room the UI skills at /root/.claude/skills
 * and /root/.agents/skills. A skill the user removed from the host's folder is
 * left out of the matching folder in the room.
 */
export async function cleanRoomUiSkillMounts(home = getCodingAgentGlobalHome()): Promise<CleanRoomUiSkillMount[]> {
  if (!await enabledNow()) return []
  const mirror = uiSkillsMirrorDir()
  const state = await readUiSkillsState().catch(() => emptyState())
  const mounts: CleanRoomUiSkillMount[] = []
  for (const target of codingAgentUiSkillTargets(home)) {
    const known = state.targets[resolve(target.dir)]?.skills || {}
    const inside = target.kind === 'claude-code' ? '/root/.claude/skills' : '/root/.agents/skills'
    for (const skill of listBundledUiSkills(mirror)) {
      const record = known[skill.name]
      if (record?.outcome === 'installed' && !isDir(join(target.dir, skill.name))) continue
      mounts.push({ source: join(mirror, skill.name), inside: `${inside}/${skill.name}` })
    }
  }
  return mounts
}
