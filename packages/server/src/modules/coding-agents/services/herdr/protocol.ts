/**
 * Herdr socket protocol shapes used by Studio, plus the mapping between herdr
 * agent kinds and Studio coding-agent runtimes.
 *
 * Only the fields Studio reads are typed. Herdr asks JSON clients to ignore
 * unknown fields, so everything else passes through untouched.
 */

export type HerdrAgentStatus = 'working' | 'blocked' | 'done' | 'idle' | 'unknown'

export interface HerdrAgentSession {
  agent?: string
  kind?: 'id' | 'path' | string
  source?: string
  value?: string
}

export interface HerdrPane {
  pane_id: string
  workspace_id: string
  tab_id?: string
  terminal_id?: string
  agent?: string
  agent_status?: HerdrAgentStatus
  agent_session?: HerdrAgentSession
  cwd?: string
  foreground_cwd?: string
  focused?: boolean
  label?: string
  terminal_title_stripped?: string
}

export interface HerdrWorkspace {
  workspace_id: string
  label?: string
  agent_status?: HerdrAgentStatus
  focused?: boolean
  pane_count?: number
  tab_count?: number
}

export interface HerdrSnapshot {
  version?: string
  protocol?: number
  focused_workspace_id?: string | null
  focused_pane_id?: string | null
  workspaces: HerdrWorkspace[]
  panes: HerdrPane[]
}

export interface HerdrResponse<T = unknown> {
  id: string
  result?: T
  error?: { code?: string; message?: string }
}

export interface HerdrEvent {
  event: string
  data?: Record<string, unknown>
}

/**
 * Lifecycle events that can change what Studio shows. Focus events keep the
 * focused pane current, so Studio's chat follows switches made inside herdr.
 */
export const HERDR_LIFECYCLE_EVENTS = [
  'workspace.created', 'workspace.updated', 'workspace.renamed', 'workspace.closed', 'workspace.focused',
  'tab.created', 'tab.closed', 'tab.focused',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.exited', 'pane.moved', 'pane.agent_detected', 'pane.focused',
] as const

/** Studio coding-agent runtime → herdr `agent start --kind` value. */
const STUDIO_TO_HERDR: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
  opencode: 'opencode',
  cursor: 'cursor',
  antigravity: 'agy',
  qwen: 'qwen',
  kimi: 'kimi',
  qoder: 'qodercli',
  copilot: 'copilot',
  hermes: 'hermes',
  // herdr has no detection for these CLIs: Studio reports the pane as the agent itself
  // (see HERDR_UNDETECTED_KINDS) under the CLI's own name.
  codebuddy: 'codebuddy',
  zcode: 'zcode',
}

/**
 * Kinds herdr cannot detect or integrate with (not in herdr's agent list). Studio
 * links their panes to their chats itself and reports the pane to herdr under this
 * name while the agent runs; herdr cannot tell their state, so it stays 'unknown'.
 * herdr ignores an unknown name while a shell is in the foreground, so their
 * waiting panes report as Studio's chat agent (`chatAgentLabel`) instead.
 */
export const HERDR_UNDETECTED_KINDS: ReadonlySet<string> = new Set(['codebuddy', 'zcode'])

/** Whether herdr detects this kind on its own (its screen manifests and hooks). */
export function herdrDetectsKind(kind: string | null | undefined): boolean {
  return !!kind && !HERDR_UNDETECTED_KINDS.has(kind)
}

/**
 * Studio agents herdr shows through Studio's chat client in the chat's waiting
 * pane, not their own CLI: Ekko (Studio's own agent) and DSH, which Studio runs
 * only over ACP (its Studio profile, patches, approvals and session store are
 * for the ACP server; DSH has no terminal UI Studio could resume a chat in).
 */
export const HERDR_STUDIO_CLIENT_AGENTS: ReadonlySet<string> = new Set(['ekko', 'ekko-agent', 'dsh'])

/** Herdr agent labels (detected or reported) → Studio runtime id. */
const HERDR_TO_STUDIO: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
  opencode: 'opencode',
  cursor: 'cursor',
  agy: 'antigravity',
  antigravity: 'antigravity',
  'antigravity-cli': 'antigravity',
  qwen: 'qwen',
  kimi: 'kimi',
  qodercli: 'qoder',
  copilot: 'copilot',
  hermes: 'hermes',
  codebuddy: 'codebuddy',
  zcode: 'zcode',
}

export function herdrKindForStudioAgent(agentId: string): string | null {
  return STUDIO_TO_HERDR[agentId] ?? null
}

export function studioAgentForHerdrAgent(agent: string | undefined): string | null {
  if (!agent) return null
  return HERDR_TO_STUDIO[agent.toLowerCase()] ?? null
}

export function isHerdrStatus(value: unknown): value is HerdrAgentStatus {
  return value === 'working' || value === 'blocked' || value === 'done' || value === 'idle' || value === 'unknown'
}

/** Native session id reported by an official herdr integration, if any. */
export function nativeSessionIdOf(pane: HerdrPane): string | null {
  const session = pane.agent_session
  if (!session?.value) return null
  if (session.kind === 'path') {
    // Path references end in `<id>.jsonl` for Claude and `rollout-...-<id>.jsonl` for Codex.
    const base = session.value.split(/[\\/]/).pop() || ''
    const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
    return match ? match[1] : null
  }
  return session.value
}

export function transcriptPathOf(pane: HerdrPane): string | null {
  return pane.agent_session?.kind === 'path' && pane.agent_session.value ? pane.agent_session.value : null
}

export function normalizeSnapshot(raw: any): HerdrSnapshot {
  const snapshot = raw?.snapshot ?? raw ?? {}
  return {
    version: typeof snapshot.version === 'string' ? snapshot.version : undefined,
    protocol: typeof snapshot.protocol === 'number' ? snapshot.protocol : undefined,
    focused_workspace_id: snapshot.focused_workspace_id ?? null,
    focused_pane_id: snapshot.focused_pane_id ?? null,
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces.filter((w: any) => typeof w?.workspace_id === 'string') : [],
    panes: Array.isArray(snapshot.panes)
      ? snapshot.panes.filter((p: any) => typeof p?.pane_id === 'string' && typeof p?.workspace_id === 'string')
      : [],
  }
}

/**
 * A herdr chat runs with Studio's model routing only when it was launched with
 * a real provider; native launches report the provider as 'global'.
 */
export function herdrChatMode(provider: string | null | undefined): 'scoped' | 'global' {
  const value = String(provider || '').trim()
  return value && value !== 'global' ? 'scoped' : 'global'
}
