import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { promisify } from 'node:util'
import { create as tarCreate, Parser as TarParser } from 'tar'
import { forgeConfig, forgeGitEnv, onForge, type ForgeConfig } from '../forge'
import { pullReference } from '../test-lab/templates'
import { LABEL_EXPIRES, LABEL_INSTANCE, LABEL_SANDBOX, SandboxDocker } from './docker'

/**
 * Throwaway containers on Studio's own machine (docs/sandbox.md): an agent makes one
 * from an image, runs commands in it, copies files and repos in and out, and removes
 * it, or Studio removes it when its time is up. Network: 'internet' (Docker's default
 * bridge: the internet, none of Studio's own networks) or 'none'.
 */

const run = promisify(execFile)
const ID = /^[a-z0-9]{10}$/
const MAX_OUTPUT = 64 * 1024
const MAX_FILE = 1024 * 1024
const MAX_SANDBOXES = 8

/** Distros and toolchains by name (create's `distro`); any other image works by name too (`image`). */
export const DISTROS: Record<string, { image: string; label: string; install: string }> = {
  ubuntu: { image: 'ubuntu:24.04', label: 'Ubuntu 24.04 LTS', install: 'apt-get update && apt-get install -y' },
  debian: { image: 'debian:trixie-slim', label: 'Debian 13 (slim)', install: 'apt-get update && apt-get install -y' },
  fedora: { image: 'fedora:43', label: 'Fedora 43', install: 'dnf install -y' },
  rocky: { image: 'rockylinux/rockylinux:9', label: 'Rocky Linux 9 (RHEL-like)', install: 'dnf install -y' },
  alpine: { image: 'alpine:3.22', label: 'Alpine 3.22 (tiny, musl)', install: 'apk add' },
  arch: { image: 'archlinux:base', label: 'Arch Linux (rolling)', install: 'pacman -Sy --noconfirm' },
  opensuse: { image: 'opensuse/leap:15.6', label: 'openSUSE Leap 15.6', install: 'zypper -n install' },
  node: { image: 'node:24-bookworm', label: 'Node.js 24 on Debian 12', install: 'apt-get update && apt-get install -y' },
  python: { image: 'python:3.13-bookworm', label: 'Python 3.13 on Debian 12', install: 'apt-get update && apt-get install -y' },
  go: { image: 'golang:1.25-bookworm', label: 'Go 1.25 on Debian 12', install: 'apt-get update && apt-get install -y' },
}

export class SandboxError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export interface SandboxInfo {
  id: string
  image: string
  imageId: string
  network: 'internet' | 'none'
  purpose: string
  createdAt: number
  expiresAt: number
  state: string
  repos: string[]
}

export interface SandboxDeps {
  home: () => string
  docker: SandboxDocker
  /** Labels every sandbox of this Studio, so two Studios on one Docker never remove each other's. */
  instance: string
  now?: () => number
  forge?: ForgeConfig | null
  /** Docker Hub mirror ('' for none); default mirror.gcr.io. */
  mirror?: string
  githubToken?: () => Promise<string>
  /** Clones `url` (optionally at `ref`) into `dest` (tests). */
  clone?: (url: string, ref: string, dest: string) => Promise<void>
}

const str = (value: unknown, max = 4000) => (typeof value === 'string' ? value : value == null ? '' : String(value)).slice(0, max)

/** An absolute path inside the sandbox, without `..`. */
function sandboxPath(value: unknown): string {
  const path = str(value, 1000).trim()
  if (!path.startsWith('/')) throw new SandboxError('Give an absolute path inside the sandbox, e.g. /work/app.py')
  const clean = posix.normalize(path)
  if (clean.split('/').includes('..')) throw new SandboxError('Paths may not contain ..')
  return clean
}

function tail(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= MAX_OUTPUT) return { text, truncated: false }
  return { text: text.slice(-MAX_OUTPUT), truncated: true }
}

export class SandboxService {
  constructor(private readonly deps: SandboxDeps) {}

  private now() { return this.deps.now?.() ?? Date.now() }
  private indexFile() { return join(this.deps.home(), 'sandboxes.json') }

  private read(): Record<string, SandboxInfo & { containerId: string }> {
    try { return JSON.parse(readFileSync(this.indexFile(), 'utf8')) } catch { return {} }
  }

  /** Read, change and write the index with no await in between, so concurrent calls never undo each other. */
  private change(fn: (index: Record<string, SandboxInfo & { containerId: string }>) => void) {
    const index = this.read()
    fn(index)
    this.write(index)
    return index
  }

  private write(index: Record<string, SandboxInfo & { containerId: string }>) {
    mkdirSync(this.deps.home(), { recursive: true })
    const tmp = `${this.indexFile()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(index, null, 2))
    renameSync(tmp, this.indexFile())
  }

  private get(id: unknown) {
    const key = str(id, 40)
    const item = ID.test(key) ? this.read()[key] : undefined
    if (!item) throw new SandboxError(`No sandbox ${key || '(none given)'}: list shows the ones that exist`, 404)
    return item
  }

  private requireDocker() {
    if (!this.deps.docker.available()) throw new SandboxError('Docker is not reachable: run the sandbox-docker sidecar and set STUDIO_SANDBOX_DOCKER_HOST (docs/sandbox.md)', 503)
  }

  async list(): Promise<SandboxInfo[]> {
    const index = this.read()
    const live = this.deps.docker.available() ? await this.deps.docker.list(this.deps.instance).catch(() => []) : []
    const states = new Map(live.map(c => [c.Labels?.[LABEL_SANDBOX] || '', c.State || '']))
    return Object.values(index).map(({ containerId: _c, ...item }) => ({ ...item, state: states.get(item.id) || 'gone' }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async create(input: Record<string, unknown>): Promise<SandboxInfo> {
    this.requireDocker()
    const distro = str(input.distro, 40).trim().toLowerCase()
    if (distro && !DISTROS[distro]) throw new SandboxError(`Unknown distro ${distro}: ${Object.keys(DISTROS).join(', ')}, or give any image`)
    const image = str(input.image, 300).trim() || (distro ? DISTROS[distro].image : '')
    if (!/^[\w][\w.\-/:@]{0,299}$/.test(image)) throw new SandboxError(`Give a distro (${Object.keys(DISTROS).join(', ')}) or an image, e.g. ubuntu:24.04`)
    const network = input.network === 'none' ? 'none' : 'internet'
    const minutes = Math.min(24 * 60, Math.max(5, Number(input.minutes) || 60))
    const memoryGb = Math.min(32, Math.max(0.25, Number(input.memoryGb) || 4))
    const cpus = Math.min(16, Math.max(0.5, Number(input.cpus) || 2))
    const running = (await this.list()).filter(item => item.state === 'running')
    if (running.length >= MAX_SANDBOXES) throw new SandboxError(`${MAX_SANDBOXES} sandboxes are running already: remove one first`, 409)
    if (!(await this.deps.docker.hasImage(image))) await this.pullImage(image)
    const id = randomBytes(5).toString('hex')
    const createdAt = this.now()
    const expiresAt = createdAt + minutes * 60_000
    const containerId = await this.deps.docker.create({
      name: `studio-sandbox-${id}`, image, network: network === 'none' ? 'none' : 'bridge',
      labels: { [LABEL_SANDBOX]: id, [LABEL_INSTANCE]: this.deps.instance, [LABEL_EXPIRES]: String(expiresAt) },
      memoryBytes: Math.round(memoryGb * 1024 ** 3), nanoCpus: Math.round(cpus * 1e9), pidsLimit: 4096,
    })
    const item = { id, containerId, image, imageId: await this.deps.docker.imageId(image).catch(() => ''), network, purpose: str(input.purpose, 300),
      createdAt, expiresAt, state: 'running', repos: [] as string[] } as SandboxInfo & { containerId: string }
    this.change(index => { index[id] = item })
    const { containerId: _c, ...out } = item
    return out
  }

  /** Docker Hub images come through the mirror first (Docker Hub's pull limit), then Docker Hub. */
  private async pullImage(image: string) {
    const mirror = this.deps.mirror ?? 'mirror.gcr.io'
    const { from, fallback } = pullReference(image, mirror)
    try {
      await this.deps.docker.pull(from)
      if (fallback) await this.deps.docker.tag(from, image)
    } catch (first) {
      if (!fallback) throw new SandboxError(`Could not pull ${image}: ${(first as Error).message}`, 502)
      try { await this.deps.docker.pull(image) } catch (error) {
        throw new SandboxError(`Could not pull ${image} (from ${mirror} or Docker Hub): ${(error as Error).message}`, 502)
      }
    }
  }

  async exec(input: Record<string, unknown>) {
    this.requireDocker()
    const item = this.get(input.sandbox)
    const command = str(input.command, 20_000)
    if (!command.trim()) throw new SandboxError('Give the command to run')
    const timeoutSeconds = Math.min(3600, Math.max(1, Number(input.timeoutSeconds) || 300))
    const workdir = input.workdir ? sandboxPath(input.workdir) : '/work'
    const started = this.now()
    const result = await this.deps.docker.exec(item.containerId, command, { workdir, timeoutSeconds })
    const out = tail(result.output)
    return { sandbox: item.id, exitCode: result.exitCode, timedOut: result.exitCode === 137 && this.now() - started >= timeoutSeconds * 1000 - 500,
      output: out.text, truncated: out.truncated }
  }

  async writeFile(input: Record<string, unknown>) {
    this.requireDocker()
    const item = this.get(input.sandbox)
    const path = sandboxPath(input.path)
    const content = typeof input.content === 'string' ? input.content : ''
    if (Buffer.byteLength(content) > MAX_FILE) throw new SandboxError('Files written this way are 1 MB at most: copy a repo in instead')
    const dir = await mkdtemp(join(tmpdir(), 'studio-sandbox-put-'))
    try {
      await writeFile(join(dir, posix.basename(path)), content)
      const tar = await pack(dir, [posix.basename(path)])
      await this.deps.docker.exec(item.containerId, `mkdir -p '${posix.dirname(path).replace(/'/g, `'\\''`)}'`, { workdir: '/', timeoutSeconds: 30 })
      await this.deps.docker.putArchive(item.containerId, posix.dirname(path), tar)
    } finally { await rm(dir, { recursive: true, force: true }) }
    return { sandbox: item.id, path, bytes: Buffer.byteLength(content) }
  }

  async readFile(input: Record<string, unknown>) {
    this.requireDocker()
    const item = this.get(input.sandbox)
    const path = sandboxPath(input.path)
    let entry = await firstEntry(await this.deps.docker.getArchive(item.containerId, path))
    if (entry.type === 'SymbolicLink') {
      // e.g. /etc/os-release: read what the link points at, inside the sandbox
      const real = (await this.deps.docker.exec(item.containerId, `readlink -f '${path.replace(/'/g, `'\\''`)}'`, { workdir: '/', timeoutSeconds: 10 })).output.trim()
      if (real.startsWith('/')) entry = await firstEntry(await this.deps.docker.getArchive(item.containerId, real))
    }
    if (entry.type === 'Directory') throw new SandboxError(`${path} is a folder: run ls with exec instead`)
    const file = entry.data
    if (!file) throw new SandboxError(`${path} is not a regular file (${entry.type})`)
    if (file.length > MAX_FILE) return { sandbox: item.id, path, bytes: file.length, content: file.subarray(0, MAX_FILE).toString('utf8'), truncated: true }
    return { sandbox: item.id, path, bytes: file.length, content: file.toString('utf8'), truncated: false }
  }

  /** Clones a GitHub or forge repo on Studio's machine (with the right token) and copies it to /work/<name>. */
  async copyRepo(input: Record<string, unknown>) {
    this.requireDocker()
    const item = this.get(input.sandbox)
    const url = str(input.repo, 500).trim()
    const ref = str(input.ref, 200).trim()
    if (!/^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url) || url.startsWith('-')) throw new SandboxError('Give the repo as a git URL (GitHub or your forge)')
    if (ref && !/^[\w./-]+$/.test(ref)) throw new SandboxError('ref: a branch, tag or commit name')
    const name = (url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).at(-1) || 'repo').replace(/[^\w.-]/g, '-')
    const dir = await mkdtemp(join(tmpdir(), 'studio-sandbox-repo-'))
    try {
      await (this.deps.clone || ((u, r, d) => this.clone(u, r, d)))(url, ref, join(dir, name))
      const tar = await pack(dir, [name])
      await this.deps.docker.putArchive(item.containerId, '/work', tar)
    } finally { await rm(dir, { recursive: true, force: true }) }
    this.change(index => { if (index[item.id]) index[item.id].repos = [...new Set([...(index[item.id].repos || []), url])] })
    return { sandbox: item.id, repo: url, path: `/work/${name}` }
  }

  private async clone(url: string, ref: string, dest: string) {
    const forge = this.deps.forge !== undefined ? this.deps.forge : forgeConfig()
    let auth: Record<string, string> = {}
    let secret = ''
    if (onForge(url, forge)) { auth = forgeGitEnv(forge); secret = forge?.token || '' }
    else if (/^https:\/\/github\.com\//i.test(url)) {
      const repoPack = await import('../repo-pack')
      const token = this.deps.githubToken ? await this.deps.githubToken() : await repoPack.githubToken()
      if (token) { auth = repoPack.githubGitEnv(token); secret = token }
    }
    await mkdir(dirname(dest), { recursive: true })
    try {
      await run('git', ['clone', ...(ref ? [] : ['--depth', '50']), '--', url, dest], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...auth, GIT_TERMINAL_PROMPT: '0' } })
      if (ref) await run('git', ['-C', dest, 'checkout', '--quiet', ref], { timeout: 60_000 })
    } catch (error: any) {
      let reason = String(error?.stderr || error?.message || error).trim().split('\n').filter(Boolean).at(-1) || 'git clone failed'
      if (secret) reason = reason.split(secret).join('****')
      throw new SandboxError(`Could not clone ${url}: ${reason}`, 422)
    }
  }

  async extend(input: Record<string, unknown>) {
    const item = this.get(input.sandbox)
    const minutes = Math.min(24 * 60, Math.max(5, Number(input.minutes) || 60))
    let expiresAt = 0
    this.change(index => {
      if (!index[item.id]) return
      index[item.id].expiresAt = expiresAt = Math.max(index[item.id].expiresAt, this.now()) + minutes * 60_000
    })
    return { sandbox: item.id, expiresAt }
  }

  async remove(input: Record<string, unknown>) {
    const item = this.get(input.sandbox)
    if (this.deps.docker.available()) await this.deps.docker.remove(item.containerId, this.deps.instance)
    this.change(index => { delete index[item.id] })
    return { sandbox: item.id, removed: true }
  }

  /** Removes sandboxes whose time is up, and forgets ones whose container is gone. */
  async sweep(): Promise<string[]> {
    if (!this.deps.docker.available()) return []
    const known = this.read()
    const removed: string[] = []
    const live = await this.deps.docker.list(this.deps.instance)
    for (const container of live) {
      const id = container.Labels?.[LABEL_SANDBOX] || ''
      const expires = known[id]?.expiresAt ?? Number(container.Labels?.[LABEL_EXPIRES] || 0)
      if (expires <= this.now()) {
        await this.deps.docker.remove(container.Id, this.deps.instance).catch(() => false)
        removed.push(id)
      }
    }
    const liveIds = new Set(live.map(c => c.Labels?.[LABEL_SANDBOX]))
    // A sandbox made while this ran isn't in `live` yet: forget a missing one only when it is older
    // than a minute or Docker says its container is gone.
    const fresh = this.now() - 60_000
    const gone = new Set<string>()
    for (const [id, item] of Object.entries(known)) {
      if (liveIds.has(id) || removed.includes(id)) continue
      if (item.createdAt < fresh || (await this.deps.docker.inspect(item.containerId).catch(() => undefined)) === null) gone.add(id)
    }
    this.change(index => { for (const id of [...removed, ...gone]) delete index[id] })
    return removed
  }

  /** The agent tool: one entry point per action (bin/ekko-studio-mcp.mjs, ekko_studio_use_sandbox). */
  async tool(action: string, input: Record<string, unknown>) {
    switch (action) {
      case 'list': return { sandboxes: await this.list(), distros: DISTROS }
      case 'create': return { sandbox: await this.create(input) }
      case 'exec': return this.exec(input)
      case 'write_file': return this.writeFile(input)
      case 'read_file': return this.readFile(input)
      case 'copy_repo': return this.copyRepo(input)
      case 'extend': return this.extend(input)
      case 'remove': return this.remove(input)
      default: throw new SandboxError(`Unknown sandbox action ${action}: list, create, exec, write_file, read_file, copy_repo, extend or remove`)
    }
  }
}

async function pack(cwd: string, entries: string[]): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of tarCreate({ cwd, portable: true }, entries) as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/** The tar's first entry: its type and, for a regular file, its bytes. */
function firstEntry(tar: Buffer): Promise<{ type: string; data: Buffer | null }> {
  return new Promise((resolve, reject) => {
    let first: { type: string; data: Buffer | null } | null = null
    const parser = new TarParser({
      onReadEntry: (entry: any) => {
        if (first) { entry.resume(); return }
        first = { type: String(entry.type), data: null }
        if (entry.type !== 'File') { entry.resume(); return }
        const chunks: Buffer[] = []
        const mine = first
        entry.on('data', (chunk: Buffer) => chunks.push(chunk))
        entry.on('end', () => { mine.data = Buffer.concat(chunks) })
      },
    } as any)
    parser.on('end', () => resolve(first || { type: 'none', data: null }))
    parser.on('error', reject)
    parser.end(tar)
  })
}

