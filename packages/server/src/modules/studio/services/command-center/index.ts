import { join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import { CommandCenterSettingsFile } from './settings'
import { GithubFeed } from './github'
import { Skillshare } from './skillshare'

/**
 * Command Center (the herdr page's Tools dock): GitHub for the Inbox,
 * skillshare for Skills, and agent details for Agents. Everything else the
 * dock shows comes from Studio's existing APIs (session state, herdr, Agent
 * work, jobs, files, usage).
 */
let settings: CommandCenterSettingsFile | null = null
let github: GithubFeed | null = null
let skillshare: Skillshare | null = null

export function commandCenterSettings(): CommandCenterSettingsFile {
  if (!settings) settings = new CommandCenterSettingsFile(join(getWebUiHome(), 'command-center', 'settings.json'))
  return settings
}

export function githubFeed(): GithubFeed {
  if (!github) github = new GithubFeed()
  return github
}

export function skillshareCli(): Skillshare {
  if (!skillshare) skillshare = new Skillshare()
  return skillshare
}

export { agentDetails } from './agents'
export { codexPlanLimits } from './codex-limits'
