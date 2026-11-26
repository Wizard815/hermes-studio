import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { UI_SKILLS_CATEGORY, type UiSkillTarget } from '../../../studio/public/ui-skills'
import { getHermesBaseDir, getProfileDir, listProfileNamesFromDisk } from '../profiles/profile'

/**
 * Where the UI skills go for Hermes (docs/ui-skills.md): a `ui-skills`
 * category folder in every profile's skills. Nothing when Hermes has no home yet.
 */
export function hermesUiSkillTargets(): UiSkillTarget[] {
  if (!existsSync(getHermesBaseDir())) return []
  return listProfileNamesFromDisk().map(profile => ({
    kind: 'hermes' as const,
    label: `Hermes profile ${profile}`,
    profile,
    dir: join(getProfileDir(profile), 'skills', UI_SKILLS_CATEGORY),
    category: true,
  }))
}
