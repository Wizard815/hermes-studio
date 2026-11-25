import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import {
  addMessages,
  createSession,
  deleteSession,
  findSessionByNativeSessionId,
  getSession,
  updateSession,
  updateSessionStats,
} from '../../repositories/session-store'
import { getSessionCategory } from '../../repositories/session-category-store'
import { getCodingAgentGlobalHome } from '../../public/coding-agent-global-home'
import { readConfigYamlForProfile } from '../../public/profile-config'
import { archiveFormat, extractChatArchive } from './archive'
import { discoverSources, type SourceFile } from './discover'
import { listHermesChats, readHermesChat } from './parse-hermes'
import { parseClaudeSession, parseCodexSession, parseOpenClawSession } from './parse-jsonl'
import {
  ChatImportError,
  DEFAULT_CHAT_IMPORT_LIMITS,
  type CandidateLocation,
  type ChatCandidate,
  type ChatImportKind,
  type ChatImportLimits,
  type ImportedMessage,
  type ParsedChat,
} from './types'

const SCAN_TTL_MS = 60 * 60 * 1000
const STUDIO_AGENT: Record<ChatImportKind, { source: string; agent: string; coding: boolean }> = {
  hermes: { source: 'cli', agent: 'hermes', coding: false },
  openclaw: { source: 'cli', agent: 'hermes', coding: false },
  'claude-code': { source: 'coding_agent', agent: 'claude', coding: true },
  codex: { source: 'coding_agent', agent: 'codex', coding: true },
}

/** The Studio chat id for a source chat: the same source chat always maps to the same chat. */
export function importedChatId(kind: ChatImportKind, originalId: string): string {
  return `import-${createHash('sha256').update(`${kind}:${originalId}`).digest('hex').slice(0, 24)}`
}

/**
 * The Studio chat a source chat already is: an earlier import, or (for this
 * server's own agents) the Studio chat that ran it. Studio's Hermes chats use
 * their Studio id as the Hermes session id; its coding chats keep the agent's
 * session id.
 */
export function existingChatFor(kind: ChatImportKind, originalId: string): string | null {
  const imported = getSession(importedChatId(kind, originalId))
  if (imported) return imported.id
  if (kind === 'hermes') return getSession(originalId)?.id ?? null
  if (kind === 'claude-code' || kind === 'codex') return findSessionByNativeSessionId(originalId)?.id ?? null
  return null
}

export function isImportedChatId(id: string): boolean {
  return /^import-[0-9a-f]{24}$/.test(id)
}

export interface ScanSummary {
  id: string
  label: string
  upload: boolean
  createdAt: number
  candidates: ChatCandidate[]
  truncated: boolean
  counts: Record<ChatImportKind, number>
  /** Files in the upload that were not chat sources (credentials, configs, other files). */
  skippedFiles: number
  errors: string[]
}

interface Scan extends ScanSummary {
  owner: string
  tempDir: string | null
  locations: Map<string, CandidateLocation>
}

export interface ImportResultItem {
  key: string
  title: string
  kind: ChatImportKind
  sessionId?: string
  reason?: string
}

export interface ImportJob {
  id: string
  scanId: string
  status: 'running' | 'done' | 'failed'
  total: number
  done: number
  imported: ImportResultItem[]
  skipped: ImportResultItem[]
  failed: ImportResultItem[]
  error?: string
}

export interface ChatImportOptions {
  limits?: Partial<ChatImportLimits>
  /** Folders where this server's Claude Code and Codex keep their sessions. */
  agentHomes?: () => { claude: string[]; codex: string[] }
}

function defaultAgentHomes(): { claude: string[]; codex: string[] } {
  const home = getCodingAgentGlobalHome()
  return {
    claude: [process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')],
    codex: [process.env.CODEX_HOME?.trim() || join(home, '.codex')],
  }
}

function real(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

function inside(path: string, root: string): boolean {
  const rel = relative(real(root), real(path))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep)
}

function isDirectory(path: string | null): boolean {
  if (!path || !isAbsolute(path)) return false
  try { return statSync(path).isDirectory() } catch { return false }
}

function emptyCounts(): Record<ChatImportKind, number> {
  return { hermes: 0, 'claude-code': 0, codex: 0, openclaw: 0 }
}

/** The profile's default model, as the History page's single-chat import uses. */
async function profileDefaultModel(profile: string): Promise<{ model: string; provider: string }> {
  try {
    const section = (await readConfigYamlForProfile(profile))?.model
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      return { model: String(section.default || '').trim(), provider: String(section.provider || '').trim() }
    }
    if (typeof section === 'string') return { model: section.trim(), provider: '' }
  } catch { /* no config: Studio picks at the next run */ }
  return { model: '', provider: '' }
}

/** Tool results need the call they answer: a model refuses a history with orphaned results. */
export function pairedMessages(messages: ImportedMessage[]): ImportedMessage[] {
  const calls = new Set<string>()
  const out: ImportedMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.tool_calls || []) calls.add(call.id)
    if (message.role === 'tool' && (!message.tool_call_id || !calls.has(message.tool_call_id))) continue
    out.push(message)
  }
  return out
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ChatImportService {
  readonly limits: ChatImportLimits
  private scans = new Map<string, Scan>()
  private jobs = new Map<string, ImportJob>()
  private agentHomes: () => { claude: string[]; codex: string[] }

  constructor(options: ChatImportOptions = {}) {
    this.limits = { ...DEFAULT_CHAT_IMPORT_LIMITS, ...options.limits }
    this.agentHomes = options.agentHomes || defaultAgentHomes
  }

  /** Scan a folder on this server (`~` is Studio's home folder). */
  async scanPath(input: string, owner: string): Promise<ScanSummary> {
    const raw = String(input || '').trim()
    const path = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
    if (!path || !isAbsolute(path)) throw new ChatImportError('Enter a full path that starts with / (or ~ for Studio\'s home folder)')
    if (!existsSync(path)) throw new ChatImportError('That path does not exist on the Studio server', 404, 'chat_import_not_found')
    return this.scan(resolve(path), owner, { label: path, tempDir: null, deep: false, skippedFiles: 0 })
  }

  /** Save an uploaded archive, unpack only its chat files and scan them. */
  async scanUpload(stream: Readable, filename: string, owner: string): Promise<ScanSummary> {
    const name = basename(String(filename || '').replace(/\\/g, '/'))
    const format = archiveFormat(name)
    if (!format) throw new ChatImportError('Upload a .zip, .tar, .tar.gz or .tgz file')
    const tempDir = await mkdtemp(join(tmpdir(), 'studio-chat-import-'))
    try {
      const archive = join(tempDir, `upload.${format === 'zip' ? 'zip' : name.toLowerCase().endsWith('.tar') ? 'tar' : 'tgz'}`)
      let size = 0
      const max = this.limits.maxUploadBytes
      await pipeline(stream, new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length
          if (size > max) done(new ChatImportError(`The upload is larger than ${Math.round(max / 1024 / 1024)} MB`, 413, 'chat_import_too_large'))
          else done(null, chunk)
        },
      }), createWriteStream(archive, { flags: 'wx' }))
      const unpacked = join(tempDir, 'files')
      await mkdir(unpacked)
      const extracted = await extractChatArchive(archive, format, unpacked, this.limits)
      await rm(archive, { force: true })
      return await this.scan(unpacked, owner, { label: name, tempDir, deep: true, skippedFiles: extracted.skipped })
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true })
      throw error
    }
  }

  private async scan(root: string, owner: string, options: { label: string; tempDir: string | null; deep: boolean; skippedFiles: number }): Promise<ScanSummary> {
    this.sweep()
    const files = await discoverSources(root, { deep: options.deep, limit: this.limits.maxChats * 2 })
    const scan: Scan = {
      id: randomUUID(),
      label: options.label,
      upload: !!options.tempDir,
      createdAt: Date.now(),
      candidates: [],
      truncated: false,
      counts: emptyCounts(),
      skippedFiles: options.skippedFiles,
      errors: [],
      owner,
      tempDir: options.tempDir,
      locations: new Map(),
    }
    const homes = this.agentHomes()
    for (const file of files) {
      if (scan.candidates.length >= this.limits.maxChats) { scan.truncated = true; break }
      try {
        await this.addCandidates(scan, file, homes)
      } catch (error) {
        scan.errors.push(`${basename(file.path)}: ${errorMessage(error)}`)
      }
    }
    if (scan.candidates.length > this.limits.maxChats) {
      scan.candidates = scan.candidates.slice(0, this.limits.maxChats)
      scan.truncated = true
    }
    scan.candidates.sort((a, b) => b.lastActive - a.lastActive)
    if (!scan.candidates.length && scan.tempDir) {
      await rm(scan.tempDir, { recursive: true, force: true })
      scan.tempDir = null
    }
    this.scans.set(scan.id, scan)
    return this.summary(scan)
  }

  private candidate(scan: Scan, chat: Omit<ChatCandidate, 'key' | 'existingSessionId' | 'cwdExists' | 'resumable'> & { path: string; sessionIds?: string[] }, homes: { claude: string[]; codex: string[] }) {
    const key = `${chat.kind}:${chat.originalId}`
    if (scan.locations.has(key)) return
    const cwdExists = isDirectory(chat.cwd)
    const agentHome = chat.kind === 'claude-code' ? homes.claude : chat.kind === 'codex' ? homes.codex : []
    // The agent finds its own session only in its own home; Claude Code also needs the project folder.
    const resumable = !scan.tempDir && agentHome.some(home => inside(chat.path, home)) && (chat.kind !== 'claude-code' || cwdExists)
    const existing = existingChatFor(chat.kind, chat.originalId)
    const { path, sessionIds, ...rest } = chat
    scan.candidates.push({ ...rest, key, existingSessionId: existing, cwdExists, resumable })
    scan.locations.set(key, { kind: chat.kind, path, ...(sessionIds ? { sessionIds } : {}) })
    scan.counts[chat.kind] += 1
  }

  private async addCandidates(scan: Scan, file: SourceFile, homes: { claude: string[]; codex: string[] }) {
    if (file.kind === 'hermes') {
      for (const chat of await listHermesChats(file.path)) {
        if (scan.candidates.length >= this.limits.maxChats) { scan.truncated = true; return }
        this.candidate(scan, {
          kind: 'hermes', originalId: chat.originalId, title: chat.title, startedAt: chat.startedAt, lastActive: chat.lastActive,
          messageCount: chat.messageCount, cwd: chat.cwd, model: chat.model, sourceProfile: file.profile,
          skipReason: chat.userMessages ? null : 'empty', path: file.path, sessionIds: chat.sessionIds,
        }, homes)
      }
      return
    }
    let parsed: ParsedChat
    try {
      parsed = await this.parseFile(file.kind, file.path)
    } catch (error) {
      const tooLarge = error instanceof ChatImportError && error.code === 'chat_import_too_large'
      this.candidate(scan, {
        kind: file.kind, originalId: basename(file.path).replace(/\.jsonl$/i, ''), title: basename(file.path), startedAt: 0, lastActive: 0,
        messageCount: 0, cwd: null, model: '', skipReason: tooLarge ? 'too_large' : 'unreadable', path: file.path,
      }, homes)
      return
    }
    const userMessages = parsed.messages.filter(message => message.role === 'user').length
    this.candidate(scan, {
      kind: parsed.kind, originalId: parsed.originalId, title: parsed.title, startedAt: parsed.startedAt, lastActive: parsed.lastActive,
      messageCount: parsed.messages.length, cwd: parsed.cwd, model: parsed.model, skipReason: userMessages ? null : 'empty', path: file.path,
    }, homes)
  }

  private parseFile(kind: ChatImportKind, path: string): Promise<ParsedChat> {
    if (kind === 'claude-code') return parseClaudeSession(path, this.limits)
    if (kind === 'codex') return parseCodexSession(path, this.limits)
    if (kind === 'openclaw') return parseOpenClawSession(path, this.limits)
    throw new ChatImportError('Unknown source')
  }

  private summary(scan: Scan): ScanSummary {
    // Refresh duplicates: another import may have run since the scan.
    const candidates = scan.candidates.map(candidate => ({ ...candidate, existingSessionId: existingChatFor(candidate.kind, candidate.originalId) }))
    const { owner: _owner, tempDir: _tempDir, locations: _locations, ...summary } = scan
    return { ...summary, candidates }
  }

  private ownScan(scanId: string, owner: string): Scan {
    const scan = this.scans.get(scanId)
    if (!scan || scan.owner !== owner) throw new ChatImportError('This preview has expired. Pick the source again', 404, 'chat_import_scan_missing')
    return scan
  }

  getScan(scanId: string, owner: string): ScanSummary {
    return this.summary(this.ownScan(scanId, owner))
  }

  async discardScan(scanId: string, owner: string): Promise<void> {
    const scan = this.ownScan(scanId, owner)
    this.scans.delete(scanId)
    if (scan.tempDir) await rm(scan.tempDir, { recursive: true, force: true })
  }

  /** Start importing the chosen chats; returns at once with a job to poll. */
  startImport(scanId: string, owner: string, input: { keys?: string[]; profile: string; categoryId: number | null }): ImportJob {
    const scan = this.ownScan(scanId, owner)
    if ([...this.jobs.values()].some(job => job.scanId === scanId && job.status === 'running')) {
      throw new ChatImportError('This import is already running', 409, 'chat_import_running')
    }
    if (input.categoryId != null && !getSessionCategory(input.categoryId)) throw new ChatImportError('That folder no longer exists', 400, 'chat_import_folder_missing')
    const wanted = input.keys?.length ? new Set(input.keys) : null
    const chosen = scan.candidates.filter(candidate => !wanted || wanted.has(candidate.key))
    const job: ImportJob = { id: randomUUID(), scanId, status: 'running', total: chosen.length, done: 0, imported: [], skipped: [], failed: [] }
    this.jobs.set(job.id, job)
    void this.run(scan, job, chosen, owner, input).catch(error => {
      job.status = 'failed'
      job.error = errorMessage(error)
    })
    return job
  }

  getJob(jobId: string): ImportJob | null {
    return this.jobs.get(jobId) ?? null
  }

  /** Wait for a job (tests and scripts). */
  async waitForJob(jobId: string, timeoutMs = 30_000): Promise<ImportJob> {
    const start = Date.now()
    for (;;) {
      const job = this.jobs.get(jobId)
      if (!job) throw new Error('No such job')
      if (job.status !== 'running') return job
      if (Date.now() - start > timeoutMs) throw new Error('Import timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  private async run(scan: Scan, job: ImportJob, chosen: ChatCandidate[], owner: string, input: { profile: string; categoryId: number | null }) {
    const defaults = await profileDefaultModel(input.profile || 'default')
    for (const candidate of chosen) {
      const item: ImportResultItem = { key: candidate.key, title: candidate.title, kind: candidate.kind }
      const id = importedChatId(candidate.kind, candidate.originalId)
      try {
        if (candidate.skipReason) job.skipped.push({ ...item, reason: candidate.skipReason })
        else if (existingChatFor(candidate.kind, candidate.originalId)) job.skipped.push({ ...item, sessionId: existingChatFor(candidate.kind, candidate.originalId)!, reason: 'duplicate' })
        else {
          const location = scan.locations.get(candidate.key)
          if (!location) throw new Error('Source file is gone')
          const messages = location.kind === 'hermes'
            ? await readHermesChat(location.path, location.sessionIds || [], this.limits)
            : (await this.parseFile(location.kind, location.path)).messages
          if (!messages.some(message => message.role === 'user')) job.skipped.push({ ...item, reason: 'empty' })
          else {
            this.writeChat(id, candidate, pairedMessages(messages), owner, input, defaults)
            job.imported.push({ ...item, sessionId: id })
          }
        }
      } catch (error) {
        job.failed.push({ ...item, reason: errorMessage(error) })
      }
      job.done += 1
      // Let requests through between chats on huge imports.
      await new Promise(resolve => setImmediate(resolve))
    }
    // An upload is unpacked only for this import: remove it unless something is left to retry.
    if (scan.tempDir && job.failed.length === 0) {
      this.scans.delete(scan.id)
      await rm(scan.tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
    job.status = 'done'
  }

  private writeChat(id: string, candidate: ChatCandidate, messages: ImportedMessage[], owner: string, input: { profile: string; categoryId: number | null }, defaults: { model: string; provider: string }) {
    const target = STUDIO_AGENT[candidate.kind]
    createSession({
      id,
      profile: input.profile || 'default',
      source: target.source,
      agent: target.agent,
      // Coding chats use the agent's own setup; Hermes chats the profile's default model.
      ...(target.coding ? { agent_mode: 'global', provider: 'global' } : defaults),
      agent_native_session_id: candidate.resumable ? candidate.originalId : '',
      user_id: owner,
      studio_user_id: owner,
      title: candidate.title,
      workspace: candidate.cwdExists && candidate.cwd ? candidate.cwd : undefined,
      category_id: input.categoryId,
      push_enabled: false,
    })
    try {
      const fallback = candidate.startedAt || Math.floor(Date.now() / 1000)
      addMessages(messages.map(message => ({
        session_id: id,
        role: message.role,
        content: message.content,
        tool_calls: message.tool_calls ?? null,
        tool_call_id: message.tool_call_id ?? null,
        tool_name: message.tool_name ?? null,
        timestamp: message.timestamp || fallback,
        reasoning: message.reasoning ?? null,
        finish_reason: message.finish_reason ?? null,
      })))
      const started = candidate.startedAt || messages[0]?.timestamp || fallback
      updateSession(id, { started_at: started, tool_call_count: messages.reduce((sum, message) => sum + (message.tool_calls?.length || 0), 0) })
      updateSessionStats(id)
    } catch (error) {
      deleteSession(id)
      throw error
    }
  }

  private sweep() {
    const now = Date.now()
    for (const [id, scan] of this.scans) {
      if (now - scan.createdAt < SCAN_TTL_MS) continue
      if ([...this.jobs.values()].some(job => job.scanId === id && job.status === 'running')) continue
      this.scans.delete(id)
      if (scan.tempDir) void rm(scan.tempDir, { recursive: true, force: true })
    }
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' && !this.scans.has(job.scanId) && this.jobs.size > 20) this.jobs.delete(id)
    }
  }
}

export const chatImportService = new ChatImportService()
