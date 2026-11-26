import { basename } from 'node:path'

export const NODE_ENVIRONMENT_MISSING_CODE = 'node_environment_missing'
export const CODING_AGENT_NOT_INSTALLED_CODE = 'coding_agent_not_installed'

export const NODE_ENVIRONMENT_MISSING_MESSAGE = 'Node/npm environment was not detected. Please install Node.js and try again.'

/** What went wrong when Studio ran a program (docs/native-coding-agents.md, "What a failed check says"). */
export type SpawnFailure =
  | { kind: 'node_missing' }
  | { kind: 'command_missing'; command: string }
  | { kind: 'other' }

const NODE_PROGRAMS = new Set(['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd'])

/**
 * Node or npm itself is missing only when the program that was not found is node or npm,
 * or a script's `#!/usr/bin/env node` line found no node. Any other ENOENT is that
 * program missing (for example the agent's own CLI), not Node.
 */
export function classifySpawnError(err: any): SpawnFailure {
  if (err?.code === NODE_ENVIRONMENT_MISSING_CODE) return { kind: 'node_missing' }
  const text = [
    typeof err?.code === 'string' ? err.code : '',
    err?.message,
    typeof err?.stderr === 'string' ? err.stderr : '',
    typeof err?.stdout === 'string' ? err.stdout : '',
  ].filter(Boolean).join('\n').toLowerCase()
  const missingPath = typeof err?.path === 'string' ? err.path : ''
  const spawned = missingPath || (/spawn (\S+) enoent/.exec(text)?.[1] ?? '')
  const program = basename(spawned.replace(/\\/g, '/')).toLowerCase()
  if (NODE_PROGRAMS.has(program)) return { kind: 'node_missing' }
  if (/\b(npm|node): command not found|\b(npm|node) not found|env: ['‘"]?node['’"]?: no such file/.test(text)) return { kind: 'node_missing' }
  if (err?.code === 'ENOENT' || /spawn \S+ enoent/.test(text)) return { kind: 'command_missing', command: spawned ? basename(spawned.replace(/\\/g, '/')) : '' }
  return { kind: 'other' }
}

export function codingAgentNotInstalledMessage(agentName: string): string {
  return `${agentName} isn't installed. Install it from Agent Manager.`
}

/** The message for a missing program, or '' when the error is something else. */
export function spawnFailureMessage(failure: SpawnFailure, agentName?: string): string {
  if (failure.kind === 'node_missing') return NODE_ENVIRONMENT_MISSING_MESSAGE
  if (failure.kind !== 'command_missing') return ''
  if (agentName) return codingAgentNotInstalledMessage(agentName)
  return `${failure.command || 'A program Studio needs'} was not found. Check that it is installed and on PATH.`
}

export function spawnFailureCode(failure: SpawnFailure, agentName?: string): string | undefined {
  if (failure.kind === 'node_missing') return NODE_ENVIRONMENT_MISSING_CODE
  if (failure.kind === 'command_missing' && agentName) return CODING_AGENT_NOT_INSTALLED_CODE
  return undefined
}
