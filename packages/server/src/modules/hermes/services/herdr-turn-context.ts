import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateConfigYamlForProfile } from './profiles/config'
import { getProfileDir } from './profiles/profile'

/**
 * Studio's per-turn context for a message Studio's chat box types into an elevated
 * Hermes chat's `hermes chat` pane (docs/harness/herdr.md, "Studio's context blocks").
 *
 * Hermes has a hidden per-turn channel: a plugin's `pre_llm_call` hook may return
 * `{"context": ...}`, which Hermes appends to the model-bound user message only (the
 * stored message `content` stays what was typed). Studio installs a small plugin in
 * the chat's profile (`plugins/studio-turn-context`, enabled in `plugins.enabled`).
 * Before typing, Studio writes the turn's context with the typed text to a file; the
 * hook gives it only to a turn whose message is that text (in that Hermes session),
 * and Studio removes the file when the turn ends. Turns typed in the pane by hand get
 * nothing.
 */
export const HERMES_TURN_CONTEXT_PLUGIN = 'studio-turn-context'

/** The plugin's files; `contextDir` is where Studio writes pending turns. */
export function hermesTurnContextPluginFiles(contextDir: string): Record<string, string> {
  return {
    'plugin.yaml': [
      `name: ${HERMES_TURN_CONTEXT_PLUGIN}`,
      'version: "1.0"',
      'description: Studio\'s per-turn context for messages Studio types into this chat (Hermes Studio herdr panes)',
      'provides_hooks:',
      '  - pre_llm_call',
      '',
    ].join('\n'),
    '__init__.py': `"""Studio's per-turn context for messages Studio's chat box types into a Hermes herdr pane.

Written by Hermes Studio (modules/hermes/services/herdr-turn-context.ts); Studio rewrites it.
Only a turn whose message is the text Studio typed gets the context, and only while
Studio's file for it exists (Studio removes it when the turn ends).
"""
import glob
import json
import os

CONTEXT_DIR = ${JSON.stringify(contextDir)}


def _text(value):
    if isinstance(value, list):
        value = "\\n".join(str(part.get("text", "")) for part in value if isinstance(part, dict) and part.get("type") == "text")
    return " ".join(str(value or "").split())


def _pending():
    found = []
    for path in glob.glob(os.path.join(CONTEXT_DIR, "hermes-*.json")):
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            continue
        if isinstance(data, dict) and data.get("context") and data.get("text"):
            found.append(data)
    return found


def studio_turn_context(session_id="", user_message="", **kwargs):
    try:
        typed = _text(user_message)
        if not typed:
            return None
        matches = [entry for entry in _pending() if _text(entry.get("text")) == typed]
        ids = {str(session_id or ""), str(kwargs.get("conversation_id") or ""), str(kwargs.get("parent_session_id") or "")} - {""}
        own = [entry for entry in matches if ids & {str(item) for item in entry.get("sessionIds") or []}]
        pick = own[0] if own else (matches[0] if len(matches) == 1 else None)
        return {"context": str(pick["context"])} if pick else None
    except Exception:
        return None


def register(ctx):
    ctx.register_hook("pre_llm_call", studio_turn_context)
`,
  }
}

function pluginDir(profileHome: string): string {
  return join(profileHome, 'plugins', HERMES_TURN_CONTEXT_PLUGIN)
}

function namesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

/** The profile's config with the plugin in `plugins.enabled`; unchanged when the user disabled it. */
export function withTurnContextPluginEnabled(config: Record<string, any>): { config: Record<string, any>; enabled: boolean; changed: boolean } {
  const plugins = config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins) ? config.plugins : {}
  if (namesOf(plugins.disabled).includes(HERMES_TURN_CONTEXT_PLUGIN)) return { config, enabled: false, changed: false }
  const enabled = namesOf(plugins.enabled)
  if (enabled.includes(HERMES_TURN_CONTEXT_PLUGIN)) return { config, enabled: true, changed: false }
  return { config: { ...config, plugins: { ...plugins, enabled: [...enabled, HERMES_TURN_CONTEXT_PLUGIN] } }, enabled: true, changed: true }
}

export interface HermesTurnContextDeps {
  profileHome: (profile: string) => string
  updateConfig: typeof updateConfigYamlForProfile
}

const defaultDeps: HermesTurnContextDeps = { profileHome: getProfileDir, updateConfig: updateConfigYamlForProfile }

/**
 * Put the plugin in the profile (before Studio starts a Hermes pane there, so the
 * pane's Hermes loads it). False when the user disabled it in the profile.
 */
export async function installHermesTurnContextPlugin(profile: string, contextDir: string, deps: HermesTurnContextDeps = defaultDeps): Promise<boolean> {
  const dir = pluginDir(deps.profileHome(profile || 'default'))
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(hermesTurnContextPluginFiles(contextDir))) {
    const path = join(dir, name)
    let current = ''
    try { current = readFileSync(path, 'utf8') } catch { /* new */ }
    if (current !== content) writeFileSync(path, content)
  }
  mkdirSync(contextDir, { recursive: true })
  const enabled = await deps.updateConfig<boolean>(profile || 'default', current => {
    const next = withTurnContextPluginEnabled(current && typeof current === 'object' ? current : {})
    return { data: next.config, result: next.enabled, write: next.changed }
  })
  return enabled === true
}

/** Whether the profile has the plugin, enabled (a pane started there loads it). */
export function hermesTurnContextReady(profile: string, config: Record<string, any> | null | undefined, deps: Pick<HermesTurnContextDeps, 'profileHome'> = defaultDeps): boolean {
  if (!existsSync(join(pluginDir(deps.profileHome(profile || 'default')), '__init__.py'))) return false
  const plugins = config?.plugins
  return namesOf(plugins?.enabled).includes(HERMES_TURN_CONTEXT_PLUGIN) && !namesOf(plugins?.disabled).includes(HERMES_TURN_CONTEXT_PLUGIN)
}

/** A chat's pending Hermes pane turn. */
export function hermesPaneTurnFile(contextDir: string, sessionId: string): string {
  return join(contextDir, `hermes-${sessionId.replace(/[^\w.-]/g, '_')}.json`)
}

/** Write (or, with no context, remove) the pending turn the plugin reads. */
export function setHermesPaneTurn(file: string, turn: { sessionIds: string[]; text: string; context: string } | null): void {
  if (!turn || !turn.context.trim()) { rmSync(file, { force: true }); return }
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ sessionIds: [...new Set(turn.sessionIds.filter(Boolean))], text: turn.text, context: turn.context.trim(), at: new Date().toISOString() })}\n`, { mode: 0o600 })
}
