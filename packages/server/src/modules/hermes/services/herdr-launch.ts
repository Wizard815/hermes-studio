import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Shape herdr's bridge expects from a session launch (structural match). */
export interface HermesHerdrLaunch {
  /** Resuming without the model (when Hermes refuses `-m` that differs from the session's start), then `/model`. */
  retryArgs?: string[]
  afterRetryInput?: string
  agentId: string
  command: string
  args: string[]
  env: Record<string, string>
  workspaceDir: string
  provider: string
  model: string
}

/**
 * The hermes CLI: `HERMES_BIN` (Studio's Docker image sets it), the
 * installer's copy, or one on PATH. Null when there is none.
 */
export function findHermesCli(home = homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.HERMES_BIN || '',
    join(home, '.local', 'bin', 'hermes'),
    ...String(env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'hermes')),
  ].filter(Boolean)
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

export function hermesCliPath(home = homedir()): string {
  return findHermesCli(home) || 'hermes'
}

/** Whether the hermes CLI is present (herdr can only host it then). */
export function hermesCliAvailable(home = homedir()): boolean {
  return findHermesCli(home) !== null
}

/** Hermes's provider name for a Studio provider key (Studio's Claude sign-in runs as `anthropic`, as in Studio's own Hermes runs). */
export function hermesProviderFor(provider: string | null | undefined): string {
  const value = String(provider || '').trim()
  if (value === 'global') return ''
  return value === 'claude-oauth' ? 'anthropic' : value
}

/** `-m <model> [--provider <provider>]` for a chat with its own model; nothing for the profile default. */
export function hermesModelArgs(model?: string | null, provider?: string | null): string[] {
  const id = String(model || '').trim()
  if (!id) return []
  const route = hermesProviderFor(provider)
  return ['-m', id, ...(route ? ['--provider', route] : [])]
}

/**
 * A chat's model as the CLI should ask for it. With Studio's model gateway the
 * profile's Hermes config has one provider (`ekkostudio`) and models are gateway
 * routes such as `deepseek/deepseek-v4`; `-m <route>` alone picks one.
 */
export interface ModelRouteArgs { model: string; provider?: string }
function routeArgs(route: ModelRouteArgs | null | undefined, model?: string | null, provider?: string | null): string[] {
  return route?.model ? hermesModelArgs(route.model, route.provider) : hermesModelArgs(model, provider)
}

/**
 * The pane's Hermes home: the chat's profile folder (as Studio's own Hermes
 * runs use), so the CLI reads that profile's config (its default model) and
 * sessions. Empty when no profile resolver is given.
 */
function profileEnv(profile: string | null | undefined, profileHome?: (profile: string) => string): Record<string, string> {
  if (!profileHome) return {}
  const home = profileHome(String(profile || '').trim() || 'default')
  return home ? { HERMES_HOME: home } : {}
}

/**
 * Start a fresh `hermes chat` pane in herdr; herdr's hermes integration
 * reports the new session id, which links (or imports) the Studio chat.
 * It runs in the profile herdr uses (Studio's, unless pinned) on that
 * profile's default model, unless a model was picked for it.
 */
export function hermesNewChatLaunch(workspace?: string | null, options: {
  profile?: string | null
  provider?: string | null
  model?: string | null
  profileHome?: (profile: string) => string
  /** How the CLI reaches that model (Studio's model gateway route); defaults to the model itself. */
  route?: ModelRouteArgs | null
} = {}): HermesHerdrLaunch {
  return {
    agentId: 'hermes',
    command: hermesCliPath(),
    args: ['chat', ...routeArgs(options.route, options.model, options.provider)],
    env: profileEnv(options.profile, options.profileHome),
    workspaceDir: workspace || homedir(),
    provider: options.model ? String(options.provider || '') : '',
    model: String(options.model || ''),
  }
}

/**
 * Open a Studio Hermes chat as a `hermes chat` pane in herdr. Studio drives
 * the Hermes agent with the Studio session id as the agent session id, so the
 * CLI resumes the same conversation; a chat imported from herdr keeps the
 * agent's own session id in `agent_native_session_id`, which wins here.
 * `--create-if-missing` covers a chat whose first run has not happened yet.
 * The pane runs in the chat's profile and on the chat's model (Studio's model
 * picker for this chat; none: the profile's default model).
 */
export function hermesInteractiveLaunch(session: {
  id: string
  agent_native_session_id?: string | null
  workspace?: string | null
  provider?: string | null
  model?: string | null
  profile?: string | null
}, profileHome?: (profile: string) => string, route?: ModelRouteArgs | null): HermesHerdrLaunch {
  const resume = ['chat', '--resume', hermesSessionIdFor(session), '--create-if-missing']
  const modelArgs = routeArgs(route, session.model, session.provider)
  return {
    agentId: 'hermes',
    command: hermesCliPath(),
    args: [...resume, ...modelArgs],
    // Hermes keeps the model a session started with: `-m` with another model (picked in Studio
    // or with /model since) is refused on resume. Then the pane resumes as it is and switches.
    ...(modelArgs.length ? { retryArgs: resume, afterRetryInput: `/model ${modelArgs.slice(1).join(' ')}` } : {}),
    env: profileEnv(session.profile, profileHome),
    workspaceDir: session.workspace || homedir(),
    provider: session.provider || '',
    model: session.model || '',
  }
}

/** The Hermes session a Studio Hermes chat runs as. */
export function hermesSessionIdFor(session: { id: string; agent_native_session_id?: string | null }): string {
  return session.agent_native_session_id || session.id
}
