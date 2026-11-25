import { isAbsolute, relative, resolve } from 'node:path'
import { trustPatternMatches, type TrustKind, type TrustRule } from '../../../../../../shared/watcher'

/** Where an approval comes from: the chat, its agent and folder, and the Agent work tasks on that chat. */
export interface TrustContext {
  sessionId?: string
  agentId?: string
  folder?: string
  taskIds?: string[]
}

/** What the agent wants: a command, file writes (every path must match), or a tool by name. */
export interface TrustRequest {
  kind: TrustKind
  values: string[]
}

function sameOrInside(path: string, folder: string): boolean {
  if (!path || !folder) return false
  const rel = relative(resolve(folder), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function scopeMatches(rule: Pick<TrustRule, 'scope' | 'target'>, context: TrustContext): boolean {
  switch (rule.scope) {
    case 'chat': return !!context.sessionId && rule.target === context.sessionId
    case 'agent': return !!context.agentId && rule.target === context.agentId
    case 'task': return !!context.taskIds?.includes(rule.target)
    case 'folder': return !!context.folder && sameOrInside(context.folder, rule.target)
    default: return false
  }
}

/** The first rule (not expired) that allows this request here, or null. */
export function findTrustRule(rules: TrustRule[], context: TrustContext, request: TrustRequest, now: number): TrustRule | null {
  const values = request.values.map(value => String(value || '').trim()).filter(Boolean)
  if (!values.length) return null
  for (const rule of rules) {
    if (rule.expiresAt && rule.expiresAt <= now) continue
    if (rule.kind !== request.kind) continue
    if (!scopeMatches(rule, context)) continue
    if (values.every(value => trustPatternMatches(rule.pattern, value))) return rule
  }
  return null
}

/** A coding agent's action (approval-policy.ts AgentAction) as a trust request. */
export function trustRequestFromAction(action: { kind: string; command?: string; paths?: string[] } | undefined, toolName = ''): TrustRequest | null {
  if (action?.kind === 'command' && action.command) return { kind: 'command', values: [action.command] }
  if (action?.kind === 'write' && action.paths?.length) return { kind: 'write', values: action.paths }
  if (toolName) return { kind: 'tool', values: [toolName] }
  return null
}
