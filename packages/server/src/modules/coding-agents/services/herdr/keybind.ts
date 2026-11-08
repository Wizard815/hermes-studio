import { copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { herdrArgs, runHerdr, type HerdrSettings } from './runtime'

/** Plugin action the Studio shortcut opens. */
export const STUDIO_CHATS_ACTION = 'studio.hermes.chats'
/** Plugin action that starts a new agent chat that is both a herdr pane and a Studio chat. */
export const STUDIO_NEW_CHAT_ACTION = 'studio.hermes.launch'

/**
 * Tried in order; the first one neither herdr's defaults nor the user's config
 * uses wins. `prefix+s` is herdr's own Settings, so it is never a candidate.
 */
export const STUDIO_KEY_CANDIDATES = ['prefix+shift+s', 'prefix+alt+s', 'prefix+a', 'prefix+y', 'prefix+shift+a', 'prefix+f9'] as const
/** For "New Studio chat"; herdr's own `prefix+c` stays its plain new tab. */
export const STUDIO_NEW_CHAT_KEY_CANDIDATES = ['prefix+n', 'prefix+shift+c', 'prefix+alt+n', 'prefix+alt+c', 'prefix+f8'] as const

/** A Studio plugin action bound to a herdr key. */
export interface StudioBinding {
  action: string
  candidates: readonly string[]
  description: string
  comment: string
}

export const STUDIO_CHATS_BINDING: StudioBinding = { action: STUDIO_CHATS_ACTION, candidates: STUDIO_KEY_CANDIDATES, description: 'Studio chats', comment: 'open the Studio chat picker' }
export const STUDIO_NEW_CHAT_BINDING: StudioBinding = { action: STUDIO_NEW_CHAT_ACTION, candidates: STUDIO_NEW_CHAT_KEY_CANDIDATES, description: 'New Studio chat', comment: 'start a new agent chat (a herdr pane and a Studio chat)' }

/** Same resolution order as herdr: HERDR_CONFIG_PATH, XDG_CONFIG_HOME, APPDATA (Windows), ~/.config. */
export function herdrConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'herdr', 'config.toml')
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'herdr', 'config.toml')
  return join(env.HOME || homedir(), '.config', 'herdr', 'config.toml')
}

/** Canonical form so `prefix+S` and `prefix+shift+s` compare equal. */
export function normalizeKey(key: string): string {
  const parts = key.trim().split('+').filter(Boolean)
  const last = parts.pop() || ''
  const modifiers = new Set(parts.map(part => part.toLowerCase()))
  let base = last
  if (/^[A-Z]$/.test(last)) { modifiers.add('shift'); base = last.toLowerCase() } else base = last.toLowerCase()
  const prefix = modifiers.delete('prefix') ? ['prefix'] : []
  return [...prefix, ...[...modifiers].sort(), base].join('+')
}

/**
 * Every key combo bound in a herdr config text. With `includeComments`, the
 * commented defaults printed by `herdr --default-config` count as bound too.
 */
export function boundKeys(text: string, includeComments: boolean): Set<string> {
  const keys = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line.startsWith('#')) {
      if (!includeComments) continue
      line = line.replace(/^#+\s*/, '')
    }
    const match = line.match(/^([A-Za-z0-9_.]+)\s*=\s*(.+)$/)
    if (!match) continue
    const value = match[2].replace(/\s+#.*$/, '')
    for (const quoted of value.matchAll(/"([^"]*)"/g)) {
      const combo = quoted[1]
      if (!combo || /\s/.test(combo) || !/(^prefix\+)|((ctrl|alt|shift|cmd|super)\+)|(^f\d{1,2}$)/i.test(combo)) continue
      keys.add(normalizeKey(combo))
    }
  }
  return keys
}

export function hasStudioBinding(userConfig: string, action = STUDIO_CHATS_ACTION): boolean {
  return userConfig.includes(`"${action}"`)
}

export function existingStudioKey(userConfig: string, action = STUDIO_CHATS_ACTION): string | null {
  const blocks = userConfig.split(/\[\[keys\.command\]\]/).slice(1)
  for (const block of blocks) {
    if (!block.includes(`"${action}"`)) continue
    const key = block.match(/^\s*key\s*=\s*"([^"]+)"/m)
    if (key) return key[1]
  }
  return null
}

export function chooseStudioKey(defaultConfig: string, userConfig: string, candidates: readonly string[] = STUDIO_KEY_CANDIDATES): string | null {
  const used = new Set([...boundKeys(defaultConfig, true), ...boundKeys(userConfig, false)])
  return candidates.find(candidate => !used.has(normalizeKey(candidate))) ?? null
}

export function renderStudioBinding(key: string, binding: StudioBinding = STUDIO_CHATS_BINDING): string {
  return `
# Added by Ekko Studio: ${binding.comment}.
[[keys.command]]
key = "${key}"
type = "plugin_action"
command = "${binding.action}"
description = "${binding.description}"
`
}

export interface KeybindResult {
  key: string | null
  path: string
  added: boolean
  message: string
}

/** herdr keys the Studio UI offers as buttons (herdr's defaults unless the user changed them). */
export interface HerdrKeys {
  prefix: string
  /** goto: jump to a workspace, tab or agent by name */
  search: string
  workspaces: string
  settings: string
  help: string
  /** herdr's own sidebar (spaces and agents) */
  sidebar: string
  /** Studio's plugin keys, when bound: the chat picker and "New Studio chat". */
  studioChats?: string
  newChat?: string
}

const DEFAULT_HERDR_KEYS: HerdrKeys = { prefix: 'ctrl+b', search: 'prefix+g', workspaces: 'prefix+w', settings: 'prefix+s', help: 'prefix+?', sidebar: 'prefix+b' }
type HerdrKeyName = Exclude<keyof HerdrKeys, 'studioChats' | 'newChat'>
const KEY_NAMES: Record<HerdrKeyName, string> = { prefix: 'prefix', search: 'goto', workspaces: 'workspace_picker', settings: 'settings', help: 'help', sidebar: 'toggle_sidebar' }

export function herdrKeys(userConfig: string): HerdrKeys {
  const keys = { ...DEFAULT_HERDR_KEYS }
  let section = ''
  for (const raw of userConfig.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    const header = line.match(/^\[+([^\]]+)\]+$/)
    if (header) { section = header[1].trim(); continue }
    if (section !== 'keys') continue
    const match = line.match(/^([A-Za-z_]+)\s*=\s*"([^"]*)"/)
    if (!match) continue
    const field = (Object.keys(KEY_NAMES) as HerdrKeyName[]).find(name => KEY_NAMES[name] === match[1])
    if (field) keys[field] = match[2].trim()
  }
  const studioChats = existingStudioKey(userConfig, STUDIO_CHATS_ACTION)
  const newChat = existingStudioKey(userConfig, STUDIO_NEW_CHAT_ACTION)
  return { ...keys, ...(studioChats ? { studioChats } : {}), ...(newChat ? { newChat } : {}) }
}

/** herdr's layout settings Studio needs to fit its own spaces panel next to herdr's UI. */
export interface HerdrView {
  /** Columns of herdr's collapsed sidebar rail: 4 ("compact", herdr's default) or 0 ("hidden"). */
  rail: number
  /** At or below this many columns herdr uses its one-column phone layout (no rail). */
  mobileWidth: number
}

export function herdrView(userConfig: string): HerdrView {
  const view: HerdrView = { rail: 4, mobileWidth: 64 }
  let section = ''
  for (const raw of userConfig.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    const header = line.match(/^\[+([^\]]+)\]+$/)
    if (header) { section = header[1].trim(); continue }
    if (section !== 'ui') continue
    const mode = line.match(/^sidebar_collapsed_mode\s*=\s*"([^"]*)"/)
    if (mode) view.rail = mode[1].trim() === 'hidden' ? 0 : 4
    const width = line.match(/^mobile_width_threshold\s*=\s*(\d+)/)
    if (width) view.mobileWidth = Number(width[1])
  }
  return view
}

export async function readHerdrView(env: NodeJS.ProcessEnv = process.env): Promise<HerdrView> {
  const path = herdrConfigPath(env)
  try { return herdrView(existsSync(path) ? await readFile(path, 'utf8') : '') } catch { return { rail: 4, mobileWidth: 64 } }
}

export async function readHerdrKeys(env: NodeJS.ProcessEnv = process.env): Promise<HerdrKeys> {
  const path = herdrConfigPath(env)
  try { return herdrKeys(existsSync(path) ? await readFile(path, 'utf8') : '') } catch { return { ...DEFAULT_HERDR_KEYS } }
}

/**
 * Bind the Studio chat picker to the first free key. The user's config is
 * backed up and restored if herdr rejects the edited file.
 */
export async function installStudioKeybinding(binary: string, settings: Pick<HerdrSettings, 'session'>, env: NodeJS.ProcessEnv = process.env, binding: StudioBinding = STUDIO_CHATS_BINDING): Promise<KeybindResult> {
  const path = herdrConfigPath(env)
  const userConfig = existsSync(path) ? await readFile(path, 'utf8') : ''
  const current = existingStudioKey(userConfig, binding.action)
  if (current || hasStudioBinding(userConfig, binding.action)) return { key: current, path, added: false, message: 'already bound' }
  const defaultConfig = await runHerdr(binary, ['--default-config'], 15000)
  const key = chooseStudioKey(defaultConfig, userConfig, binding.candidates)
  if (!key) return { key: null, path, added: false, message: 'every candidate key is already used' }

  await mkdir(dirname(path), { recursive: true })
  const backup = `${path}.studio-backup`
  const hadConfig = existsSync(path)
  if (hadConfig) await copyFile(path, backup)
  const separator = userConfig && !userConfig.endsWith('\n') ? '\n' : ''
  await writeFile(path, `${userConfig}${separator}${renderStudioBinding(key, binding)}`)
  try {
    const check = await runHerdr(binary, ['config', 'check'], 15000)
    if (!/ok/i.test(check)) throw new Error(check.trim() || 'herdr rejected the config')
  } catch (error) {
    if (hadConfig) await copyFile(backup, path)
    else await rm(path, { force: true })
    return { key: null, path, added: false, message: `herdr rejected the binding: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (hadConfig) await rm(backup, { force: true })
  }
  await runHerdr(binary, herdrArgs(settings, ['server', 'reload-config']), 15000).catch(() => '')
  return { key, path, added: true, message: 'bound' }
}

/**
 * herdr's first-run welcome screen (top-level `onboarding`): true or false
 * when the config says so, null when unset (herdr then shows it).
 */
export function herdrWelcome(userConfig: string): boolean | null {
  for (const raw of userConfig.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (/^\[/.test(line)) break
    const match = line.match(/^onboarding\s*=\s*(true|false)\b/)
    if (match) return match[1] === 'true'
  }
  return null
}

/** Set top-level `onboarding`, keeping everything else in the file as it is. */
export function withHerdrWelcome(userConfig: string, show: boolean): string {
  const lines = userConfig.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/^﻿/, '').trim()
    if (line.startsWith('[')) break
    if (/^onboarding\s*=/.test(line)) {
      lines[index] = `${index === 0 && lines[0].startsWith('﻿') ? '﻿' : ''}onboarding = ${show}`
      return lines.join('\n')
    }
  }
  // Top-level keys must come before the first [section].
  const bom = userConfig.startsWith('﻿') ? '﻿' : ''
  const rest = bom ? userConfig.slice(1) : userConfig
  return `${bom}onboarding = ${show}\n${rest}`
}

export async function readHerdrWelcome(env: NodeJS.ProcessEnv = process.env): Promise<boolean | null> {
  const path = herdrConfigPath(env)
  try { return herdrWelcome(existsSync(path) ? await readFile(path, 'utf8') : '') } catch { return null }
}

/**
 * Show or skip herdr's welcome screen. Same safety as the keybinding: the
 * config is backed up and restored if herdr rejects the edited file.
 */
export async function setHerdrWelcome(binary: string, settings: Pick<HerdrSettings, 'session'>, show: boolean, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = herdrConfigPath(env)
  const hadConfig = existsSync(path)
  const userConfig = hadConfig ? await readFile(path, 'utf8') : ''
  if (herdrWelcome(userConfig) === show) return show
  await mkdir(dirname(path), { recursive: true })
  const backup = `${path}.studio-backup`
  if (hadConfig) await copyFile(path, backup)
  await writeFile(path, withHerdrWelcome(userConfig, show))
  try {
    const check = await runHerdr(binary, ['config', 'check'], 15000)
    if (!/ok/i.test(check)) throw new Error(check.trim() || 'herdr rejected the config')
  } catch (error) {
    if (hadConfig) await copyFile(backup, path)
    else await rm(path, { force: true })
    throw Object.assign(new Error(`herdr rejected the change: ${error instanceof Error ? error.message : String(error)}`), { status: 422 })
  } finally {
    if (hadConfig) await rm(backup, { force: true })
  }
  await runHerdr(binary, herdrArgs(settings, ['server', 'reload-config']), 15000).catch(() => '')
  return show
}
