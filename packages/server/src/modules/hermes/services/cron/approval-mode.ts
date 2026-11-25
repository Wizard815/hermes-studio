import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getProfileDir } from '../profiles/profile'
import { readConfigYamlForProfile } from '../../../studio/public/profile-config'
import { updateConfigYamlForProfile } from '../profiles/config'

/**
 * What Hermes does when a scheduled job wants a dangerous command
 * (`approvals.cron_mode` in the profile's config.yaml): nobody is there to
 * ask, so it is "deny" (Hermes's default: the command is blocked and the job
 * goes on without it) or "approve" (it runs). Hermes applies it to every job
 * of the profile; jobs that need different rules go in different profiles.
 * See docs/watcher.md.
 */
export type CronApprovalMode = 'deny' | 'approve'

export function cronModeFrom(config: Record<string, any> | null | undefined): CronApprovalMode {
  const value = String(config?.approvals?.cron_mode ?? 'deny').toLowerCase().trim()
  return ['approve', 'off', 'allow', 'yes'].includes(value) ? 'approve' : 'deny'
}

export async function readCronApprovalMode(profile: string): Promise<CronApprovalMode> {
  if (!existsSync(join(getProfileDir(profile), 'config.yaml'))) return 'deny'
  return cronModeFrom(await readConfigYamlForProfile(profile).catch(() => ({})))
}

export async function writeCronApprovalMode(profile: string, mode: unknown): Promise<CronApprovalMode> {
  if (mode !== 'deny' && mode !== 'approve') throw Object.assign(new Error('mode must be deny or approve'), { status: 400 })
  await updateConfigYamlForProfile(profile, current => {
    const cfg = current && typeof current === 'object' ? current : {}
    const approvals = cfg.approvals && typeof cfg.approvals === 'object' && !Array.isArray(cfg.approvals) ? cfg.approvals : {}
    cfg.approvals = { ...approvals, cron_mode: mode }
    return cfg
  })
  return mode
}
