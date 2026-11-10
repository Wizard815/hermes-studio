import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Shape herdr's bridge expects from a session launch (structural match). */
export interface HermesHerdrLaunch {
  agentId: string
  command: string
  args: string[]
  env: Record<string, string>
  workspaceDir: string
  provider: string
  model: string
}

/** The hermes CLI: the installer's copy, or PATH when it lives elsewhere. */
export function hermesCliPath(home = homedir()): string {
  const installed = join(home, '.local', 'bin', 'hermes')
  return existsSync(installed) ? installed : 'hermes'
}

/** Whether the installed hermes CLI is present (herdr can only host it then). */
export function hermesCliAvailable(home = homedir()): boolean {
  return existsSync(join(home, '.local', 'bin', 'hermes'))
}

/** Start a fresh `hermes chat` pane in herdr; herdr's hermes integration
 * reports the new session id, which links (or imports) the Studio chat. */
export function hermesNewChatLaunch(workspace?: string | null): HermesHerdrLaunch {
  return {
    agentId: 'hermes',
    command: hermesCliPath(),
    args: ['chat'],
    env: {},
    workspaceDir: workspace || homedir(),
    provider: '',
    model: '',
  }
}

/**
 * Open a Studio Hermes chat as a `hermes chat` pane in herdr. Studio drives
 * the Hermes agent with the Studio session id as the agent session id, so the
 * CLI resumes the same conversation; a chat imported from herdr keeps the
 * agent's own session id in `agent_native_session_id`, which wins here.
 * `--create-if-missing` covers a chat whose first run has not happened yet.
 */
export function hermesInteractiveLaunch(session: {
  id: string
  agent_native_session_id?: string | null
  workspace?: string | null
  provider?: string | null
  model?: string | null
}): HermesHerdrLaunch {
  return {
    agentId: 'hermes',
    command: hermesCliPath(),
    args: ['chat', '--resume', session.agent_native_session_id || session.id, '--create-if-missing'],
    env: {},
    workspaceDir: session.workspace || homedir(),
    provider: session.provider || '',
    model: session.model || '',
  }
}
