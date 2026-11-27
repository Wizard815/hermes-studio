import { createHash, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import { deviceIdFromPublicKey, getDeviceIdentity } from '../../public/system-info'

/**
 * Studio-to-Studio federation for projects (docs/projects.md#federation).
 *
 * Two Studios pair once with a one-time code: Studio A makes a code, Studio B
 * sends it with its public key, and A's super admin approves B. After that
 * every request between them is signed with the sender's device key (the same
 * Ed25519 identity Studio uses for the app relay), over the LAN or Tailscale.
 * A Studio only ever sees the projects the other side shared with it, one
 * project at a time: a summary of the board, and it may message the
 * coordinator or add a task. Never shared: provider keys, profile memory,
 * chats, instructions, project memory, files, approvals.
 *
 * This service is each Studio's bridge: it holds the connections, checks
 * every signature, keeps a log of what crossed, and guards against two
 * coordinators messaging each other in a loop. It never decides what work to
 * do; each project's coordinator does. A Studio group lets many Studios talk:
 * when this Studio lets a group member in, it introduces it to every other
 * member, and members trust each other's introductions.
 */

export interface StudioPeer {
  /** The peer's device id (hwui_…), derived from its public key. */
  id: string
  publicKey: string
  /** Where this Studio reaches the peer, like http://studio-b.tailnet.ts.net:8648. */
  url: string
  label: string
  /** This side's super admin let the peer in. The side that typed the code approves at once. */
  approved: boolean
  /** Projects this Studio shares with the peer. */
  projects: string[]
  /** In this Studio's group: it gets the group's projects, and its introductions are trusted. */
  group: boolean
  /** The group member that introduced it ('' when the person paired it by code). */
  introducedBy: string
  createdAt: number
  lastSeenAt: number
}

/** One thing that crossed between this Studio and a paired one. */
export interface BridgeLogEntry {
  at: number
  peer: string
  label: string
  direction: 'in' | 'out'
  kind: 'message' | 'task' | 'introduced'
  /** The project on the receiving side. */
  project: string
  text: string
  /** Who sent it: the person in the Studios dialog, or a project's coordinator. */
  by: 'person' | 'coordinator' | 'studio'
  /** The sending project, when a coordinator sent it. */
  from?: { project: string; name: string }
}

/** The project a coordinator sent a message from, so the other side can reply to it. */
export interface PeerSender { project: string; name: string }

export interface PeerIdentity {
  device_id: string
  device_public_key: string
  device_private_key: string
}

/** What a peer sees of a shared project. */
export interface SharedProject {
  id: string
  name: string
  counts: { needsYou: number; working: number; done: number; resolved: number }
  threads: Array<{ id: string; title: string; agent: string; status: string; resolved: boolean; pr: string }>
  tasks: Array<{ id: string; title: string; column: string; pr: string }>
  artifacts: Array<{ id: string; title: string; ref: string }>
}

/** The part of ProjectService federation uses, so tests can pass a fake. */
export interface PeerProjects {
  list(): Promise<Array<{ id: string; name: string; counts: SharedProject['counts']; threads: Array<{ id: string; title: string; agent: string; liveStatus: string; resolved: boolean; pr: string }>; tasks: Array<{ id: string; title: string; column: string; pr: string; threadId: string }>; artifacts: Array<{ id: string; title: string; ref: string; kind: string }> }>>
  messageFromStudio(projectId: string, studio: string, text: unknown, from?: PeerSender & { studio: string }): Promise<unknown>
  addTask(projectId: string, input: { title?: unknown; notes?: unknown }): Promise<unknown>
}

export interface PeerRequest {
  method: string
  /** The path, without the query. */
  path: string
  headers: Record<string, string | string[] | undefined>
  /** The body exactly as sent ('' for none): the signature covers it. */
  rawBody: string
}

export interface PeerReply { status: number; body: unknown }

export type PeerFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<any> }>

export interface PeerDeps {
  store: PeerStore
  projects: () => PeerProjects
  identity?: () => Promise<PeerIdentity>
  fetch?: PeerFetch
  now?: () => number
  /** This Studio's name as peers see it. */
  label?: () => string
}

export const CODE_TTL_MS = 5 * 60_000
/** How far a signed request's clock may be off, and how long its nonce is remembered. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000
const CODES_MAX = 5
const PEERS_MAX = 50
const LOG_MAX = 300
/** A coordinator that sent a message may get replies to its project this long, shared or not. */
export const REPLY_WINDOW_MS = 24 * 60 * 60_000
/** Messages and tasks a project's coordinators may send to one Studio per hour (the person is not limited). */
export const COORDINATOR_SENDS_PER_HOUR = 30
/** Messages and tasks this Studio takes from one Studio per hour. */
export const RECEIVES_PER_HOUR = 120
const HOUR_MS = 60 * 60_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const HEADER = { device: 'x-studio-peer', nonce: 'x-studio-nonce', timestamp: 'x-studio-timestamp', signature: 'x-studio-signature' }
export const FEDERATION_PREFIX = '/api/studio/federation'

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status })
}

function clean(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max)
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** A peer's address: http(s), no user or password in it, no trailing slash. */
export function peerUrl(value: unknown): string {
  const raw = clean(value, 300)
  let url: URL
  try { url = new URL(raw) } catch { return '' }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return ''
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

/** Codes are typed by people: case, spaces and dashes do not matter. */
export function normalizeCode(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function signingPayload(input: { device: string; nonce: string; timestamp: number; method: string; path: string; rawBody: string }): string {
  return ['studio-peer.v1', input.device, input.nonce, String(input.timestamp), input.method.toUpperCase(), input.path, sha256(input.rawBody)].join('\n')
}

export function signRequest(identity: PeerIdentity, method: string, path: string, rawBody: string, now = Date.now()): Record<string, string> {
  const nonce = randomBytes(16).toString('base64url')
  const signature = sign(null, Buffer.from(signingPayload({ device: identity.device_id, nonce, timestamp: now, method, path, rawBody })), identity.device_private_key).toString('base64url')
  return { [HEADER.device]: identity.device_id, [HEADER.nonce]: nonce, [HEADER.timestamp]: String(now), [HEADER.signature]: signature }
}

function header(request: PeerRequest, name: string): string {
  const value = request.headers[name]
  return clean(Array.isArray(value) ? value[0] : value, 2000)
}

interface PeerFile {
  peers: StudioPeer[]
  codes: Array<{ hash: string; expiresAt: number }>
  /** Projects shared with every Studio in this Studio's group. */
  groupProjects: string[]
  log: BridgeLogEntry[]
  /** Projects a peer may answer, because their coordinator messaged it from there. */
  replies: Array<{ peer: string; project: string; until: number }>
  /** Studios the person unpaired: introductions do not bring them back. Pairing by code does. */
  blocked: string[]
}

/** A Studio's public card, as group members pass it to each other. */
interface PeerCard { id: string; publicKey: string; url: string; label: string }

function validCard(raw: any): PeerCard | null {
  const publicKey = String(raw?.publicKey || '')
  const id = clean(raw?.id, 80)
  const url = peerUrl(raw?.url)
  if (!id || !url || !publicKey.includes('PUBLIC KEY') || deviceIdFromPublicKey(publicKey) !== id) return null
  return { id, publicKey, url, label: clean(raw?.label, 80) || id }
}

const strings = (value: unknown, max: number) => [...new Set((Array.isArray(value) ? value : []).map((item: unknown) => clean(item, max)).filter(Boolean))] as string[]

function normalizePeer(raw: any): StudioPeer | null {
  if (!raw || typeof raw !== 'object') return null
  const publicKey = String(raw.publicKey || '')
  const id = clean(raw.id, 80)
  if (!id || !publicKey.includes('PUBLIC KEY') || deviceIdFromPublicKey(publicKey) !== id) return null
  return {
    id,
    publicKey,
    url: peerUrl(raw.url),
    label: clean(raw.label, 80) || id,
    approved: raw.approved === true,
    projects: strings(raw.projects, 64),
    group: raw.group === true,
    introducedBy: clean(raw.introducedBy, 80),
    createdAt: Number(raw.createdAt) || Date.now(),
    lastSeenAt: Number(raw.lastSeenAt) || 0,
  }
}

/** peers.json under the Web UI home: paired Studios and live pairing codes (hashed). */
export class PeerStore {
  private cache: PeerFile | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: string | null) {}

  async read(): Promise<PeerFile> {
    if (this.cache) return this.cache
    let raw: any = {}
    if (this.path) { try { raw = JSON.parse(await readFile(this.path, 'utf8')) } catch { raw = {} } }
    this.cache = {
      peers: (Array.isArray(raw.peers) ? raw.peers : []).map(normalizePeer).filter((peer: StudioPeer | null): peer is StudioPeer => !!peer),
      codes: (Array.isArray(raw.codes) ? raw.codes : []).filter((code: any) => typeof code?.hash === 'string' && Number(code.expiresAt) > 0),
      groupProjects: strings(raw.groupProjects, 64),
      log: (Array.isArray(raw.log) ? raw.log : []).filter((entry: any) => entry && typeof entry.peer === 'string').slice(-LOG_MAX),
      replies: (Array.isArray(raw.replies) ? raw.replies : []).filter((item: any) => typeof item?.peer === 'string' && typeof item?.project === 'string' && Number(item.until) > 0),
      blocked: strings(raw.blocked, 80),
    }
    return this.cache
  }

  async change<T>(edit: (file: PeerFile) => T): Promise<T> {
    const file = await this.read()
    const result = edit(file)
    this.cache = file
    const path = this.path
    if (path) {
      const data = JSON.stringify(file, null, 2)
      this.writing = this.writing.then(async () => {
        await mkdir(dirname(path), { recursive: true })
        const temp = `${path}.${process.pid}.tmp`
        await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 })
        await rename(temp, path)
      })
      await this.writing
    }
    return result
  }
}

export class PeerService {
  /** Nonces seen inside the signature window, so a captured request cannot be replayed. */
  private readonly nonces = new Map<string, number>()
  /** When coordinators sent to each Studio, and when each Studio sent here, over the last hour. */
  private readonly sends = new Map<string, number[]>()
  private readonly receives = new Map<string, number[]>()
  /** Introductions still being passed on. */
  private readonly background = new Set<Promise<void>>()

  constructor(private readonly deps: PeerDeps) {}

  /** Resolves once no introductions are being passed on (for tests and the live check). */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background])
  }

  private later(work: () => Promise<unknown>): void {
    const job: Promise<void> = work().then(() => undefined, () => undefined).finally(() => { this.background.delete(job) })
    this.background.add(job)
  }

  /** Count one send in a sliding hour; false once the limit is reached. */
  private allow(counts: Map<string, number[]>, key: string, limit: number): boolean {
    const now = this.now()
    const recent = (counts.get(key) ?? []).filter(at => now - at < HOUR_MS)
    if (recent.length >= limit) { counts.set(key, recent); return false }
    recent.push(now)
    counts.set(key, recent)
    return true
  }

  private async record(entry: Omit<BridgeLogEntry, 'at'>): Promise<void> {
    await this.deps.store.change(file => {
      file.log.push({ at: this.now(), ...entry, text: clean(entry.text, 500) })
      if (file.log.length > LOG_MAX) file.log = file.log.slice(-LOG_MAX)
    })
  }

  /** The bridge log, newest last. */
  async log(limit = 100): Promise<BridgeLogEntry[]> {
    return (await this.deps.store.read()).log.slice(-Math.max(1, Math.min(LOG_MAX, limit)))
  }

  /** Projects shared with every Studio in this Studio's group. */
  async groupProjects(): Promise<string[]> {
    return [...(await this.deps.store.read()).groupProjects]
  }

  async setGroupProjects(value: unknown): Promise<string[]> {
    const known = new Set((await this.deps.projects().list()).map(project => project.id))
    const projects = strings(value, 64)
    const unknown = projects.find(item => !known.has(item))
    if (unknown) fail(`No project ${unknown}`, 404)
    return this.deps.store.change(file => { file.groupProjects = projects; return [...projects] })
  }

  private shared(file: PeerFile, peer: StudioPeer): Set<string> {
    return new Set([...peer.projects, ...(peer.group ? file.groupProjects : [])])
  }

  /** An approved Studio by id or name, for coordinators. */
  async find(nameOrId: unknown): Promise<StudioPeer> {
    const wanted = clean(nameOrId, 80).toLowerCase()
    const peers = (await this.deps.store.read()).peers.filter(peer => peer.approved)
    const peer = peers.find(item => item.id.toLowerCase() === wanted) ?? peers.find(item => item.label.toLowerCase() === wanted)
    if (!peer) fail(`No connected Studio "${clean(nameOrId, 80)}". Connected: ${peers.map(item => `"${item.label}"`).join(', ') || 'none'}.`, 404)
    return peer
  }

  /** Every connected Studio and what it shares with this one, for a coordinator. A Studio that does not answer says why. */
  async directory(): Promise<Array<{ id: string; label: string; group: boolean; projects: SharedProject[]; error?: string }>> {
    const peers = (await this.deps.store.read()).peers.filter(peer => peer.approved)
    return Promise.all(peers.map(async peer => {
      try { return { id: peer.id, label: peer.label, group: peer.group, projects: await this.remoteProjects(peer.id) } } catch (error) {
        return { id: peer.id, label: peer.label, group: peer.group, projects: [], error: error instanceof Error ? error.message : String(error) }
      }
    }))
  }

  /**
   * Introduce a group member: send it this Studio's other group members, and
   * send each of them its card. Its reply carries its own group, so both
   * sides end up knowing everyone.
   */
  private async introduce(id: string): Promise<void> {
    const file = await this.deps.store.read()
    const peer = file.peers.find(item => item.id === id)
    if (!peer?.approved || !peer.group || !peer.url) return
    const card = (item: StudioPeer): PeerCard => ({ id: item.id, publicKey: item.publicKey, url: item.url, label: item.label })
    const others = file.peers.filter(item => item.id !== id && item.approved && item.group && item.url)
    const reply = await this.send(peer.url, 'POST', '/introduce', { studios: others.map(card) }).catch(() => null)
    if (reply) await this.accept(peer, reply.studios)
    await Promise.allSettled(others.map(async other => {
      const answer = await this.send(other.url, 'POST', '/introduce', { studios: [card(peer)] })
      await this.accept(other, answer?.studios)
    }))
  }

  /** Cards a trusted group member passed on: add the Studios this one does not know yet, and pass them on in turn. */
  private async accept(from: StudioPeer, raw: unknown): Promise<string[]> {
    const self = (await this.identity()).device_id
    const cards = (Array.isArray(raw) ? raw : []).slice(0, PEERS_MAX).map(validCard).filter((card): card is PeerCard => !!card)
    const added = await this.deps.store.change(file => {
      const sender = file.peers.find(item => item.id === from.id)
      if (!sender?.approved || !sender.group) return []
      const fresh: StudioPeer[] = []
      for (const card of cards) {
        if (card.id === self || card.id === from.id || file.blocked.includes(card.id) || file.peers.some(item => item.id === card.id)) continue
        if (file.peers.length >= PEERS_MAX) break
        const peer: StudioPeer = { ...card, approved: true, group: true, introducedBy: sender.label, projects: [], createdAt: this.now(), lastSeenAt: 0 }
        file.peers.push(peer)
        fresh.push(peer)
      }
      return fresh
    })
    for (const peer of added) {
      await this.record({ peer: peer.id, label: peer.label, direction: 'in', kind: 'introduced', project: '', text: `Introduced by ${from.label}`, by: 'studio' })
      this.later(() => this.introduce(peer.id))
    }
    return added.map(peer => peer.id)
  }

  private now(): number { return (this.deps.now ?? Date.now)() }
  private identity(): Promise<PeerIdentity> { return (this.deps.identity ?? getDeviceIdentity)() }
  private label(): string { return clean((this.deps.label ?? (() => process.env.STUDIO_NAME || hostname()))(), 80) || 'Studio' }

  async self(): Promise<{ id: string; label: string }> {
    return { id: (await this.identity()).device_id, label: this.label() }
  }

  /** Paired Studios, without their keys. */
  async list(): Promise<Array<Omit<StudioPeer, 'publicKey'>>> {
    return (await this.deps.store.read()).peers.map(({ publicKey: _key, ...peer }) => peer)
  }

  private async peer(id: string): Promise<StudioPeer> {
    const peer = (await this.deps.store.read()).peers.find(item => item.id === id)
    if (!peer) fail('That Studio is not paired', 404)
    return peer
  }

  /** A one-time code another Studio types to pair with this one. Only its hash is kept. */
  async createCode(): Promise<{ code: string; expiresAt: number }> {
    const bytes = randomBytes(8)
    const raw = [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
    const now = this.now()
    const expiresAt = now + CODE_TTL_MS
    await this.deps.store.change(file => {
      file.codes = file.codes.filter(code => code.expiresAt > now).slice(-(CODES_MAX - 1))
      file.codes.push({ hash: sha256(raw), expiresAt })
    })
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt }
  }

  /**
   * This side typed the other Studio's code: send it with this Studio's key
   * and address. The other side keeps this Studio waiting for its approval;
   * this side trusts the Studio it reached, since the person typed its code.
   */
  async pair(input: { url?: unknown; code?: unknown; selfUrl?: unknown; label?: unknown; group?: unknown }): Promise<Omit<StudioPeer, 'publicKey'>> {
    const url = peerUrl(input.url)
    if (!url) fail('Give the other Studio\'s address, like http://studio.tailnet.ts.net:8648', 400)
    const code = normalizeCode(input.code)
    if (code.length !== 8) fail('The pairing code has 8 letters and digits, like ABCD-2345', 400)
    const selfUrl = peerUrl(input.selfUrl)
    if (!selfUrl) fail('Give this Studio\'s address as the other Studio reaches it', 400)
    const identity = await this.identity()
    const group = input.group === true
    const reply = await this.send(url, 'POST', '/pair', { code, url: selfUrl, label: this.label(), publicKey: identity.device_public_key, group })
    const publicKey = String(reply?.publicKey || '')
    const id = clean(reply?.id, 80)
    if (!publicKey.includes('PUBLIC KEY') || deviceIdFromPublicKey(publicKey) !== id) fail('The other Studio answered without a valid key', 502)
    if (id === identity.device_id) fail('That address is this Studio', 400)
    const label = clean(input.label, 80) || clean(reply?.label, 80) || url
    const peer = await this.deps.store.change(file => {
      const existing = file.peers.find(item => item.id === id)
      if (!existing && file.peers.length >= PEERS_MAX) fail(`At most ${PEERS_MAX} Studios can be paired`, 409)
      const next: StudioPeer = { id, publicKey, url, label, approved: true, projects: existing?.projects ?? [], group: group || (existing?.group ?? false), introducedBy: '', createdAt: existing?.createdAt ?? this.now(), lastSeenAt: this.now() }
      file.peers = [...file.peers.filter(item => item.id !== id), next]
      file.blocked = file.blocked.filter(item => item !== id)
      return next
    })
    if (peer.group) this.later(() => this.introduce(peer.id))
    const { publicKey: _key, ...view } = peer
    return view
  }

  async update(id: string, change: { approved?: unknown; label?: unknown; url?: unknown; projects?: unknown; group?: unknown }): Promise<Omit<StudioPeer, 'publicKey'>> {
    const before = await this.peer(id)
    const wasMember = before.approved && before.group
    const known = new Set((await this.deps.projects().list()).map(project => project.id))
    const peer = await this.deps.store.change(file => {
      const peer = file.peers.find(item => item.id === id)!
      if (typeof change.approved === 'boolean') peer.approved = change.approved
      if (typeof change.group === 'boolean') peer.group = change.group
      if (change.label !== undefined) peer.label = clean(change.label, 80) || peer.label
      if (change.url !== undefined) {
        const url = peerUrl(change.url)
        if (!url) fail('That is not an http(s) address', 400)
        peer.url = url
      }
      if (Array.isArray(change.projects)) {
        const projects = [...new Set(change.projects.map(item => clean(item, 64)))]
        const unknown = projects.find(item => !known.has(item))
        if (unknown) fail(`No project ${unknown}`, 404)
        peer.projects = projects
      }
      return { ...peer }
    })
    if (peer.approved && peer.group && !wasMember) this.later(() => this.introduce(peer.id))
    const { publicKey: _key, ...view } = peer
    return view
  }

  /** Unpair: forget the peer here, and tell it to forget this Studio (best effort). */
  async remove(id: string): Promise<{ removed: true; told: boolean }> {
    const peer = await this.peer(id)
    let told = false
    if (peer.url) told = await this.send(peer.url, 'DELETE', '/peer', null).then(() => true, () => false)
    await this.deps.store.change(file => {
      file.peers = file.peers.filter(item => item.id !== id)
      if (!file.blocked.includes(id)) file.blocked.push(id)
    })
    return { removed: true, told }
  }

  /** The projects a paired Studio shares with this one. */
  async remoteProjects(id: string): Promise<SharedProject[]> {
    const peer = await this.peer(id)
    const reply = await this.send(peer.url, 'GET', '/projects', null)
    return Array.isArray(reply?.projects) ? reply.projects : []
  }

  /**
   * Message a project's coordinator on a paired Studio. A coordinator names
   * the project it writes from: the other side may then answer that project
   * for a day, even if it is not shared, and coordinators are rate limited.
   */
  async remoteMessage(id: string, projectId: string, text: unknown, options: { by?: 'person' | 'coordinator'; from?: PeerSender } = {}): Promise<unknown> {
    const peer = await this.peer(id)
    const target = clean(projectId, 64)
    const body = clean(text, 4000)
    if (!body) fail('The message is empty', 400)
    const by = options.by ?? 'person'
    if (by === 'coordinator' && !this.allow(this.sends, peer.id, COORDINATOR_SENDS_PER_HOUR)) fail(`Coordinators here sent ${COORDINATOR_SENDS_PER_HOUR} messages to ${peer.label} in the last hour. Wait, or ask your person.`, 429)
    const from = options.from ? { project: clean(options.from.project, 64), name: clean(options.from.name, 120) } : undefined
    const reply = await this.send(peer.url, 'POST', `/projects/${encodeURIComponent(target)}/message`, { text: body, by, ...(from ? { from } : {}) })
    await this.deps.store.change(file => {
      const now = this.now()
      file.replies = file.replies.filter(item => item.until > now && !(item.peer === peer.id && item.project === from?.project))
      if (from) file.replies.push({ peer: peer.id, project: from.project, until: now + REPLY_WINDOW_MS })
    })
    await this.record({ peer: peer.id, label: peer.label, direction: 'out', kind: 'message', project: target, text: body, by, ...(from ? { from } : {}) })
    return reply
  }

  async remoteTask(id: string, projectId: string, input: { title?: unknown; notes?: unknown }, options: { by?: 'person' | 'coordinator'; from?: PeerSender } = {}): Promise<unknown> {
    const peer = await this.peer(id)
    const target = clean(projectId, 64)
    const by = options.by ?? 'person'
    if (by === 'coordinator' && !this.allow(this.sends, peer.id, COORDINATOR_SENDS_PER_HOUR)) fail(`Coordinators here sent ${COORDINATOR_SENDS_PER_HOUR} messages to ${peer.label} in the last hour. Wait, or ask your person.`, 429)
    const title = clean(input.title, 120)
    const from = options.from ? { project: clean(options.from.project, 64), name: clean(options.from.name, 120) } : undefined
    const reply = await this.send(peer.url, 'POST', `/projects/${encodeURIComponent(target)}/tasks`, { title, notes: clean(input.notes, 4000), by, ...(from ? { from } : {}) })
    await this.record({ peer: peer.id, label: peer.label, direction: 'out', kind: 'task', project: target, text: title, by, ...(from ? { from } : {}) })
    return reply
  }

  /** A signed request to a peer's federation API. */
  private async send(baseUrl: string, method: string, route: string, body: unknown): Promise<any> {
    if (!baseUrl) fail('That Studio has no address. Pair it again from this side.', 409)
    const identity = await this.identity()
    const path = new URL(`${baseUrl}${FEDERATION_PREFIX}${route}`).pathname
    const rawBody = body === null ? '' : JSON.stringify(body)
    const headers: Record<string, string> = { ...signRequest(identity, method, path, rawBody, this.now()) }
    if (rawBody) headers['content-type'] = 'application/json'
    let response: Awaited<ReturnType<PeerFetch>>
    try {
      response = await (this.deps.fetch ?? (globalThis.fetch as unknown as PeerFetch))(`${baseUrl}${FEDERATION_PREFIX}${route}`, { method, headers, body: rawBody || undefined, signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      fail(`The other Studio at ${baseUrl} isn't answering (${error instanceof Error ? error.message : String(error)}). Check that it is running and reachable over your LAN or Tailscale.`, 502)
    }
    const data = await response.json().catch(() => ({}))
    if (response.status >= 400) fail(clean(data?.error, 500) || `The other Studio answered ${response.status}`, [400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 502)
    return data
  }

  // --- The federation API: requests from other Studios ---

  /** Check a signed request: known key, fresh time, unseen nonce, valid signature over method, path and body. */
  private verified(request: PeerRequest, publicKey: string, device: string): boolean {
    const nonce = header(request, HEADER.nonce)
    const timestamp = Number(header(request, HEADER.timestamp))
    const signature = header(request, HEADER.signature)
    const now = this.now()
    if (!nonce || nonce.length > 64 || !signature || !Number.isFinite(timestamp) || Math.abs(now - timestamp) > SIGNATURE_WINDOW_MS) return false
    for (const [seen, at] of this.nonces) if (now - at > SIGNATURE_WINDOW_MS * 2) this.nonces.delete(seen)
    const key = `${device}:${nonce}`
    if (this.nonces.has(key)) return false
    let ok = false
    try {
      ok = verify(null, Buffer.from(signingPayload({ device, nonce, timestamp, method: request.method, path: request.path, rawBody: request.rawBody })), publicKey, Buffer.from(signature, 'base64url'))
    } catch { ok = false }
    if (ok) this.nonces.set(key, now)
    return ok
  }

  async handle(request: PeerRequest): Promise<PeerReply> {
    try {
      const route = request.path.startsWith(FEDERATION_PREFIX) ? request.path.slice(FEDERATION_PREFIX.length) : request.path
      if (request.method === 'POST' && route === '/pair') return await this.claim(request)
      const device = header(request, HEADER.device)
      const peer = (await this.deps.store.read()).peers.find(item => item.id === device)
      if (!peer || !this.verified(request, peer.publicKey, device)) return { status: 401, body: { error: 'This Studio does not know the sender, or its signature is wrong' } }
      if (request.method === 'DELETE' && route === '/peer') {
        await this.deps.store.change(file => {
          file.peers = file.peers.filter(item => item.id !== peer.id)
          if (!file.blocked.includes(peer.id)) file.blocked.push(peer.id)
        })
        return { status: 200, body: { removed: true } }
      }
      if (!peer.approved) return { status: 403, body: { error: `Waiting for approval: someone on ${this.label()} has to approve your Studio first` } }
      await this.deps.store.change(file => { const found = file.peers.find(item => item.id === peer.id); if (found) found.lastSeenAt = this.now() })
      const file = await this.deps.store.read()
      const shared = this.shared(file, peer)
      if (request.method === 'POST' && route === '/introduce') {
        if (!peer.group) return { status: 403, body: { error: `${this.label()} does not count your Studio in its group, so it does not take introductions from it` } }
        const input = request.rawBody ? JSON.parse(request.rawBody) : {}
        const card = (item: StudioPeer): PeerCard => ({ id: item.id, publicKey: item.publicKey, url: item.url, label: item.label })
        // Answer with this side's group first, so the sender learns members it did not know.
        const mine = file.peers.filter(item => item.id !== peer.id && item.approved && item.group && item.url).map(card)
        const added = await this.accept(peer, input?.studios)
        return { status: 200, body: { added: added.length, studios: mine } }
      }
      if (request.method === 'GET' && route === '/projects') {
        const projects = (await this.deps.projects().list()).filter(project => shared.has(project.id))
        return { status: 200, body: { studio: this.label(), projects: projects.map(sharedView) } }
      }
      const match = /^\/projects\/([^/]+)\/(message|tasks)$/.exec(route)
      if (request.method === 'POST' && match) {
        const projectId = decodeURIComponent(match[1])
        const answering = file.replies.some(item => item.peer === peer.id && item.project === projectId && item.until > this.now())
        if (!shared.has(projectId) && !answering) return { status: 404, body: { error: 'That project is not shared with your Studio' } }
        if (!this.allow(this.receives, peer.id, RECEIVES_PER_HOUR)) return { status: 429, body: { error: `${this.label()} took ${RECEIVES_PER_HOUR} messages from your Studio in the last hour. Try again later.` } }
        const input = request.rawBody ? JSON.parse(request.rawBody) : {}
        const by = input?.by === 'coordinator' ? 'coordinator' : 'person'
        const from = input?.from && typeof input.from === 'object' ? { project: clean(input.from.project, 64), name: clean(input.from.name, 120) } : undefined
        if (match[2] === 'message') {
          const result = await this.deps.projects().messageFromStudio(projectId, peer.label, input?.text, from?.project ? { ...from, studio: peer.label } : undefined)
          await this.record({ peer: peer.id, label: peer.label, direction: 'in', kind: 'message', project: projectId, text: clean(input?.text, 4000), by, ...(from?.project ? { from } : {}) })
          return { status: 200, body: result }
        }
        const sender = from?.project ? ` (its project “${from.name || from.project}”)` : ''
        const task = await this.deps.projects().addTask(projectId, { title: input?.title, notes: `${clean(input?.notes, 3900)}${input?.notes ? '\n\n' : ''}Added by the Studio “${peer.label}”${sender}.` })
        await this.record({ peer: peer.id, label: peer.label, direction: 'in', kind: 'task', project: projectId, text: clean(input?.title, 120), by, ...(from?.project ? { from } : {}) })
        return { status: 201, body: { task } }
      }
      return { status: 404, body: { error: 'No such federation route' } }
    } catch (error) {
      const status = Number((error as { status?: number })?.status)
      return { status: status >= 400 && status < 600 ? status : 500, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }

  /** Another Studio typed this Studio's code: keep it, waiting for approval. */
  private async claim(request: PeerRequest): Promise<PeerReply> {
    let input: any
    try { input = JSON.parse(request.rawBody || '{}') } catch { return { status: 400, body: { error: 'Bad JSON' } } }
    const publicKey = String(input?.publicKey || '')
    const device = header(request, HEADER.device)
    if (!publicKey.includes('PUBLIC KEY') || deviceIdFromPublicKey(publicKey) !== device) return { status: 400, body: { error: 'The key does not match the sender' } }
    if (!this.verified(request, publicKey, device)) return { status: 401, body: { error: 'The signature is wrong or too old' } }
    const hash = Buffer.from(sha256(normalizeCode(input?.code)))
    const now = this.now()
    const identity = await this.identity()
    if (device === identity.device_id) return { status: 400, body: { error: 'A Studio cannot pair with itself' } }
    return this.deps.store.change(file => {
      file.codes = file.codes.filter(code => code.expiresAt > now)
      const index = file.codes.findIndex(code => code.hash.length === hash.length && timingSafeEqual(Buffer.from(code.hash), hash))
      if (index < 0) return { status: 403, body: { error: 'That pairing code is wrong or expired. Make a new one on the other Studio.' } }
      file.codes.splice(index, 1)
      const existing = file.peers.find(item => item.id === device)
      if (!existing && file.peers.length >= PEERS_MAX) return { status: 409, body: { error: `At most ${PEERS_MAX} Studios can be paired` } }
      file.peers = [...file.peers.filter(item => item.id !== device), {
        id: device,
        publicKey,
        url: peerUrl(input?.url),
        label: clean(input?.label, 80) || device,
        approved: existing?.approved ?? false,
        projects: existing?.projects ?? [],
        group: input?.group === true || (existing?.group ?? false),
        introducedBy: '',
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: now,
      }]
      file.blocked = file.blocked.filter(item => item !== device)
      return { status: 200, body: { id: identity.device_id, publicKey: identity.device_public_key, label: this.label() } }
    })
  }
}

function sharedView(project: Awaited<ReturnType<PeerProjects['list']>>[number]): SharedProject {
  return {
    id: project.id,
    name: project.name,
    counts: project.counts,
    threads: project.threads.map(thread => ({ id: thread.id, title: thread.title, agent: thread.agent, status: thread.liveStatus, resolved: thread.resolved, pr: thread.pr })),
    tasks: project.tasks.filter(task => !task.threadId).map(task => ({ id: task.id, title: task.title, column: task.column, pr: task.pr })),
    // Files live on this host; only links mean anything elsewhere.
    artifacts: project.artifacts.filter(item => item.kind === 'link').map(item => ({ id: item.id, title: item.title, ref: item.ref })),
  }
}

let defaultPeers: PeerService | null = null

export function peerService(projects: () => PeerProjects): PeerService {
  if (!defaultPeers) defaultPeers = new PeerService({ store: new PeerStore(join(getWebUiHome(), 'projects', 'peers.json')), projects })
  return defaultPeers
}
