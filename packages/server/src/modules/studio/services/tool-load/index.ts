import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import {
  DEFAULT_TOOL_LOAD_THRESHOLD, sanitizeToolLoadThreshold, toToolSearchSetting,
  type ToolLoadNotice, type ToolLoadSettings,
} from '../../../../../../shared/tool-load'

/**
 * Too many tools for a small model (docs/hermes-tool-load.md). The Hermes bridge
 * reports a chat's tools when a run starts (`bridge.context.ready`); when there are
 * more than the threshold, the chat gets one notice and the watcher an info event.
 * State: HERMES_WEB_UI_HOME/hermes-tool-load.json (the threshold, and the chats
 * already told, so the notice comes once per chat).
 */
interface ToolLoadFile {
  threshold: number
  chats: Record<string, ToolLoadNotice>
}

const MAX_CHATS = 500

export interface ToolLoadReport {
  sessionId: string
  profile?: string
  total_tool_count?: unknown
  tool_count?: unknown
  deferred_tool_count?: unknown
  tool_search_active?: unknown
  tool_search?: unknown
}

export class ToolLoadStore {
  private cache: ToolLoadFile | null = null

  constructor(private readonly path: () => string) {}

  private read(): ToolLoadFile {
    if (this.cache) return this.cache
    let raw: any = {}
    try {
      if (existsSync(this.path())) raw = JSON.parse(readFileSync(this.path(), 'utf8')) || {}
    } catch { raw = {} }
    const chats: Record<string, ToolLoadNotice> = {}
    for (const [id, notice] of Object.entries(raw.chats && typeof raw.chats === 'object' ? raw.chats : {})) {
      if (notice && typeof notice === 'object' && typeof (notice as any).total === 'number') chats[id] = notice as ToolLoadNotice
    }
    this.cache = { threshold: sanitizeToolLoadThreshold(raw.threshold), chats }
    return this.cache
  }

  private write(file: ToolLoadFile) {
    const ids = Object.keys(file.chats)
    if (ids.length > MAX_CHATS) {
      ids.sort((a, b) => file.chats[a].at - file.chats[b].at)
      for (const id of ids.slice(0, ids.length - MAX_CHATS)) delete file.chats[id]
    }
    this.cache = file
    const target = this.path()
    mkdirSync(dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, target)
  }

  settings(): ToolLoadSettings {
    return { threshold: this.read().threshold }
  }

  saveSettings(input: unknown): ToolLoadSettings {
    const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const file = this.read()
    this.write({ ...file, threshold: sanitizeToolLoadThreshold(body.threshold, file.threshold) })
    return this.settings()
  }

  notice(sessionId: string): ToolLoadNotice | null {
    return this.read().chats[sessionId] || null
  }

  dismiss(sessionId: string): ToolLoadNotice | null {
    const file = this.read()
    const current = file.chats[sessionId]
    if (!current) return null
    file.chats[sessionId] = { ...current, dismissed: true }
    this.write(file)
    return file.chats[sessionId]
  }

  forget(sessionId: string) {
    const file = this.read()
    if (!file.chats[sessionId]) return
    delete file.chats[sessionId]
    this.write(file)
  }

  /** A new notice when this chat has too many tools and was not told yet; null otherwise. */
  observe(report: ToolLoadReport, now = Date.now()): ToolLoadNotice | null {
    const sessionId = String(report.sessionId || '').trim()
    if (!sessionId) return null
    const file = this.read()
    if (!file.threshold || file.chats[sessionId]) return null
    const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
    const total = count(report.total_tool_count) ?? count(report.tool_count)
    if (total === null || total <= file.threshold) return null
    const notice: ToolLoadNotice = {
      sessionId,
      profile: String(report.profile || 'default'),
      total,
      deferred: count(report.deferred_tool_count) ?? 0,
      toolSearchActive: report.tool_search_active === true,
      toolSearch: toToolSearchSetting(report.tool_search),
      threshold: file.threshold,
      at: now,
      dismissed: false,
    }
    file.chats[sessionId] = notice
    this.write(file)
    return notice
  }
}

let store: ToolLoadStore | null = null

/** Process-wide store under HERMES_WEB_UI_HOME. */
export function getToolLoad(): ToolLoadStore {
  if (!store) store = new ToolLoadStore(() => join(getWebUiHome(), 'hermes-tool-load.json'))
  return store
}

/** Tests only. */
export function resetToolLoad(next: ToolLoadStore | null = null) {
  store = next
}

/** The chat notice, in plain words (the persisted command message; the banner has its own strings). */
export function toolLoadNoticeText(notice: ToolLoadNotice): string {
  const search = notice.toolSearchActive
    ? ` Tool search hides ${notice.deferred} of them behind tool_search, which small models often cannot use.`
    : ''
  return `This chat has ${notice.total} tools; small models may struggle.${search} Turn off tool search or some plugins or MCP servers for the "${notice.profile}" profile.`
}

export { DEFAULT_TOOL_LOAD_THRESHOLD }
