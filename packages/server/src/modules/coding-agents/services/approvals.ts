import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getWebUiHome } from '../../studio/public/config'

/**
 * Whether coding agents ask before they act in Studio chats. Each agent's own
 * rules decide what needs asking (Claude Code's permissions, Codex's approval
 * policy, an ACP agent's permission requests); Studio shows the question as
 * its approval card. "auto" lets an agent act without asking (yolo).
 */
export type AgentApprovalMode = 'ask' | 'auto'

export interface AgentApprovalSettings {
  /** Agents set to "auto"; every other agent asks. */
  agents: Record<string, AgentApprovalMode>
}

function settingsFile(): string {
  return join(getWebUiHome(), 'coding-agent', 'approvals.json')
}

export function readAgentApprovalSettings(file = settingsFile()): AgentApprovalSettings {
  try {
    if (!existsSync(file)) return { agents: {} }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const agents: Record<string, AgentApprovalMode> = {}
    for (const [id, mode] of Object.entries(raw?.agents || {})) {
      if (/^[a-z0-9-]{1,40}$/.test(id) && (mode === 'ask' || mode === 'auto')) agents[id] = mode
    }
    return { agents }
  } catch {
    return { agents: {} }
  }
}

export function writeAgentApprovalSettings(input: unknown, file = settingsFile()): AgentApprovalSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as { agents?: Record<string, unknown> }
  const current = readAgentApprovalSettings(file)
  for (const [id, mode] of Object.entries(raw.agents || {})) {
    if (!/^[a-z0-9-]{1,40}$/.test(id)) throw Object.assign(new Error('Invalid agent id'), { status: 400 })
    if (mode !== 'ask' && mode !== 'auto') throw Object.assign(new Error('Approval mode must be ask or auto'), { status: 400 })
    current.agents[id] = mode
  }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`)
  renameSync(temp, file)
  return current
}

/** Asking is the default; only an agent set to "auto" acts without asking. */
export function agentAsksBeforeActing(agentId: string, file?: string): boolean {
  return readAgentApprovalSettings(file).agents[agentId] !== 'auto'
}

/**
 * Flags that let an agent act without asking. Agents that ask drop them: in a terminal
 * (herdr) the agent asks there; in a Studio chat it asks through Studio.
 */
const SKIP_APPROVAL_FLAGS = new Set(['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--always-approve', '--force'])

export function withApprovals(args: string[]): string[] {
  return args.filter(arg => !SKIP_APPROVAL_FLAGS.has(arg))
}

/**
 * Settings that let an agent act without asking, by agent. OpenCode's
 * Studio config allows every tool; in a terminal it asks instead
 * (OPENCODE_PERMISSION is merged over its config).
 */
export function withApprovalsEnv(agentId: string, env: Record<string, string>): Record<string, string> {
  if (agentId === 'opencode') return { ...env, OPENCODE_PERMISSION: JSON.stringify({ '*': 'ask' }) }
  // Studio's Pi extension asks before commands and file writes.
  if (agentId === 'pi') return { ...env, HERMES_PI_ASK: '1' }
  return env
}

