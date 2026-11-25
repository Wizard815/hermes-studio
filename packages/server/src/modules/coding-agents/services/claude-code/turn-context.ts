import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Studio's per-turn context blocks (`<studio_task_plan_context>` and others) for
 * Claude Code go through a UserPromptSubmit hook, not the user's message
 * (docs/harness/herdr.md, "Studio's context blocks"). Claude Code stores hook
 * output as an attachment: the model gets it, but the user's message in the
 * session (a herdr pane's resumed history, `claude --resume`) stays what the
 * user typed. The hook prints the file named by the env var, and nothing when
 * it is unset (a turn typed in the herdr pane).
 */
export const STUDIO_TURN_CONTEXT_ENV = 'STUDIO_TURN_CONTEXT_FILE'
export const STUDIO_TURN_CONTEXT_HOOK_COMMAND = `[ -n "$${STUDIO_TURN_CONTEXT_ENV}" ] && cat "$${STUDIO_TURN_CONTEXT_ENV}" || true`

const HOOK = { type: 'command', command: STUDIO_TURN_CONTEXT_HOOK_COMMAND }

/** Settings with Studio's hook added once, after any UserPromptSubmit hooks the user already has. */
export function withStudioTurnContextHook<T extends Record<string, any>>(settings: T): T {
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {}
  const current = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []
  if (JSON.stringify(current).includes(STUDIO_TURN_CONTEXT_ENV)) return settings
  return { ...settings, hooks: { ...hooks, UserPromptSubmit: [...current, { hooks: [HOOK] }] } }
}

/** `--settings` value for a launch that has no settings file of its own (global mode). */
export function inlineTurnContextSettings(): string {
  return JSON.stringify(withStudioTurnContextHook({}))
}

/** The launch's own settings file already carries the hook (written by a Studio that knows it). */
export function settingsFileHasTurnContextHook(path: string): boolean {
  try { return readFileSync(path, 'utf8').includes(STUDIO_TURN_CONTEXT_ENV) } catch { return false }
}

/** Where a run's turn context goes: next to its prompt file, else under the temp folder. */
export function writeTurnContextFile(runId: string, text: string, promptFile?: string): string {
  const dir = promptFile ? dirname(promptFile) : join(tmpdir(), 'studio-turn-context')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `turn-context-${runId.replace(/[^\w.-]/g, '_')}.md`)
  writeFileSync(path, `${text.trim()}\n`, { mode: 0o600 })
  return path
}

/**
 * A Studio chat elevated to herdr: messages typed in Studio's chat box go into the
 * chat's Claude Code pane (`agent.prompt`), not through a Studio run. The pane is
 * launched with this file in the variable, so the same hook prints Studio's context
 * for those turns: Studio fills the file before it types and empties it when the turn
 * ends. The file existing (empty between turns) is how Studio knows the pane has it.
 */
export function paneTurnContextFile(dir: string, sessionId: string): string {
  return join(dir, `pane-${sessionId.replace(/[^\w.-]/g, '_')}.md`)
}

/** Launch changes that give a chat's Claude Code pane the context file; null when it cannot carry it. */
export function paneTurnContextLaunch(
  launch: { args: string[] },
  file: string,
  options: { cleanRoom?: boolean; platform?: NodeJS.Platform } = {},
): { args: string[]; env: Record<string, string> } | null {
  if ((options.platform ?? process.platform) === 'win32' || options.cleanRoom) return null
  const settingsIndex = launch.args.indexOf('--settings')
  const ownSettings = settingsIndex >= 0 ? String(launch.args[settingsIndex + 1] || '') : ''
  if (ownSettings && !settingsFileHasTurnContextHook(ownSettings)) return null
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '', { mode: 0o600 })
  return {
    args: ownSettings ? [] : ['--settings', inlineTurnContextSettings()],
    env: { [STUDIO_TURN_CONTEXT_ENV]: file },
  }
}

/** Fill (or, with no text, empty) a pane's context file; false when the pane was not launched with one. */
export function setPaneTurnContext(file: string, text: string): boolean {
  if (!existsSync(file)) return false
  writeFileSync(file, text.trim() ? `${text.trim()}\n` : '', { mode: 0o600 })
  return true
}
