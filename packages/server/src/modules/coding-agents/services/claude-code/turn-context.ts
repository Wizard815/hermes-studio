import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
