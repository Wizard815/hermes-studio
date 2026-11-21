import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { getWebUiHome } from '../../../studio/public/config'
import { config } from '../../../studio/public/config'
import { appendEgress, forgetEgressLog, readEgress, verifyEgressChain, type EgressEntry } from './egress-log'
import { scanForLeaks, type LeakReport } from './leaks'
import { judgeProbe, normalizeProbe, overallState, PROBE_SCRIPT, type SelfCheckExpectations, type SelfCheckResult } from './probe'

/**
 * Clean rooms: a chat whose coding agent runs inside its own container.
 * Inside, the agent may do anything (it never asks); it sees only the chat's
 * folder, the agent's own program (read-only) and its Studio config. There is
 * no network except a tunnel to Studio (its model proxy and tools) and an
 * allowlist proxy for package registries and model APIs. Nothing from the
 * host's environment, home folder or Docker socket goes in.
 *
 * Each chat's container is labeled with the chat (studio.cleanroom.session),
 * so the chat's own containers are told apart from everything else.
 */

const run = promisify(execFile)

export type CleanRoomNetwork = 'studio' | 'allowlist' | 'internet'

export interface CleanRoomSettings {
  /** Container image (needs node for Studio's tunnel; most agent CLIs need node too). */
  image: string
  /** studio: only Studio; allowlist: Studio plus the hosts below; internet: anything. */
  network: CleanRoomNetwork
  allowHosts: string[]
  cpus: number
  memory: string
  pids: number
  /** The container's own files are read-only; /tmp and /var/tmp are small tmpfs folders. */
  readOnlyRoot: boolean
  /** Drop every Linux capability (`--cap-drop ALL`), then add back only `capAdd`. */
  dropAllCaps: boolean
  capAdd: string[]
  /**
   * Who the agent runs as. auto: Studio's own user, or (when Studio runs as
   * root) the owner of the chat's folder; room: a user id of its own per
   * room (the folder must be writable for it); root: root (no capabilities).
   */
  user: CleanRoomUser
  /** Run the self-check probe when a room starts. */
  selfCheck: boolean
  /** Warn about likely secrets in the chat's folder before mounting it. */
  leakCheck: boolean
  /** Log every outside connection attempt (JSON lines). */
  egressLog: boolean
  /** Link each egress line to the one before by hash (tamper evidence). */
  auditChain: boolean
  /** Let agents use their own web tools (Claude Code WebSearch/WebFetch). Off: denied by managed settings. */
  allowWebTools: boolean
}

export type CleanRoomUser = 'auto' | 'room' | 'root'

/** Capabilities `capAdd` may give back (none is needed by the supported agents). */
export const CLEANROOM_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'NET_BIND_SERVICE', 'SYS_CHROOT', 'AUDIT_WRITE', 'SETFCAP', 'MKNOD', 'NET_RAW']

export const DEFAULT_CLEANROOM_SETTINGS: CleanRoomSettings = {
  image: 'node:24-bookworm-slim',
  network: 'allowlist',
  allowHosts: [
    // Model APIs (agents on their own logins)
    'api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'generativelanguage.googleapis.com', 'api.x.ai',
    'api.deepseek.com', 'api.moonshot.ai', 'openrouter.ai', 'dashscope.aliyuncs.com',
    // Package registries
    'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'deb.debian.org', 'security.debian.org',
    'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
  ],
  cpus: 2,
  memory: '4g',
  pids: 1024,
  readOnlyRoot: true,
  dropAllCaps: true,
  capAdd: [],
  user: 'auto',
  selfCheck: true,
  leakCheck: true,
  egressLog: true,
  auditChain: true,
  allowWebTools: false,
}

/** The port the in-container proxy listens on. */
export const CLEANROOM_PROXY_PORT = 3128
const SOCKET_DIR_IN_CONTAINER = '/cleanroom'

function home(): string {
  return join(getWebUiHome(), 'coding-agent', 'cleanroom')
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

export function readCleanRoomSettings(): CleanRoomSettings {
  const raw = readJson<Partial<CleanRoomSettings>>(join(home(), 'settings.json'), {})
  return sanitizeCleanRoomSettings(raw)
}

export function sanitizeCleanRoomSettings(raw: Partial<CleanRoomSettings>, base = DEFAULT_CLEANROOM_SETTINGS): CleanRoomSettings {
  const next = { ...base, allowHosts: [...base.allowHosts], capAdd: [...(base.capAdd || [])] }
  if (typeof raw.image === 'string' && /^[\w./:@-]{1,200}$/.test(raw.image.trim())) next.image = raw.image.trim()
  if (raw.network === 'studio' || raw.network === 'allowlist' || raw.network === 'internet') next.network = raw.network
  if (Array.isArray(raw.allowHosts)) next.allowHosts = raw.allowHosts.map(String).map(host => host.trim().toLowerCase()).filter(host => /^[a-z0-9.-]{1,253}$/.test(host)).slice(0, 200)
  if (typeof raw.cpus === 'number' && raw.cpus > 0 && raw.cpus <= 64) next.cpus = raw.cpus
  if (typeof raw.memory === 'string' && /^\d{1,6}[kmg]$/i.test(raw.memory)) next.memory = raw.memory.toLowerCase()
  if (typeof raw.pids === 'number' && raw.pids >= 64 && raw.pids <= 100000) next.pids = Math.round(raw.pids)
  for (const key of ['readOnlyRoot', 'dropAllCaps', 'selfCheck', 'leakCheck', 'egressLog', 'auditChain', 'allowWebTools'] as const) {
    if (typeof raw[key] === 'boolean') next[key] = raw[key]
  }
  if (Array.isArray(raw.capAdd)) next.capAdd = [...new Set(raw.capAdd.map(cap => String(cap).trim().toUpperCase().replace(/^CAP_/, '')).filter(cap => CLEANROOM_CAPABILITIES.includes(cap)))]
  if (raw.user === 'auto' || raw.user === 'room' || raw.user === 'root') next.user = raw.user
  return next
}

export function writeCleanRoomSettings(input: unknown): CleanRoomSettings {
  const next = sanitizeCleanRoomSettings((input && typeof input === 'object' ? input : {}) as Partial<CleanRoomSettings>, readCleanRoomSettings())
  writeJson(join(home(), 'settings.json'), next)
  return next
}

interface CleanRoomRecord { createdAt: number }

function chatsFile() { return join(home(), 'chats.json') }

export function isCleanRoom(sessionId: string): boolean {
  return !!readJson<Record<string, CleanRoomRecord>>(chatsFile(), {})[sessionId]
}

export function markCleanRoom(sessionId: string): void {
  const chats = readJson<Record<string, CleanRoomRecord>>(chatsFile(), {})
  if (chats[sessionId]) return
  chats[sessionId] = { createdAt: Date.now() }
  writeJson(chatsFile(), chats)
}

export function containerName(sessionId: string): string {
  return `studio-cleanroom-${sessionId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 60)}`
}

/** Is a host allowed through the clean room's proxy? (exact host or a subdomain of one listed) */
export function hostAllowed(host: string, settings: Pick<CleanRoomSettings, 'network' | 'allowHosts'>): boolean {
  if (settings.network === 'internet') return true
  if (settings.network === 'studio') return false
  const name = host.toLowerCase().replace(/\.$/, '')
  return settings.allowHosts.some(allowed => name === allowed || name.endsWith(`.${allowed}`))
}

/**
 * Studio may itself run in a container: Docker then needs host paths for
 * bind mounts. Studio's own mounts say where its folders are on the host.
 */
let mountMap: Array<{ inside: string; host: string }> | null = null
async function hostMounts(): Promise<Array<{ inside: string; host: string }>> {
  if (mountMap) return mountMap
  mountMap = []
  if (!existsSync('/.dockerenv')) return mountMap
  try {
    const { stdout } = await run('docker', ['inspect', '--format', '{{json .Mounts}}', hostname()], { timeout: 15000 })
    const mounts = JSON.parse(stdout) as Array<{ Source: string; Destination: string }>
    mountMap = mounts.map(mount => ({ inside: mount.Destination, host: mount.Source })).sort((a, b) => b.inside.length - a.inside.length)
  } catch { /* not a Docker container Studio can inspect: paths are host paths */ }
  return mountMap
}

export async function hostPath(path: string): Promise<string> {
  const mounts = await hostMounts()
  if (!existsSync('/.dockerenv') || !mounts.length) return path
  const mount = mounts.find(entry => path === entry.inside || path.startsWith(`${entry.inside}/`))
  if (!mount) throw Object.assign(new Error(`Clean rooms need ${path} on a mounted volume (Docker cannot see Studio's own files)`), { status: 400 })
  return mount.host + path.slice(mount.inside.length)
}

/** The tunnel inside the container: Studio's port and the proxy, over the mounted sockets. */
const FORWARDER = `// Studio clean room tunnel: the container has no network of its own.
import { createServer, createConnection } from 'node:net'
const pipes = [[Number(process.env.STUDIO_PORT), '${SOCKET_DIR_IN_CONTAINER}/studio.sock'], [${CLEANROOM_PROXY_PORT}, '${SOCKET_DIR_IN_CONTAINER}/egress.sock']]
for (const [port, path] of pipes) {
  createServer(client => {
    const upstream = createConnection(path)
    client.pipe(upstream).pipe(client)
    const close = () => { client.destroy(); upstream.destroy() }
    client.on('error', close); upstream.on('error', close)
  }).listen(port, '127.0.0.1')
}
setInterval(() => {}, 1 << 30)
`

interface RoomSockets { studio: Server; egress: Server; ready: Promise<void> }
const sockets = new Map<string, RoomSockets>()

/** Unix socket paths: 108 bytes on Linux, 104 on macOS, with room for the NUL. */
const MAX_SOCKET_PATH = 103

/** Short on purpose: Unix socket paths are limited to about 100 characters. */
function socketDir(sessionId: string): string {
  return join(home(), 'r', createHash('sha1').update(sessionId).digest('hex').slice(0, 12))
}

/**
 * The room's home folder (`/root` inside): the agent's sessions, transcripts
 * and any login made inside outlive the container, and Studio reads the
 * transcripts from here (herdr's transcript mirror, the agent's session id).
 */
export function cleanRoomHome(sessionId: string): string {
  return join(home(), 'homes', createHash('sha1').update(sessionId).digest('hex').slice(0, 12))
}

/** Every clean room's home folder. */
export function cleanRoomHomes(): string[] {
  const dir = join(home(), 'homes')
  try { return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name)) } catch { return [] }
}

/** Host side of the tunnel: Studio's port, and a proxy that only lets allowed hosts out. */
function listenSockets(sessionId: string): void {
  if (sockets.has(sessionId)) return
  const dir = socketDir(sessionId)
  // Longer paths are cut short by the OS, and both sockets would then bind the same name.
  if (Buffer.byteLength(join(dir, 'studio.sock')) > MAX_SOCKET_PATH) {
    throw Object.assign(new Error(`The clean room's socket folder is too long for a Unix socket (${dir}): use a shorter HERMES_WEB_UI_HOME`), { status: 500 })
  }
  mkdirSync(dir, { recursive: true })
  for (const name of ['studio.sock', 'egress.sock']) rmSync(join(dir, name), { force: true })
  // A socket that cannot listen must not take Studio down; the room just has no tunnel.
  const failed = (name: string) => (error: Error) => {
    process.stderr.write(`[cleanroom] ${name} socket for ${sessionId} failed: ${error.message}\n`)
    if (sockets.get(sessionId)?.studio === studio) sockets.delete(sessionId)
  }
  const studio = createServer(client => handleStudioTunnel(client))
  studio.on('error', failed('studio'))
  studio.listen(join(dir, 'studio.sock'))
  const egress = createServer(client => handleProxy(client, sessionId))
  egress.on('error', failed('egress'))
  egress.listen(join(dir, 'egress.sock'))
  // The agent may run as a user of its own: it needs write access to the sockets to connect.
  const ready = Promise.all([studio, egress].map(server => new Promise<void>(done => {
    const open = () => { try { chmodSync(String(server.address()), 0o666) } catch { /* the room has no tunnel */ } done() }
    if (server.listening) open(); else { server.once('listening', open); server.once('error', () => done()) }
  }))).then(() => undefined)
  sockets.set(sessionId, { studio, egress, ready })
}

/** The only Studio paths a clean room may reach: its agent's model proxies (not Studio's API or tools). */
export const CLEANROOM_STUDIO_PATHS = /^\/api\/(codex-proxy|claude-code-proxy)\//
/** Studio's model gateway, inference and model listing only (run-scoped tokens; see model-gateway-adapters). */
const CLEANROOM_GATEWAY_PATHS = /^\/api\/ekko-studio\/models\/(v1\/(responses|chat\/completions|messages(\/count_tokens)?|models)|v1beta\/models\/[^/]+:(streamGenerateContent|generateContent))\/?$/

export function studioPathAllowed(target: string): boolean {
  if (target.includes('..') || target.includes('%2e') || target.includes('%2E')) return false
  const path = target.split('?')[0]
  return CLEANROOM_STUDIO_PATHS.test(path) || CLEANROOM_GATEWAY_PATHS.test(path)
}

/** One HTTP request per connection to Studio, and only to the model proxies. */
function handleStudioTunnel(client: Socket) {
  let head = Buffer.alloc(0)
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) { if (head.length > 64 * 1024) client.destroy(); return }
    client.off('data', onData)
    const lines = head.subarray(0, end).toString('latin1').split('\r\n')
    const [, path = ''] = lines[0].split(' ')
    if (!studioPathAllowed(path)) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nA clean room can only reach its model through Studio\n')
      return
    }
    const headers = lines.slice(1).filter(line => !/^connection:/i.test(line))
    const upstream = createConnection({ host: '127.0.0.1', port: config.port })
    upstream.write(Buffer.concat([Buffer.from([lines[0], ...headers, 'Connection: close', '', ''].join('\r\n'), 'latin1'), head.subarray(end + 4)]))
    client.pipe(upstream).pipe(client)
    const close = () => { client.destroy(); upstream.destroy() }
    client.on('error', close); upstream.on('error', close)
  }
  client.on('data', onData)
  client.on('error', () => client.destroy())
}

/** An HTTP proxy (CONNECT for HTTPS, absolute URLs for HTTP) limited to allowed hosts. */
function handleProxy(client: Socket, sessionId = '') {
  let head = Buffer.alloc(0)
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) { if (head.length > 64 * 1024) client.destroy(); return }
    client.off('data', onData)
    const request = head.subarray(0, end).toString('latin1')
    const rest = head.subarray(end + 4)
    const [method = '', target = ''] = request.split('\r\n')[0].split(' ')
    let host = ''
    let port = 443
    if (method === 'CONNECT') {
      const at = target.lastIndexOf(':')
      host = at > 0 ? target.slice(0, at) : target
      port = at > 0 ? Number(target.slice(at + 1)) : 443
    } else {
      try { const url = new URL(target); host = url.hostname; port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80) } catch { host = '' }
    }
    const settings = readCleanRoomSettings()
    if (!host || !hostAllowed(host, settings)) {
      logEgress(sessionId, settings, { host: host || '(none)', port, allowed: false, reason: host ? `not allowed (${settings.network})` : 'bad request' })
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nThe clean room does not allow ${host || 'this request'}\n`)
      return
    }
    void openUpstream(host, port).then(upstream => {
      logEgress(sessionId, settings, { host, port, allowed: true })
      if (method === 'CONNECT') client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      else upstream.write(Buffer.concat([head.subarray(0, end + 4)]))
      if (rest.length && method === 'CONNECT') upstream.write(rest)
      else if (rest.length) upstream.write(rest)
      client.pipe(upstream).pipe(client)
      const close = () => { client.destroy(); upstream.destroy() }
      client.on('error', close); upstream.on('error', close)
    }).catch((error: Error) => {
      logEgress(sessionId, settings, { host, port, allowed: true, reason: `unreachable: ${String(error?.message || error).slice(0, 120)}` })
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    })
  }
  client.on('data', onData)
  client.on('error', () => client.destroy())
}

/** Reach a host from Studio, through Studio's own proxy when it has one. */
function openUpstream(host: string, port: number): Promise<Socket> {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || ''
  return new Promise((resolveSocket, reject) => {
    if (!proxy) {
      const socket = createConnection({ host, port }, () => resolveSocket(socket))
      socket.once('error', reject)
      return
    }
    const url = new URL(proxy)
    const socket = createConnection({ host: url.hostname, port: Number(url.port) || 80 }, () => {
      const auth = url.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}\r\n` : ''
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`)
    })
    let reply = ''
    const onReply = (chunk: Buffer) => {
      reply += chunk.toString('latin1')
      if (!reply.includes('\r\n\r\n')) return
      socket.off('data', onReply)
      if (/^HTTP\/1\.[01] 200/.test(reply)) resolveSocket(socket)
      else { socket.destroy(); reject(new Error(reply.split('\r\n')[0])) }
    }
    socket.on('data', onReply)
    socket.once('error', reject)
  })
}

/** What a clean room shares with the chat's agent (all at the same paths as in Studio). */
export interface CleanRoomMounts {
  workspace: string
  /** The agent's Studio config folders it writes in (its own home, e.g. CODEX_HOME). */
  configs?: string[]
  /** The agent's Studio config folders it only reads (prompt and MCP files Studio writes). */
  readOnlyConfigs?: string[]
  /** The agent program's install folder (read-only). */
  program?: string
}

async function dockerJson(args: string[]): Promise<any> {
  const { stdout } = await run('docker', args, { timeout: 30000 })
  return JSON.parse(stdout)
}

function roomKey(sessionId: string): string {
  return createHash('sha1').update(sessionId).digest('hex').slice(0, 12)
}

/** The room's egress log (JSON lines, see egress-log.ts). */
export function egressLogFile(sessionId: string): string {
  return join(home(), 'logs', `${roomKey(sessionId)}.jsonl`)
}

function logEgress(sessionId: string, settings: CleanRoomSettings, entry: Omit<EgressEntry, 'time'>): void {
  if (!sessionId || !settings.egressLog) return
  try { appendEgress(egressLogFile(sessionId), entry, { chain: settings.auditChain }) } catch (error) {
    process.stderr.write(`[cleanroom] egress log for ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/** What Studio keeps about a room: its last self-check and leak check (no secrets, no env values). */
export interface CleanRoomState {
  selfCheck?: SelfCheckResult
  leaks?: LeakReport
  /** What the last self-check expected, so it can run again (env names only). */
  probe?: { expect: SelfCheckExpectations; envNames: string[] }
}

function stateFile(sessionId: string): string {
  return join(home(), 'checks', `${roomKey(sessionId)}.json`)
}

export function readCleanRoomState(sessionId: string): CleanRoomState {
  return readJson<CleanRoomState>(stateFile(sessionId), {})
}

function updateCleanRoomState(sessionId: string, patch: Partial<CleanRoomState>): CleanRoomState {
  const next = { ...readCleanRoomState(sessionId), ...patch }
  writeJson(stateFile(sessionId), next)
  return next
}

/** A user id of the room's own (20000-59999), the same for the chat every time. */
export function roomUid(sessionId: string): number {
  return 20000 + (parseInt(roomKey(sessionId).slice(0, 8), 16) % 40000)
}

/**
 * Who the agent runs as. Without a user namespace, a uid inside is the same
 * uid on the host: the chat's folder must be writable for it. auto keeps the
 * files the agent makes owned like the folder.
 */
export function resolveRoomUser(
  setting: CleanRoomUser,
  sessionId: string,
  folder: { uid: number; gid: number },
  studio: { uid: number; gid: number },
): { uid: number; gid: number } {
  if (setting === 'root') return { uid: 0, gid: 0 }
  if (setting === 'room' && studio.uid === 0) return { uid: roomUid(sessionId), gid: roomUid(sessionId) }
  if (studio.uid !== 0) return studio
  return folder
}

/** /etc/passwd and /etc/group for a room user the image does not know (programs look up their user). */
export function roomAccountFiles(uid: number, gid: number): { passwd: string; group: string } {
  return {
    passwd: `root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\nagent:x:${uid}:${gid}:Clean room agent:/root:/bin/sh\n`,
    group: `root:x:0:\nnogroup:x:65534:\nagent:x:${gid}:\n`,
  }
}

/**
 * Claude Code's managed settings (`/etc/claude-code/managed-settings.json`):
 * they win over every other settings file and over "skip permissions".
 */
export function managedClaudeSettings(allowWebTools: boolean): Record<string, unknown> {
  return allowWebTools ? {} : { permissions: { deny: ['WebSearch', 'WebFetch'] } }
}

/** Give a folder Studio made to the room's user (Studio runs as root; links are not followed). */
function chownTree(path: string, uid: number, gid: number, budget = { left: 200000 }): void {
  let stat
  try { stat = lstatSync(path) } catch { return }
  if (budget.left-- <= 0) return
  if (stat.uid !== uid || stat.gid !== gid) try { lchownSync(path, uid, gid) } catch { /* leave it */ }
  if (!stat.isDirectory()) return
  let names: string[] = []
  try { names = readdirSync(path) } catch { return }
  for (const name of names) chownTree(join(path, name), uid, gid, budget)
}

/** The `docker run` hardening flags for a room's settings. */
export function hardeningArgs(settings: CleanRoomSettings, user: { uid: number; gid: number }): string[] {
  return [
    '--security-opt', 'no-new-privileges',
    ...(settings.dropAllCaps
      ? ['--cap-drop', 'ALL', ...settings.capAdd.flatMap(cap => ['--cap-add', cap])]
      : ['--cap-drop', 'NET_RAW', '--cap-drop', 'SYS_CHROOT', '--cap-drop', 'MKNOD', '--cap-drop', 'AUDIT_WRITE']),
    ...(settings.readOnlyRoot
      ? ['--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=1g,mode=1777', '--tmpfs', '/var/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--tmpfs', '/run:rw,nosuid,nodev,size=16m,mode=755']
      : []),
    '--user', `${user.uid}:${user.gid}`,
  ]
}

const pendingChecks = new Map<string, Promise<SelfCheckResult>>()

/** What a room was made with, by chat: a reused agent run must not outlive a change of walls. */
const roomSettings = new Map<string, string>()
function settingsKey(settings: CleanRoomSettings): string {
  return JSON.stringify([settings.image, settings.network, settings.readOnlyRoot, settings.dropAllCaps, settings.capAdd, settings.user, settings.allowWebTools, settings.cpus, settings.memory, settings.pids])
}

/**
 * The chat's agent run must start again (and so pass through ensureCleanRoom):
 * its container was thrown away, or the clean-room settings changed since.
 */
export function cleanRoomNeedsRestart(sessionId: string): boolean {
  if (!isCleanRoom(sessionId)) return false
  const made = roomSettings.get(sessionId)
  return !made || made !== settingsKey(readCleanRoomSettings())
}

/** Start (or reuse) the chat's container. `env` is the agent's launch environment (only its names reach the self-check). */
export async function ensureCleanRoom(sessionId: string, mounts: CleanRoomMounts, options: { env?: Record<string, string | undefined> } = {}): Promise<string> {
  const settings = readCleanRoomSettings()
  const name = containerName(sessionId)
  listenSockets(sessionId)
  const dir = socketDir(sessionId)
  writeFileSync(join(dir, 'tunnel.mjs'), FORWARDER)
  writeFileSync(join(dir, 'probe.mjs'), PROBE_SCRIPT)
  await sockets.get(sessionId)?.ready
  const roomHome = cleanRoomHome(sessionId)
  const homeIsNew = !existsSync(roomHome) || !readdirSync(roomHome).length
  mkdirSync(roomHome, { recursive: true })
  const studioUser = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }
  let folder = studioUser
  try { const stat = statSync(mounts.workspace); folder = { uid: stat.uid, gid: stat.gid } } catch { /* Docker makes it */ }
  const user = resolveRoomUser(settings.user, sessionId, folder, studioUser)
  const readOnlyConfigs = (mounts.readOnlyConfigs || []).filter(path => !(mounts.configs || []).includes(path))
  const hardening = [
    `u=${user.uid}:${user.gid}`, `rofs=${settings.readOnlyRoot ? 1 : 0}`,
    `caps=${settings.dropAllCaps ? ['none', ...settings.capAdd].join('+') : 'default'}`, `web=${settings.allowWebTools ? 1 : 0}`,
  ].join(',')
  const paths = [mounts.workspace, ...(mounts.configs || []), ...readOnlyConfigs.map(path => `ro:${path}`), mounts.program, `home:${roomHome}`, `walls:${hardening}`].filter(Boolean).join('|')
  let existing: any = null
  try { existing = (await dockerJson(['inspect', name]))[0] } catch { existing = null }
  if (process.env.STUDIO_CLEANROOM_DEBUG) process.stderr.write(`[cleanroom] ${name}: ${existing ? (existing.Config?.Labels?.['studio.cleanroom.paths'] === paths ? 'reuse' : 'remake') : 'make'} ${paths}\n`)
  if (existing && existing.Config?.Labels?.['studio.cleanroom.paths'] !== paths) {
    // A room from before its home folder: keep what the agent kept in /root (its sessions).
    if (homeIsNew) await run('docker', ['cp', `${name}:/root/.`, roomHome], { timeout: 120000 }).catch(() => undefined)
    // The chat's folder, agent or walls changed: make the room again (its folder stays on the host).
    await run('docker', ['rm', '-f', name], { timeout: 30000 }).catch(() => undefined)
    existing = null
  }
  // Its config folders too, every turn (Studio writes its prompt files again, mode 600):
  // the agent can read them, and the read-only mount keeps it from changing them.
  if (studioUser.uid === 0 && user.uid !== 0) {
    for (const path of [...(mounts.configs || []), ...readOnlyConfigs]) chownTree(path, user.uid, user.gid)
  }
  if (existing) {
    if (!existing.State?.Running) await run('docker', ['start', name], { timeout: 30000 })
    roomSettings.set(sessionId, settingsKey(settings))
    return name
  }
  // Leak check before the chat's folder goes in: warn, do not block.
  if (settings.leakCheck) {
    try { updateCleanRoomState(sessionId, { leaks: scanForLeaks(mounts.workspace) }) } catch { /* the room still starts */ }
  } else updateCleanRoomState(sessionId, { leaks: undefined })
  // The room's home belongs to the user the agent runs as.
  if (studioUser.uid === 0 && user.uid !== 0) chownTree(roomHome, user.uid, user.gid)
  const files: string[] = []
  if (user.uid !== 0) {
    const account = roomAccountFiles(user.uid, user.gid)
    writeFileSync(join(dir, 'passwd'), account.passwd)
    writeFileSync(join(dir, 'group'), account.group)
    files.push('-v', `${await hostPath(join(dir, 'passwd'))}:/etc/passwd:ro`, '-v', `${await hostPath(join(dir, 'group'))}:/etc/group:ro`)
  }
  if (!settings.allowWebTools) {
    writeFileSync(join(dir, 'managed-settings.json'), `${JSON.stringify(managedClaudeSettings(false), null, 2)}\n`)
    files.push('-v', `${await hostPath(join(dir, 'managed-settings.json'))}:/etc/claude-code/managed-settings.json:ro`)
  }
  const volume = (path: string, mode: 'rw' | 'ro') => ['-v', `${path}:${mode}`]
  const args = [
    'run', '-d', '--name', name,
    '--label', 'studio.cleanroom=1',
    '--label', `studio.cleanroom.session=${sessionId}`,
    '--label', `studio.cleanroom.paths=${paths}`,
    '--hostname', 'cleanroom',
    '--network', 'none',
    ...hardeningArgs(settings, user),
    '--pids-limit', String(settings.pids),
    '--memory', settings.memory,
    '--cpus', String(settings.cpus),
    '-e', 'HOME=/root',
    '-e', `STUDIO_PORT=${config.port}`,
    ...volume(`${await hostPath(mounts.workspace)}:${mounts.workspace}`, 'rw'),
    ...(await Promise.all((mounts.configs || []).map(async path => volume(`${await hostPath(path)}:${path}`, 'rw')))).flat(),
    ...(await Promise.all(readOnlyConfigs.map(async path => volume(`${await hostPath(path)}:${path}`, 'ro')))).flat(),
    ...(mounts.program ? volume(`${await hostPath(mounts.program)}:${mounts.program}`, 'ro') : []),
    // The tunnel's sockets and scripts: the agent connects to the sockets but cannot change the folder.
    ...volume(`${await hostPath(dir)}:${SOCKET_DIR_IN_CONTAINER}`, 'ro'),
    ...volume(`${await hostPath(roomHome)}:/root`, 'rw'),
    ...files,
    '-w', mounts.workspace,
    settings.image,
    'node', `${SOCKET_DIR_IN_CONTAINER}/tunnel.mjs`,
  ]
  await run('docker', args, { timeout: 120000 })
  roomSettings.set(sessionId, settingsKey(settings))
  const expect: SelfCheckExpectations = {
    network: settings.network,
    readOnlyRoot: settings.readOnlyRoot,
    dropAllCaps: settings.dropAllCaps,
    capAdd: settings.capAdd,
    uid: user.uid,
    workspace: mounts.workspace,
    readOnlyPaths: [mounts.program, ...readOnlyConfigs].filter((path): path is string => !!path),
    blockedHost: 'example.com',
    allowedHost: settings.network === 'studio' ? undefined : settings.allowHosts.includes('registry.npmjs.org') ? 'registry.npmjs.org' : settings.allowHosts[0],
  }
  const envNames = Object.keys(cleanRoomEnv(options.env || {}))
  updateCleanRoomState(sessionId, { probe: { expect, envNames }, selfCheck: undefined })
  // The check runs beside the agent's first turn, it does not hold it up.
  if (settings.selfCheck) void runCleanRoomSelfCheck(sessionId).catch(() => undefined)
  return name
}

/** Run the self-check probe in the chat's running room and keep the result. */
export function runCleanRoomSelfCheck(sessionId: string): Promise<SelfCheckResult> {
  const pending = pendingChecks.get(sessionId)
  if (pending) return pending
  const task = (async (): Promise<SelfCheckResult> => {
    const container = containerName(sessionId)
    const state = readCleanRoomState(sessionId)
    if (!state.probe) throw Object.assign(new Error('The room has not started yet: it runs its check when the agent next starts'), { status: 409 })
    const { expect, envNames } = state.probe
    const at = new Date().toISOString()
    // After a Studio restart the room's tunnel waits for its next turn: open it for the check.
    listenSockets(sessionId)
    await sockets.get(sessionId)?.ready
    let result: SelfCheckResult
    try {
      const probeConfig = JSON.stringify({ studioPort: config.port, proxyPort: CLEANROOM_PROXY_PORT, blockedHost: expect.blockedHost, allowedHost: expect.allowedHost })
      // The agent's variable names with empty values: the probe reports names only.
      // PATH and HOME keep the container's own values (an empty PATH would not find node).
      const env = envNames.filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key !== 'PATH' && key !== 'HOME').flatMap(key => ['-e', `${key}=`])
      const { stdout } = await run('docker', ['exec', '-i', ...env, '-e', `STUDIO_PROBE=${probeConfig}`, container, 'node', `${SOCKET_DIR_IN_CONTAINER}/probe.mjs`], { timeout: 90000 })
      const probe = normalizeProbe(JSON.parse(stdout.trim().split('\n').pop() || '{}'))
      const checks = judgeProbe(probe, expect)
      result = { at, container, state: overallState(checks), checks, probe }
    } catch (error) {
      // What docker or the probe said, not the command line (it lists every variable name).
      const said = String((error as { stderr?: string })?.stderr || '').trim() || (error instanceof Error ? error.message : String(error))
      result = { at, container, state: 'fail', checks: [], error: said.slice(-500) }
    }
    updateCleanRoomState(sessionId, { selfCheck: result })
    return result
  })()
  pendingChecks.set(sessionId, task)
  return task.finally(() => pendingChecks.delete(sessionId))
}

/** A room's egress log, newest last, and whether its hash chain holds. */
export function readCleanRoomEgress(sessionId: string, limit = 200): { entries: EgressEntry[]; chain: ReturnType<typeof verifyEgressChain> } {
  const file = egressLogFile(sessionId)
  return { entries: readEgress(file, limit), chain: verifyEgressChain(file) }
}

/** Remove the chat's container; it stays a clean room and gets a fresh container next turn. */
export async function removeCleanRoomContainer(sessionId: string): Promise<void> {
  await run('docker', ['rm', '-f', containerName(sessionId)], { timeout: 30000 }).catch(() => undefined)
  roomSettings.delete(sessionId)
  const open = sockets.get(sessionId)
  if (open) { open.studio.close(); open.egress.close(); sockets.delete(sessionId) }
}

/** The chat is gone: remove its container and forget it. */
export async function removeCleanRoom(sessionId: string): Promise<void> {
  await removeCleanRoomContainer(sessionId)
  rmSync(socketDir(sessionId), { recursive: true, force: true })
  rmSync(cleanRoomHome(sessionId), { recursive: true, force: true })
  rmSync(stateFile(sessionId), { force: true })
  for (const file of [egressLogFile(sessionId), `${egressLogFile(sessionId)}.1`]) { rmSync(file, { force: true }); forgetEgressLog(file) }
  const chats = readJson<Record<string, CleanRoomRecord>>(chatsFile(), {})
  if (chats[sessionId]) { delete chats[sessionId]; writeJson(chatsFile(), chats) }
}

/** A launch command that means "run this inside the chat's clean room". */
const PREFIX = 'studio-cleanroom://'

export function cleanRoomCommand(container: string, command: string): string {
  return `${PREFIX}${container}/${encodeURIComponent(command)}`
}

export function parseCleanRoomCommand(command: string): { container: string; command: string } | null {
  if (!command.startsWith(PREFIX)) return null
  const rest = command.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  return { container: rest.slice(0, slash), command: decodeURIComponent(rest.slice(slash + 1)) }
}

/** Environment the agent gets inside: what Studio set for it, never the host's own. */
export function cleanRoomEnv(env: NodeJS.ProcessEnv, host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (host[key] === value) continue // inherited from Studio's own environment
    if (/^(PATH|HOME|PWD|SHLVL|_|HOSTNAME|TERM_PROGRAM.*)$/.test(key)) continue
    out[key] = value
  }
  const proxy = `http://127.0.0.1:${CLEANROOM_PROXY_PORT}`
  return {
    ...out,
    HOME: '/root',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    STUDIO_CLEAN_ROOM: '1',
  }
}

/**
 * `docker exec` for a command in the clean room. The process gets its own
 * session (setsid) and records its group, so stopping the run stops it inside.
 */
export function cleanRoomExec(container: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, options: { tty?: boolean; runId?: string } = {}): { command: string; args: string[] } {
  const inside = cleanRoomEnv(env)
  const marker = `/tmp/studio-run-${(options.runId || String(Date.now())).replace(/[^\w-]/g, '')}.pid`
  return {
    command: 'docker',
    args: [
      'exec', '-i', ...(options.tty ? ['-t'] : []),
      '-w', resolve(cwd),
      ...Object.entries(inside).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      container,
      'setsid', '-w', 'sh', '-c', `echo $$ > ${marker}; exec "$@"`, 'studio-run', command, ...args,
    ],
  }
}

/**
 * The docker client under the agent's own name, for a clean-room pane in a
 * terminal multiplexer (herdr): herdr knows which agent runs in a pane by the
 * pane's foreground process, which for a clean room is the docker client. A
 * link named after the agent (`<web ui home>/coding-agent/cleanroom/bin/claude`
 * → docker) lets herdr see the agent, follow its status from the screen and
 * resume it after a restart. Plain `docker` when no link can be made.
 */
export function cleanRoomTerminalDocker(agentName: string, searchPath = String(process.env.PATH || '')): string {
  if (process.platform === 'win32' || !/^[a-z][a-z0-9_-]{0,31}$/.test(agentName)) return 'docker'
  const docker = searchPath.split(delimiter).filter(Boolean).map(dir => join(dir, 'docker')).find(candidate => existsSync(candidate))
  if (!docker) return 'docker'
  try {
    const dir = join(home(), 'bin')
    mkdirSync(dir, { recursive: true })
    const link = join(dir, agentName)
    let current = ''
    try { current = readlinkSync(link) } catch { /* no link yet */ }
    if (current !== docker) {
      rmSync(link, { force: true })
      symlinkSync(docker, link)
    }
    return link
  } catch {
    return 'docker'
  }
}

export function cleanRoomStop(container: string, runId: string): void {
  const marker = `/tmp/studio-run-${runId.replace(/[^\w-]/g, '')}.pid`
  execFile('docker', ['exec', container, 'sh', '-c', `[ -f ${marker} ] && kill -TERM -"$(cat ${marker})" 2>/dev/null; rm -f ${marker}`], { timeout: 15000 }, () => undefined)
}

/** Spawn a clean-room launch command (see cleanRoomCommand) inside its container; null for any other command. */
export function spawnInCleanRoom(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; pipeStdin?: boolean }): ChildProcess | null {
  const room = parseCleanRoomCommand(command)
  if (!room) return null
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const exec = cleanRoomExec(room.container, room.command, args, options.cwd, options.env, { runId })
  if (process.env.STUDIO_CLEANROOM_DEBUG) process.stderr.write(`[cleanroom] ${JSON.stringify(exec.args)}\n`)
  const child = spawn(exec.command, exec.args, {
    cwd: options.cwd,
    env: process.env,
    stdio: options.pipeStdin === false ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  // Stopping the docker client does not stop the process inside: stop it there too.
  child.once('exit', () => cleanRoomStop(room.container, runId))
  return child
}

/**
 * The agent's Studio config folders a launch points at (prompt files, config
 * homes), each cut to its agent folder (coding-agent/model/<profile>/<provider>/<agent>,
 * in Studio's tree or a provider account's), or to the run's folder in it (…/runs/<id>).
 */
export function studioConfigDirs(args: readonly string[], env: Record<string, string | undefined> = {}): string[] {
  const home = getWebUiHome()
  // Studio's own tree, or a provider account's (providers/users/<id>/coding-agent/model/...).
  // A run's own folder (runs/<id>) when the value is in one: other chats' runs stay outside.
  const root = /^(?:providers\/users\/[^/]+\/)?coding-agent\/model\/([^/]+\/[^/]+\/[^/]+(?:\/runs\/[^/]+(?=\/))?)(?:\/|$)/
  const dirs = new Set<string>()
  for (const value of [...args, ...Object.values(env)]) {
    if (typeof value !== 'string' || !value.startsWith(`${home}/`)) continue
    const relative = value.slice(home.length + 1)
    const match = root.exec(relative)
    if (!match || match[1].split('/').some(part => part === '..' || part === '.')) continue
    dirs.add(join(home, relative.slice(0, match.index + match[0].length).replace(/\/$/, '')))
  }
  return [...dirs]
}

/**
 * The config folders split by what the agent does with them: a folder an
 * environment variable points into is the agent's own home (CODEX_HOME,
 * GROK_HOME, ...) and stays writable; a folder only named in the arguments
 * holds Studio's prompt and MCP files, which the agent must not change.
 */
export function studioConfigMounts(args: readonly string[], env: Record<string, string | undefined> = {}): { configs: string[]; readOnlyConfigs: string[] } {
  const dirs = studioConfigDirs(args, env)
  const values = Object.values(env).filter((value): value is string => typeof value === 'string')
  const writable = (dir: string) => values.some(value => value === dir || value.startsWith(`${dir}/`))
  return { configs: dirs.filter(writable), readOnlyConfigs: dirs.filter(dir => !writable(dir)) }
}
