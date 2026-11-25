import { join } from 'node:path'
import { UI_SKILLS_CATEGORY, type UiSkillTarget } from '../../studio/public/ui-skills'
import { setupGlobalEkkoAgent } from './manager'

/**
 * Where the UI skills go for Ekko (docs/ui-skills.md): a `ui-skills` folder
 * in every Ekko profile's skills (Ekko finds skills in subfolders).
 */
export function ekkoUiSkillTargets(): UiSkillTarget[] {
  const { directories } = setupGlobalEkkoAgent()
  const profiles = [...new Set(['default', ...directories.profileNames()])]
  return profiles.map(profile => ({
    kind: 'ekko' as const,
    label: `Ekko profile ${profile}`,
    profile,
    dir: join(directories.profileSkillsPath(profile), UI_SKILLS_CATEGORY),
  }))
}
