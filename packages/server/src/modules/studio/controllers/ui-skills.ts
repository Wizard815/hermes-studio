import type { Context } from 'koa'
import { writeAppConfig } from '../services/config/app-config'
import {
  UI_SKILLS_ENV, UI_SKILLS_SOURCE, allUiSkillTargets, forgetUiSkillsSettingCache, listBundledUiSkills,
  readUiSkillsState, scheduleUiSkillsInstall, uiSkillStatuses, uiSkillsSetting,
} from '../services/ui-skills'

/** UI skills (bundled), docs/ui-skills.md: the skills, the switch, and where each one is. */
export async function status(ctx: Context) {
  try {
    const [setting, state, targets] = await Promise.all([
      uiSkillsSetting(),
      readUiSkillsState().catch(() => ({ version: 1 as const, targets: {} })),
      allUiSkillTargets(),
    ])
    const skills = listBundledUiSkills()
    ctx.body = {
      enabled: setting.enabled,
      disabledByEnv: setting.disabledByEnv,
      env: UI_SKILLS_ENV,
      source: UI_SKILLS_SOURCE,
      skills,
      targets: await Promise.all(targets.map(async target => ({
        kind: target.kind,
        label: target.label,
        profile: target.profile || null,
        dir: target.dir,
        skills: await uiSkillStatuses(target, state, skills),
      }))),
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Could not read the UI skills' }
  }
}

/** Settings switch: turning it back on installs into folders that have not had them yet. */
export async function setEnabled(ctx: Context) {
  const value = (ctx.request.body as any)?.enabled
  if (typeof value !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'enabled must be true or false' }
    return
  }
  await writeAppConfig({ uiSkills: value })
  forgetUiSkillsSettingCache()
  const setting = await uiSkillsSetting()
  if (setting.enabled) void scheduleUiSkillsInstall()
  ctx.body = { enabled: setting.enabled, disabledByEnv: setting.disabledByEnv }
}
