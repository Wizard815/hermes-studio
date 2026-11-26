import type { WatcherAction } from '../../../../../../shared/watcher'
import { WatcherService, type WatcherDeps } from './service'
import type { WatcherEventInput } from './store'
import type { TrustContext, TrustRequest } from './trust'

/** Process-wide watcher; bootstrap/watcher.ts sets it up. Every helper is a no-op before that. */
let service: WatcherService | null = null

export function configureWatcher(deps: WatcherDeps): WatcherService {
  service = new WatcherService(deps)
  service.prune()
  return service
}

export function getWatcher(): WatcherService {
  if (!service) throw Object.assign(new Error('The watcher is not set up'), { status: 503 })
  return service
}

export function closeWatcher(): void {
  service = null
  requested.clear()
  resolved.clear()
}

/** Record an event; never throws (a guard's alert must not break what it guards). */
export function recordWatcherEvent(input: WatcherEventInput): void {
  try { service?.record(input) } catch { /* alerts never break a run */ }
}

/** The trust rule that answers this approval, or null. Never throws. */
export function watcherTrusts(context: TrustContext, request: TrustRequest | null, note = ''): boolean {
  try { return !!service?.trusts(context, request, note) } catch { return false }
}

/** The chat's own approval mode is auto (`/yolo`, or its Agent work task's mode). */
export function chatAutoApproves(sessionId: string): boolean {
  try { return service?.chatMode(sessionId) === 'auto' } catch { return false }
}

/** Settings → Watcher → pipelock: the proxy clean rooms go out through, when on. */
export function pipelockProxy(): string {
  try {
    const pipelock = service?.settings().extras.pipelock
    return pipelock?.enabled ? pipelock.proxyUrl : ''
  } catch { return '' }
}

// --- Approvals from every chat type (the chat-run event stream) -------------

const requested = new Map<string, { text: string; action?: WatcherAction; agent: string }>()
const resolved = new Set<string>()

function remember<K, V>(map: Map<K, V> | Set<K>, key: K, value?: V) {
  if (map instanceof Map) map.set(key, value as V)
  else map.add(key)
  if (map.size > 500) map.delete(map.keys().next().value as K)
}

export const AGENT_NAMES: Record<string, string> = {
  bridge: 'Hermes', hermes: 'Hermes', ekko: 'Ekko', 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi', grok: 'Grok', opencode: 'OpenCode',
  dsh: 'DSH', cursor: 'Cursor', antigravity: 'Antigravity', qwen: 'Qwen Code', kimi: 'Kimi Code', codebuddy: 'CodeBuddy', qoder: 'Qoder', copilot: 'Copilot', zcode: 'ZCode',
}

function text(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** An approval's own `trust_action` (e.g. a Home Assistant service from the Hermes bridge), when valid. */
export function givenTrustAction(given: unknown): WatcherAction | undefined {
  const action = given as { kind?: unknown; value?: unknown } | null
  if (action && typeof action === 'object' && ['command', 'write', 'tool'].includes(String(action.kind)) && typeof action.value === 'string' && action.value) {
    return { kind: action.kind as WatcherAction['kind'], value: action.value.slice(0, 2000) }
  }
  return undefined
}

/** What an approval event is about, as a trust action. */
export function approvalAction(payload: Record<string, any>): WatcherAction | undefined {
  const given = givenTrustAction(payload.trust_action)
  if (given) return given
  if (typeof payload.command === 'string' && payload.command.trim()) return { kind: 'command', value: payload.command.trim().slice(0, 2000) }
  const tool = text(payload.tool, 200)
  return tool ? { kind: 'tool', value: tool } : undefined
}

/**
 * A chat run event (sockets/chat-run.ts, the one stream every chat type's
 * events pass through): approval asked, approved or denied.
 */
export function observeWatcherChatEvent(sessionId: string, event: string, payload: Record<string, any> | undefined, agent = ''): void {
  if (!service || !sessionId || !payload) return
  try {
    const approvalId = text(payload.approval_id, 200)
    if (!approvalId) return
    if (event === 'approval.requested') {
      if (requested.has(approvalId)) return
      const who = AGENT_NAMES[agent] || AGENT_NAMES[text(payload.source, 40)] || ''
      const what = text(payload.command) || text(payload.title) || text(payload.description) || 'an action'
      const action = approvalAction(payload)
      const agentId = agent === 'bridge' ? 'hermes' : agent || text(payload.source, 40)
      remember(requested, approvalId, { text: what, action, agent: agentId })
      service.record({ kind: 'approval_asked', severity: 'warn', sessionId, agent: agentId, text: `${who || 'The agent'} asks to run: ${what}`, action })
      return
    }
    if (event !== 'approval.resolved' || payload.resolved === false || resolved.has(approvalId)) return
    remember(resolved, approvalId)
    const asked = requested.get(approvalId)
    const what = asked?.text || 'an action'
    const choice = String(payload.choice || 'deny').toLowerCase()
    const reason = text(payload.reason, 160)
    if (choice === 'deny') {
      service.record({ kind: 'approval_denied', severity: 'block', sessionId, agent: asked?.agent, action: asked?.action, text: `Denied${reason ? ` (${reason})` : ''}: ${what}` })
    } else {
      service.record({ kind: 'approval_approved', severity: 'info', sessionId, agent: asked?.agent, action: asked?.action, text: `Approved${choice === 'session' || choice === 'always' ? ' for this chat' : ''}: ${what}` })
    }
  } catch { /* alerts never break a run */ }
}

export { WatcherService } from './service'
export { WatcherStore } from './store'
export { WatcherConfigFile, WatcherInputError } from './config'
export { WatcherExtras } from './extras'
export { trustRequestFromAction } from './trust'
export type { WatcherEventInput } from './store'
export type { TrustContext, TrustRequest } from './trust'
