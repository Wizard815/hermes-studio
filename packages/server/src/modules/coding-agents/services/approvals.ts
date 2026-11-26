import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getWebUiHome } from '../../studio/public/config'
import { parseCleanRoomCommand } from './cleanroom'

/**
 * Whether coding agents ask before they act in Studio chats. Each agent's own
 * rules decide what needs asking (Claude Code's permissions, Codex's approval
 * policy, an ACP agent's permission requests); Studio shows the question as
 * its approval card. "auto" lets an agent act without asking (yolo).
 */
export type AgentApprovalMode = 'ask' | 'guarded' | 'auto'

export interface AgentApprovalSettings {
  /** Agents not on the default "ask" (see approval-policy.ts for what each mode asks). */
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
      if (/^[a-z0-9-]{1,40}$/.test(id) && (mode === 'ask' || mode === 'guarded' || mode === 'auto')) agents[id] = mode
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
    if (mode !== 'ask' && mode !== 'guarded' && mode !== 'auto') throw Object.assign(new Error('Approval mode must be ask, guarded or auto'), { status: 400 })
    current.agents[id] = mode
  }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`)
  renameSync(temp, file)
  return current
}

export function agentApprovalMode(agentId: string, file?: string): AgentApprovalMode {
  return readAgentApprovalSettings(file).agents[agentId] || 'ask'
}

/**
 * Whether the agent runs in its asking mode (ask and guarded: its requests
 * reach Studio, which shows the ones the mode cares about). "auto" is yolo.
 */
export function agentAsksBeforeActing(agentId: string, file?: string): boolean {
  return agentApprovalMode(agentId, file) !== 'auto'
}

/**
 * One chat's own approval mode, set by `/yolo` in that chat. It wins over the
 * agent's mode (Settings) for that chat only; without one the chat follows the
 * agent. Kept on disk so a Studio restart keeps the chat as it was.
 */
function chatSettingsFile(): string {
  return join(getWebUiHome(), 'coding-agent', 'chat-approvals.json')
}

function readChatApprovalModes(file: string): Record<string, AgentApprovalMode> {
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const chats: Record<string, AgentApprovalMode> = {}
    for (const [id, mode] of Object.entries(raw?.chats || {})) {
      if (id && (mode === 'ask' || mode === 'guarded' || mode === 'auto')) chats[id] = mode
    }
    return chats
  } catch {
    return {}
  }
}

export function chatApprovalOverride(sessionId: string | undefined, file = chatSettingsFile()): AgentApprovalMode | undefined {
  return sessionId ? readChatApprovalModes(file)[sessionId] : undefined
}

/** Set (or with null, clear) one chat's own approval mode. */
export function setChatApprovalOverride(sessionId: string, mode: AgentApprovalMode | null, file = chatSettingsFile()): void {
  const chats = readChatApprovalModes(file)
  if (mode) chats[sessionId] = mode
  else delete chats[sessionId]
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ chats }, null, 2)}\n`)
  renameSync(temp, file)
}

/** The approval mode a chat's agent runs with: the chat's own (`/yolo`), else the agent's. */
export function chatApprovalMode(agentId: string, sessionId?: string, file?: string, chatFile?: string): AgentApprovalMode {
  return chatApprovalOverride(sessionId, chatFile) || agentApprovalMode(agentId, file)
}

/**
 * `/yolo` in a coding-agent chat: the first turns this chat to "auto" (the
 * agent acts without asking); the next puts it back on the agent's own mode.
 * When the agent itself is already on "auto", `/yolo` turns asking on for
 * this chat instead, so the command always switches something.
 */
export function toggleChatYolo(agentId: string, sessionId: string, file?: string, chatFile?: string): { mode: AgentApprovalMode; previous: AgentApprovalMode; yolo: boolean } {
  const previous = chatApprovalMode(agentId, sessionId, file, chatFile)
  const agentMode = agentApprovalMode(agentId, file)
  if (chatApprovalOverride(sessionId, chatFile)) setChatApprovalOverride(sessionId, null, chatFile)
  else setChatApprovalOverride(sessionId, agentMode === 'auto' ? 'ask' : 'auto', chatFile)
  const mode = chatApprovalMode(agentId, sessionId, file, chatFile)
  return { mode, previous, yolo: mode === 'auto' }
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


/**
 * Whether this run's agent asks before acting. A clean room never asks: the
 * agent has full permission inside its container (the container is the limit).
 */
export function launchAsks(launch: { agentId: string; command: string; approvalRequired?: boolean; sessionId?: string }): boolean {
  if (parseCleanRoomCommand(launch.command)) return false
  return launch.approvalRequired === true || chatApprovalMode(launch.agentId, launch.sessionId) !== 'auto'
}
