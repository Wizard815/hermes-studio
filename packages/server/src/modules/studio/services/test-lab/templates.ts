import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Test Lab app templates (docs/test-lab.md): one JSON file per app. Studio ships
 * some in `assets/test-lab/templates`; more can be added as files in
 * `HERMES_WEB_UI_HOME/test-lab/templates` (a file with the same id wins).
 */

export interface SeedStep {
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  headers?: Record<string, string>
  json?: unknown
  form?: Record<string, string>
  expect?: number[]
  /** Variables to keep: name → JSON path in the answer ("a.b.0"), or "header:<name>". */
  save?: Record<string, string>
  /** A failed optional step does not stop the others. */
  optional?: boolean
}

export interface TestLabTemplate {
  id: string
  name: string
  description: string
  /** Pinned image (a version tag or digest, never latest). */
  image?: string
  /** Build from a git URL (`url#ref`) when there is no image; an empty `git` means the user gives it. */
  build?: { git: string; dockerfile?: string }
  port: number
  env?: Record<string, string>
  entrypoint?: string[]
  cmd?: string[]
  memory?: string
  sizeMb?: number
  health: { path: string; timeoutSeconds?: number; expect?: number[] }
  logins: Array<{ username: string; password: string; role?: string }>
  seed?: SeedStep[]
  /** Told to the agent. */
  notes?: string
  /** First page to open (default "/"). */
  start?: string
}

export interface LoadedTemplate extends TestLabTemplate { source: 'builtin' | 'custom'; file: string }
export interface TemplateProblem { file: string; errors: string[] }

const ID = /^[a-z][a-z0-9-]{1,30}$/
const FLOATING_TAGS = new Set(['latest', 'stable', 'main', 'master', 'nightly', 'dev', 'edge', 'beta', 'rc', 'unstable', 'preview'])
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** An image reference with a fixed version: `repo:tag` (not a floating tag) or `repo@sha256:…`. */
export function isPinnedImage(image: string): boolean {
  if (!/^[a-z0-9][\w./:@-]{0,250}$/i.test(image)) return false
  if (/@sha256:[a-f0-9]{64}$/.test(image)) return true
  const slash = image.lastIndexOf('/')
  const colon = image.lastIndexOf(':')
  if (colon <= slash) return false
  const tag = image.slice(colon + 1)
  return /^[\w][\w.-]{0,127}$/.test(tag) && !FLOATING_TAGS.has(tag.toLowerCase())
}

/** A git URL Docker can build from: https only, optional `#ref`. */
export function isBuildUrl(url: string): boolean {
  return /^https:\/\/[\w.-]+\/[\w./-]+?(\.git)?(#[\w./-]+)?$/.test(url)
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const stringMap = (value: unknown) => isObject(value) && Object.values(value).every(item => typeof item === 'string')

/** Every problem with a template, in plain words; empty when it can be used. */
export function validateTemplate(raw: unknown): string[] {
  const errors: string[] = []
  if (!isObject(raw)) return ['The file is not a JSON object']
  const t = raw as Record<string, any>
  if (typeof t.id !== 'string' || !ID.test(t.id)) errors.push('id: 2-31 lowercase letters, digits or dashes, starting with a letter')
  if (typeof t.name !== 'string' || !t.name.trim()) errors.push('name: missing')
  if (typeof t.description !== 'string') errors.push('description: missing')
  if (t.image === undefined && t.build === undefined) errors.push('image or build: one is needed')
  if (t.image !== undefined && (typeof t.image !== 'string' || !isPinnedImage(t.image))) errors.push('image: needs a fixed version (repo:1.2.3 or repo@sha256:…), not latest')
  if (t.build !== undefined) {
    if (!isObject(t.build) || typeof t.build.git !== 'string') errors.push('build.git: missing')
    else if (t.build.git && !isBuildUrl(t.build.git)) errors.push('build.git: an https git URL, optionally with #branch')
    if (isObject(t.build) && t.build.dockerfile !== undefined && (typeof t.build.dockerfile !== 'string' || !/^[\w./-]{1,200}$/.test(t.build.dockerfile) || t.build.dockerfile.includes('..'))) errors.push('build.dockerfile: a path inside the repository')
  }
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) errors.push('port: a number from 1 to 65535')
  if (t.env !== undefined && !stringMap(t.env)) errors.push('env: names and text values')
  for (const key of ['entrypoint', 'cmd'] as const) {
    if (t[key] !== undefined && (!Array.isArray(t[key]) || !t[key].every((part: unknown) => typeof part === 'string'))) errors.push(`${key}: a list of strings`)
  }
  if (t.memory !== undefined && (typeof t.memory !== 'string' || !/^\d{1,6}[kmg]$/i.test(t.memory))) errors.push('memory: like 512m or 2g')
  if (!isObject(t.health) || typeof t.health.path !== 'string' || !t.health.path.startsWith('/')) errors.push('health.path: a path starting with /')
  else {
    const health = t.health as Record<string, any>
    if (health.timeoutSeconds !== undefined && (!Number.isInteger(health.timeoutSeconds) || health.timeoutSeconds < 5 || health.timeoutSeconds > 1800)) errors.push('health.timeoutSeconds: 5 to 1800')
    if (health.expect !== undefined && (!Array.isArray(health.expect) || !health.expect.every(Number.isInteger))) errors.push('health.expect: a list of status codes')
  }
  if (!Array.isArray(t.logins) || !t.logins.every((login: any) => isObject(login) && typeof login.username === 'string' && typeof login.password === 'string')) errors.push('logins: a list of { username, password }')
  if (t.seed !== undefined) {
    if (!Array.isArray(t.seed)) errors.push('seed: a list of steps')
    else t.seed.forEach((raw: unknown, index: number) => {
      const where = `seed[${index}]`
      if (!isObject(raw)) { errors.push(`${where}: not an object`); return }
      const step = raw as Record<string, any>
      if (typeof step.name !== 'string' || !step.name) errors.push(`${where}.name: missing`)
      if (!METHODS.includes(step.method)) errors.push(`${where}.method: one of ${METHODS.join(', ')}`)
      if (typeof step.path !== 'string' || !step.path.startsWith('/')) errors.push(`${where}.path: a path starting with /`)
      if (step.headers !== undefined && !stringMap(step.headers)) errors.push(`${where}.headers: names and text values`)
      if (step.form !== undefined && !stringMap(step.form)) errors.push(`${where}.form: names and text values`)
      if (step.json !== undefined && step.form !== undefined) errors.push(`${where}: json or form, not both`)
      if (step.expect !== undefined && (!Array.isArray(step.expect) || !step.expect.every(Number.isInteger))) errors.push(`${where}.expect: a list of status codes`)
      if (step.save !== undefined && !stringMap(step.save)) errors.push(`${where}.save: variable names and paths`)
    })
  }
  for (const key of ['notes', 'start'] as const) if (t[key] !== undefined && typeof t[key] !== 'string') errors.push(`${key}: text`)
  if (t.start !== undefined && typeof t.start === 'string' && !t.start.startsWith('/')) errors.push('start: a path starting with /')
  return errors
}

/** Where Studio's own templates are: dist/server/assets after a build, the source tree in development. */
export function builtinTemplateDir(): string {
  const candidates = [
    join(__dirname, 'assets', 'test-lab', 'templates'),
    resolve(__dirname, '..', '..', '..', '..', 'assets', 'test-lab', 'templates'),
    join(process.cwd(), 'dist', 'server', 'assets', 'test-lab', 'templates'),
    join(process.cwd(), 'packages', 'server', 'src', 'assets', 'test-lab', 'templates'),
  ]
  return candidates.find(dir => existsSync(join(dir, 'nginx.json'))) || candidates[candidates.length - 1]
}

export function runnerScriptFile(): string {
  return join(builtinTemplateDir(), '..', 'runner.mjs')
}

/** Every template: Studio's, then the user's folder (same id replaces). Broken files are listed, not used. */
export function loadTemplates(dirs: Array<{ dir: string; source: 'builtin' | 'custom' }>): { templates: LoadedTemplate[]; problems: TemplateProblem[] } {
  const byId = new Map<string, LoadedTemplate>()
  const problems: TemplateProblem[] = []
  for (const { dir, source } of dirs) {
    let names: string[] = []
    try { names = readdirSync(dir).filter(name => name.endsWith('.json')).sort() } catch { continue }
    for (const name of names) {
      const file = join(dir, name)
      let raw: unknown
      try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        problems.push({ file, errors: [`Not valid JSON: ${(error as Error).message}`] })
        continue
      }
      const errors = validateTemplate(raw)
      if (errors.length) { problems.push({ file, errors }); continue }
      byId.set((raw as TestLabTemplate).id, { ...(raw as TestLabTemplate), source, file })
    }
  }
  return { templates: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)), problems }
}

/** The image to pull: Docker Hub images go through the mirror when one is set; others are pulled as they are. */
export function pullReference(image: string, mirror: string): { from: string; fallback?: string } {
  const first = image.split('/')[0]
  const hasRegistry = image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')
  if (hasRegistry || !mirror) return { from: image }
  const path = image.includes('/') ? image : `library/${image}`
  return { from: `${mirror.replace(/\/+$/, '')}/${path}`, fallback: image }
}

/** Split `repo:tag` / `repo@digest` for the Engine API's image create call. */
export function splitImage(image: string): { fromImage: string; tag: string } {
  const at = image.indexOf('@')
  if (at > 0) return { fromImage: image.slice(0, at), tag: image.slice(at + 1) }
  const slash = image.lastIndexOf('/')
  const colon = image.lastIndexOf(':')
  return colon > slash ? { fromImage: image.slice(0, colon), tag: image.slice(colon + 1) } : { fromImage: image, tag: 'latest' }
}
