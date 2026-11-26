import { isAbsolute } from 'node:path'
import { getSession } from '../../repositories/session-store'
import { getRecordedUsageTotals, getUsage } from '../../repositories/usage-store'
import { getModelContextLength } from '../../public/provider-runtime'
import { isBuiltinEkkoAgent } from '../../contracts/history-source'
import { runCli, type CliRunner } from './cli'

/**
 * What an Agents card shows beyond herdr's own pane state (Roundup's agent
 * cards): the chat's model, a context meter from Studio's usage records
 * (latest reported usage against the model's context window, the same
 * estimate `/context` gives) and the branch of the pane's folder.
 */

export interface AgentContext {
  sessionId: string
  agent: string
  model: string
  provider: string
  profile: string
  /** Tokens in the context now (estimate); null when no agent reported usage. */
  contextTokens: number | null
  contextWindow: number | null
  inputTokens: number
  outputTokens: number
}

const CODING = new Set(['codex', 'pi', 'grok', 'opencode', 'dsh', 'claude', 'claude-code', 'claude_code', 'cursor', 'antigravity', 'qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'])
/** Their usage is an aggregate per turn, not a snapshot of the context. */
const NO_CONTEXT = new Set(['cursor', 'antigravity'])

export interface UsageRow { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; model?: string; created_at?: number }

/** Context in use from the latest usage row: cached input counts too for coding agents. */
export function contextFromUsage(latest: UsageRow | undefined, coding: boolean): number | null {
  if (!latest) return null
  const n = (value: unknown) => Number(value || 0)
  return coding
    ? n(latest.input_tokens) + n(latest.cache_read_tokens) + n(latest.cache_write_tokens) + n(latest.output_tokens)
    : n(latest.input_tokens) + n(latest.output_tokens)
}

export function agentContext(sessionId: string): AgentContext | null {
  const row = getSession(sessionId)
  if (!row) return null
  const agent = String(row.agent || '')
  const coding = !isBuiltinEkkoAgent(agent) && (row.source === 'coding_agent' || CODING.has(agent))
  const source = isBuiltinEkkoAgent(agent) ? 'ekko_agent' : coding ? 'coding_agent' : 'hermes'
  const latest = getUsage(sessionId, coding ? 'coding_agent' : undefined) as UsageRow | undefined
  const totals = getRecordedUsageTotals(sessionId, source)
  const model = String(latest?.model || row.model || '')
  const contextTokens = NO_CONTEXT.has(agent) ? null : contextFromUsage(latest, coding)
  let contextWindow: number | null = null
  if (model) {
    try {
      const value = getModelContextLength({ profile: row.profile || 'default', model, provider: row.provider || undefined })
      contextWindow = Number.isFinite(value) && value > 0 ? value : null
    } catch { contextWindow = null }
  }
  return {
    sessionId,
    agent,
    model,
    provider: String(row.provider || ''),
    profile: String(row.profile || 'default'),
    contextTokens,
    contextWindow,
    inputTokens: totals.inputTokens + (totals.cacheReadTokens || 0) + (totals.cacheWriteTokens || 0),
    outputTokens: totals.outputTokens,
  }
}

/** The branch checked out in a folder ('' when it is not a git checkout). */
export async function gitBranch(cwd: string, run: CliRunner = runCli): Promise<string> {
  if (!cwd || !isAbsolute(cwd)) return ''
  const named = await run('git', ['-C', cwd, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeoutMs: 3000 })
  if (named.code === 0 && named.stdout.trim()) return named.stdout.trim()
  const detached = await run('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 3000 })
  return detached.code === 0 && detached.stdout.trim() ? `@${detached.stdout.trim()}` : ''
}

export async function agentDetails(input: { sessions?: unknown; folders?: unknown }, run: CliRunner = runCli) {
  const sessions = (Array.isArray(input.sessions) ? input.sessions : []).map(String).filter(Boolean).slice(0, 100)
  const folders = [...new Set((Array.isArray(input.folders) ? input.folders : []).map(String).filter(Boolean))].slice(0, 50)
  const contexts: Record<string, AgentContext> = {}
  for (const id of sessions) {
    const context = agentContext(id)
    if (context) contexts[id] = context
  }
  const branches: Record<string, string> = {}
  await Promise.all(folders.map(async folder => { branches[folder] = await gitBranch(folder, run) }))
  return { contexts, branches }
}
