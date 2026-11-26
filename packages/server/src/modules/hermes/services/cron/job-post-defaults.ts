import { existsSync } from 'node:fs'
import { logger } from '../../../studio/public/logging'
import { join } from 'node:path'
import { getProfileDir, listProfileNamesFromDisk } from '../profiles/profile'
import { updateConfigYamlForProfile } from '../profiles/config'

/**
 * Hermes wraps every scheduled-job post in a "Cronjob Response: … / To stop or
 * manage this job …" header and footer unless `cron.wrap_response` is false.
 * Studio turns that off by default so posts (Mattermost etc.) are just the
 * report. Only a missing value is set: a choice made in Settings is kept.
 */
export async function applyJobPostDefaults(profile: string): Promise<boolean> {
  if (!existsSync(join(getProfileDir(profile), 'config.yaml'))) return false
  const changed = await updateConfigYamlForProfile<boolean>(profile, current => {
    const cfg = current && typeof current === 'object' ? current : {}
    const cron = cfg.cron && typeof cfg.cron === 'object' && !Array.isArray(cfg.cron) ? cfg.cron : null
    if (cron && typeof cron.wrap_response === 'boolean') return { data: cfg, result: false, write: false }
    cfg.cron = { ...(cron || {}), wrap_response: false }
    return { data: cfg, result: true }
  })
  return changed === true
}

export async function applyJobPostDefaultsToAllProfiles(): Promise<void> {
  for (const profile of listProfileNamesFromDisk()) {
    try {
      if (await applyJobPostDefaults(profile)) logger.info('[cron] job posts without Hermes header/footer profile=%s', profile)
    } catch (err) {
      logger.warn(err, '[cron] could not set job post defaults profile=%s', profile)
    }
  }
}
