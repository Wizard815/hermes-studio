import { ref, watch } from 'vue'
import type { HerdrPaneView, HerdrStatusValue } from '@/api/coding-agents/herdr'

/**
 * Studio's herdr page in the Herdr App layout: the chrome of the Herdr desktop
 * app running the Space Folders layout (jankeesvw/herdr-space-folders'
 * `main-folders`, Herdr's own `main` layout with its spaces list swapped),
 * rebuilt for the browser. Herdr App's mods are GPUI JavaScript for the
 * native app; this is the same look and behaviour drawn by Vue:
 *
 *   sidebar 268px: brand 46 · Spaces (space folders) · Agents · footer 69
 *   work: tab bar 42 · panes (padding 8, gap 8, radius 10, 30px headers) · status 28
 *
 * Each pane is its own terminal (`herdr terminal session control`), not
 * herdr's terminal UI. This file is the layout's logic; HerdrAppView.vue
 * draws it. "herdr's own UI" (the terminal UI with its own sidebar) stays one
 * switch away.
 */

/** The page's two looks: the Herdr App layout, or herdr's own terminal UI. */
export type HerdrViewMode = 'app' | 'tui'

export const VIEW_STORAGE_KEY = 'studio_herdr_view'

/** Sizes from main-folders.json (logical pixels). */
export const APP_LAYOUT = {
  sidebar: 268,
  brand: 46,
  footer: 69,
  tabs: 42,
  status: 28,
  padding: 8,
  gap: 8,
  radius: 10,
  header: 30,
  panel: 368,
  terminalPadding: [14, 12] as const,
} as const

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function storage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function readViewMode(store: StorageLike | null = storage()): HerdrViewMode {
  try { return store?.getItem(VIEW_STORAGE_KEY) === 'tui' ? 'tui' : 'app' } catch { return 'app' }
}

export function writeViewMode(mode: HerdrViewMode, store: StorageLike | null = storage()): void {
  try { store?.setItem(VIEW_STORAGE_KEY, mode) } catch { /* private mode */ }
}

/** This viewer's look for the herdr page (the Herdr App layout unless they switched). */
export function useHerdrView(store: StorageLike | null = storage()) {
  const mode = ref<HerdrViewMode>(readViewMode(store))
  watch(mode, value => writeViewMode(value, store))
  return { mode, set: (value: HerdrViewMode) => { mode.value = value } }
}

// ---- panes ----

export interface PaneRect { x: number; y: number; width: number; height: number }

/**
 * A pane's place in the pane area, as CSS: herdr's rect (fractions of the
 * tab's area) with half the gap taken off each inner edge, so neighbours sit
 * `gap` apart and outer edges touch the area's padding (as Herdr App's pane
 * gap does).
 */
export function paneBox(rect: PaneRect, gap: number = APP_LAYOUT.gap): Record<string, string> {
  const half = gap / 2
  const eps = 0.0005
  const left = rect.x > eps ? half : 0
  const top = rect.y > eps ? half : 0
  const right = rect.x + rect.width < 1 - eps ? half : 0
  const bottom = rect.y + rect.height < 1 - eps ? half : 0
  const pct = (value: number) => `${Math.round(value * 100000) / 1000}%`
  return {
    left: `calc(${pct(rect.x)} + ${left}px)`,
    top: `calc(${pct(rect.y)} + ${top}px)`,
    width: `calc(${pct(rect.width)} - ${left + right}px)`,
    height: `calc(${pct(rect.height)} - ${top + bottom}px)`,
  }
}

/** `/home/me/code/x` → `~/code/x` (the pane header shows paths as Herdr App does). `home` may list the home's other spellings. */
export function tildePath(path: string, home: string | string[]): string {
  if (!path) return ''
  for (const entry of Array.isArray(home) ? home : [home]) {
    const base = (entry || '').replace(/\/+$/, '')
    if (base && (path === base || path.startsWith(`${base}/`))) return `~${path.slice(base.length)}`
  }
  return path
}

export interface PaneHeader {
  /** "bash", "claude", or the agent's name. */
  title: string
  /** The folder (~/…) or, for an agent, its chat. */
  detail: string
  agent: boolean
}

/**
 * A pane's 30px header (Herdr App's `pane` mod): a shell shows its program
 * and folder ("bash ~/code/x"), an agent its name and folder.
 */
export function paneHeader(pane: Pick<HerdrPaneView, 'agent' | 'label' | 'cwd' | 'foreground_cwd' | 'terminal_title_stripped'> | null, process: string, home: string | string[]): PaneHeader {
  const cwd = tildePath(pane?.foreground_cwd || pane?.cwd || '', home)
  if (pane?.agent) return { title: pane.agent, detail: pane.label && pane.label !== pane.agent ? `${pane.label} · ${cwd}` : cwd, agent: true }
  return { title: process || 'shell', detail: cwd, agent: false }
}

/**
 * Which pane a phone shows (one at a time): the focused one, else the first.
 * `step` moves to the next or previous pane (wrapping).
 */
export function phonePane(ids: string[], focused: string, step = 0): string {
  if (!ids.length) return ''
  const index = Math.max(0, ids.indexOf(focused))
  return ids[(index + step + ids.length) % ids.length]
}

// ---- agents ----

/** The Agents list's sections, most urgent first (Herdr App's agents mod, priority view). */
export const AGENT_GROUPS = ['blocked', 'working', 'done', 'idle'] as const
export type AgentGroup = typeof AGENT_GROUPS[number]

export interface AgentRow {
  paneId: string
  workspaceId: string
  name: string
  agent: string
  studioAgent: string | null
  status: HerdrStatusValue
  since: number
  sessionId: string | null
}

export type AgentSort = 'priority' | 'space'

export interface AgentSection {
  id: string
  /** A status group (priority view), or null for a space group. */
  status: AgentGroup | null
  /** A space group's name. */
  label: string
  rows: AgentRow[]
}

function groupOf(status: HerdrStatusValue): AgentGroup {
  return status === 'blocked' || status === 'working' || status === 'done' ? status : 'idle'
}

/**
 * Panes running an agent, in sections: by status (Working, Blocked, Done,
 * Idle; newest change first) or by space (in herdr's space order). The
 * shown order is the status order in the picture: Working before Idle,
 * Blocked first because it needs you.
 */
export function agentSections(panes: HerdrPaneView[], options: { sort: AgentSort; spaceName: (workspaceId: string) => string; chatTitle?: (sessionId: string) => string }): AgentSection[] {
  const rows: AgentRow[] = panes
    .filter(pane => !!pane.agent)
    .map(pane => ({
      paneId: pane.pane_id,
      workspaceId: pane.workspace_id,
      name: (pane.studioSessionId && options.chatTitle?.(pane.studioSessionId)) || pane.label || options.spaceName(pane.workspace_id) || pane.agent || pane.pane_id,
      agent: pane.agent || '',
      studioAgent: pane.studioAgent,
      status: pane.agent_status || 'unknown',
      since: pane.status_since || 0,
      sessionId: pane.studioSessionId,
    }))
  if (options.sort === 'space') {
    const sections: AgentSection[] = []
    for (const row of rows) {
      const last = sections[sections.length - 1]
      if (last && last.id === row.workspaceId) last.rows.push(row)
      else {
        const existing = sections.find(section => section.id === row.workspaceId)
        if (existing) existing.rows.push(row)
        else sections.push({ id: row.workspaceId, status: null, label: options.spaceName(row.workspaceId) || row.workspaceId, rows: [row] })
      }
    }
    return sections
  }
  const order: AgentGroup[] = ['working', 'blocked', 'done', 'idle']
  return order
    .map(status => ({ id: status, status, label: '', rows: rows.filter(row => groupOf(row.status) === status).sort((a, b) => b.since - a.since) }))
    .filter(section => section.rows.length > 0)
}

/** "now", "45s", "8m", "1h", "3d": how long an agent has been in its state. */
export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 10) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// ---- command palette ----

export interface PaletteItem {
  id: string
  kind: 'space' | 'chat' | 'action'
  label: string
  detail?: string
  /** Extra words it is found by. */
  keywords?: string
}

/**
 * The palette's matches for a query: every word must appear (in the label,
 * detail or keywords); labels that start with the query come first, then
 * actions, spaces and chats in that order. An empty query lists actions
 * first, then spaces, then recent chats.
 */
export function paletteMatches(items: PaletteItem[], query: string, limit = 60): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const rank = { action: 0, space: 1, chat: 2 } as const
  const scored: Array<{ item: PaletteItem; score: [number, number, number] }> = []
  items.forEach((item, index) => {
    const hay = `${item.label} ${item.detail || ''} ${item.keywords || ''}`.toLowerCase()
    if (!words.every(word => hay.includes(word))) return
    const starts = words.length && item.label.toLowerCase().startsWith(words.join(' ')) ? 0 : 1
    scored.push({ item, score: [starts, rank[item.kind], index] })
  })
  scored.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.score[2] - b.score[2])
  return scored.slice(0, limit).map(entry => entry.item)
}

/** Ctrl+Shift+P (Cmd+Shift+P on a Mac): Herdr App's command palette key. */
export function isPaletteKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p'
}
