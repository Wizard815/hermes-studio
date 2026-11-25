import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * A coding agent Studio starts in a terminal (a herdr pane) on a new install
 * lands on its own first-run questions. Claude Code asks for a theme, whether
 * to use the API key in its environment (Enter picks "No", and every request
 * then fails with 401) and whether to trust the folder. Studio already wrote
 * the agent's model gateway settings, so it answers these the way a person
 * setting up that launch would, before the pane starts:
 *
 * - onboarding done, theme kept (dark when none was picked), when Studio gives
 *   the agent its API key (an agent on its own sign-in still shows its login);
 * - the launch's own API key approved (taken off the rejected list), as
 *   Claude Code keeps it: the key's last 20 characters;
 * - the chat's folder trusted;
 * - bypass-permissions mode accepted only when the launch uses it (clean rooms);
 * - Claude Code's auto mode billing notice ("We're changing auto mode to no longer
 *   charge for classifier requests…") read, when Studio gives the key: requests go
 *   through Studio's model gateway, so Claude Code shows it at the first action auto
 *   mode checks and holds the pane until Enter. Claude Code keeps the answer as
 *   `autoModeClassifierBillingNoticeAcknowledgedAt` (ms) and asks again after 24 hours,
 *   so each launch renews an answer older than an hour.
 *
 * Nothing else in the file changes. Answers already there stay.
 */
export interface ClaudeFirstRunInput {
  /** Claude Code's config folder (CLAUDE_CONFIG_DIR); the file is `.claude.json` in it, else in the home folder. */
  configDir?: string
  home?: string
  workspace?: string
  apiKey?: string
  skipPermissions?: boolean
  /** Now, in ms (tests). */
  now?: number
}

/** Claude Code shows its auto mode billing notice again 24 hours after it was answered. */
export const CLAUDE_AUTO_MODE_NOTICE_KEY = 'autoModeClassifierBillingNoticeAcknowledgedAt'
const AUTO_MODE_NOTICE_RENEW_MS = 60 * 60 * 1000

export function claudeConfigFile(input: Pick<ClaudeFirstRunInput, 'configDir' | 'home'>): string {
  return input.configDir ? join(input.configDir, '.claude.json') : join(input.home || homedir(), '.claude.json')
}

/** Claude Code's record of an API key it was told to use: the last 20 characters. */
export function claudeKeyTail(key: string): string {
  return key.slice(-20)
}

export function answerClaudeFirstRun(input: ClaudeFirstRunInput): { file: string; changed: boolean } {
  const file = claudeConfigFile(input)
  let config: Record<string, any> = {}
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed
      else return { file, changed: false }
    } catch {
      // A file Claude Code is writing right now, or one a person broke: leave it alone.
      return { file, changed: false }
    }
  }
  const before = JSON.stringify(config)
  const key = String(input.apiKey || '').trim()
  // Onboarding includes signing in: skip it only when Studio gives the agent its key
  // (its model gateway). An agent on its own sign-in still shows its login.
  if (key) {
    config.hasCompletedOnboarding = true
    if (typeof config.theme !== 'string' || !config.theme) config.theme = 'dark'
    const tail = claudeKeyTail(key)
    const responses = config.customApiKeyResponses && typeof config.customApiKeyResponses === 'object' ? config.customApiKeyResponses : {}
    const approved: string[] = Array.isArray(responses.approved) ? responses.approved.filter((item: unknown) => typeof item === 'string') : []
    const rejected: string[] = Array.isArray(responses.rejected) ? responses.rejected.filter((item: unknown) => typeof item === 'string') : []
    config.customApiKeyResponses = {
      ...responses,
      approved: approved.includes(tail) ? approved : [...approved, tail].slice(-50),
      rejected: rejected.filter(item => item !== tail),
    }
    const now = input.now ?? Date.now()
    const answered = Number(config[CLAUDE_AUTO_MODE_NOTICE_KEY])
    if (!Number.isFinite(answered) || now - answered >= AUTO_MODE_NOTICE_RENEW_MS) config[CLAUDE_AUTO_MODE_NOTICE_KEY] = now
  }
  if (input.workspace) {
    const folder = resolve(input.workspace)
    const projects = config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects) ? config.projects : {}
    const project = projects[folder] && typeof projects[folder] === 'object' ? projects[folder] : {}
    config.projects = { ...projects, [folder]: { ...project, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } }
  }
  if (input.skipPermissions) config.bypassPermissionsModeAccepted = true
  if (JSON.stringify(config) === before) return { file, changed: false }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.studio.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
  return { file, changed: true }
}
