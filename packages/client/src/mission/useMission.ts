import { computed, reactive, ref } from 'vue'
import { fetchCodingAgentsStatus, type CodingAgentToolStatus } from '@/api/coding-agents'
import type { OrbWorkRef } from '@/api/studio/orb'
import {
  focusHerdrPane,
  launchHerdrAgent,
  type HerdrPaneView,
  type HerdrStatusValue,
  type SpaceFolder,
  type SpaceFolderState,
} from '@/api/coding-agents/herdr'

/** Studio coding agents herdr can host. */
export const HERDR_AGENTS = ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'cursor', 'antigravity', 'qwen', 'kimi', 'qoder', 'copilot']

/** Folder tile palette, shared with herdr-space-folders. Empty is the neutral tile. */
export const FOLDER_PALETTE = ['', 'teal', 'orange', 'blue', 'violet', 'green', 'pink'] as const

const STATUS_RANK: Record<HerdrStatusValue, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 }

/** Most urgent status in a set, the way herdr rolls status up to tabs and workspaces. */
export function rollupStatus(statuses: Array<HerdrStatusValue | undefined>): HerdrStatusValue {
  let best: HerdrStatusValue = 'unknown'
  for (const status of statuses) if (status && STATUS_RANK[status] > STATUS_RANK[best]) best = status
  return best
}

function normalize(path: string, home: string): string {
  return (path.startsWith('~') ? `${home}${path.slice(1)}` : path).replace(/\\/g, '/').replace(/\/+$/, '')
}

function matchesSegment(rule: string, segment: string): boolean {
  if (rule === '*') return true
  if (!rule.includes('*')) return rule === segment
  return new RegExp(`^${rule.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(segment)
}

/** Same rule semantics as the server and herdr-space-folders: deepest match wins. */
export function ruleDepth(rule: string, cwd: string, home: string): number {
  const value = rule.trim()
  if (!value || !cwd) return -1
  const parts = normalize(cwd, home).split('/').filter(Boolean)
  if (value.startsWith('/') || value.startsWith('~')) {
    const ruleParts = normalize(value, home).split('/').filter(Boolean)
    if (ruleParts.length > parts.length) return -1
    return ruleParts.every((part, index) => matchesSegment(part, parts[index])) ? ruleParts.length : -1
  }
  const index = parts.findIndex(part => matchesSegment(value, part))
  return index >= 0 ? index + 1 : -1
}

export function folderOf(state: SpaceFolderState, spaceId: string, cwd: string, home: string): string {
  if (Object.prototype.hasOwnProperty.call(state.of, spaceId)) return state.of[spaceId]
  let best = ''
  let depth = 0
  for (const folder of state.list) {
    for (const rule of folder.rules.split(',')) {
      const d = ruleDepth(rule, cwd, home)
      if (d > depth) { best = folder.id; depth = d }
    }
  }
  return best
}

export function newFolder(partial: Partial<SpaceFolder> = {}): SpaceFolder {
  return {
    id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: 'New folder',
    color: FOLDER_PALETTE[3],
    folded: false,
    start: '',
    rules: '',
    ...partial,
  }
}

const tools = ref<CodingAgentToolStatus[]>([])
let toolsLoading: Promise<void> | null = null

/** Installed agents herdr can run, for the per-card start buttons. */
export function useLaunchTools() {
  if (!toolsLoading) {
    toolsLoading = fetchCodingAgentsStatus()
      .then(status => { tools.value = status.tools.filter(tool => tool.installed && HERDR_AGENTS.includes(tool.id)) })
      .catch(() => { tools.value = [] })
  }
  return { tools: computed(() => tools.value) }
}

const LAUNCHES_KEY = 'herdr_mission_launches_v1'
const launches = reactive<Record<string, string>>((() => {
  try { return JSON.parse(localStorage.getItem(LAUNCHES_KEY) || '{}') } catch { return {} }
})())

/**
 * Start an agent for a card, or go to the one already working on it. The card
 * key maps to the pane it started, so a second click never sends the task twice.
 */
export async function launchForCard(input: {
  key: string
  agentId: string
  title: string
  prompt: string
  workspace?: string
  orb?: OrbWorkRef
  panes: HerdrPaneView[]
}): Promise<{ paneId: string; reused: boolean }> {
  const existing = launches[`${input.key}:${input.agentId}`]
  if (existing && input.panes.some(pane => pane.pane_id === existing)) {
    await focusHerdrPane(existing).catch(() => undefined)
    return { paneId: existing, reused: true }
  }
  const { link } = await launchHerdrAgent({ agentId: input.agentId, title: input.title, prompt: input.prompt, workspace: input.workspace, orb: input.orb })
  launches[`${input.key}:${input.agentId}`] = link.paneId
  try { localStorage.setItem(LAUNCHES_KEY, JSON.stringify(launches)) } catch { /* private mode */ }
  return { paneId: link.paneId, reused: false }
}

/**
 * Link into Studio. Mission at <base>/mission/ shares Studio's origin, so Studio
 * is at <base>. On Mission's own port there is no Studio page to link to.
 */
export function studioUrl(hashPath: string): string | null {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')
  return window.location.pathname.startsWith(`${base}mission`) ? `${base}#${hashPath}` : null
}
