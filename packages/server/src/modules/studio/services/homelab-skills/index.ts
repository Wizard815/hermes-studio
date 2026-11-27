import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { config } from '../../public/config'
import { logger } from '../../public/logging'
import {
  UI_SKILLS_CATEGORY, allUiSkillTargets, applyUiSkills, listBundledUiSkills, readUiSkillsState, uiSkillStatuses,
  type ApplyUiSkillsOptions, type BundledUiSkill, type UiSkillStatus, type UiSkillTarget,
} from '../ui-skills'

/**
 * Homelab skills (bundled), docs/homelab-skills.md: look-before-build, repo-pack,
 * to-markdown, code-map and the caveman voice. They go to the same agents and
 * folders as the UI skills, with the same rules (a removed copy stays removed,
 * an edited copy is never overwritten), but in their own `homelab-skills`
 * category and with their own record file and switch.
 */

export const HOMELAB_SKILLS_ENV = 'STUDIO_HOMELAB_SKILLS'
export const HOMELAB_SKILLS_CATEGORY = 'homelab-skills'
const CATEGORY_DESCRIPTION = 'Homelab skills (bundled): look before you build, repo packing, file to Markdown, code map and the caveman voice. Installed once by Studio.\n'

export function resolveHomelabSkillsSourceDir(env: NodeJS.ProcessEnv = process.env, baseDir = __dirname): string {
  const override = env.STUDIO_HOMELAB_SKILLS_DIR?.trim()
  if (override) return resolve(override)
  const candidates = [
    resolve(baseDir, '../homelab-skills'),
    resolve(baseDir, '../../../../../../homelab-skills'),
    resolve(process.cwd(), 'packages/homelab-skills'),
  ]
  return candidates.find(candidate => existsSync(join(candidate, 'look-before-build', 'SKILL.md'))) || candidates[0]
}

export function homelabSkillsStateFile(): string {
  return join(config.appHome, 'homelab-skills.json')
}

export function homelabSkillsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(String(env[HOMELAB_SKILLS_ENV] || '').trim())
}

/** The UI skill targets, with Hermes's and Ekko's `ui-skills` category folder swapped for `homelab-skills`. */
export function homelabSkillTargets(uiTargets: UiSkillTarget[]): UiSkillTarget[] {
  return uiTargets.map(target => basename(target.dir) === UI_SKILLS_CATEGORY
    ? { ...target, dir: join(dirname(target.dir), HOMELAB_SKILLS_CATEGORY) }
    : target)
}

export function listBundledHomelabSkills(sourceDir = resolveHomelabSkillsSourceDir()): BundledUiSkill[] {
  return listBundledUiSkills(sourceDir)
}

export async function applyHomelabSkills(targets: UiSkillTarget[], options: ApplyUiSkillsOptions = {}) {
  return applyUiSkills(homelabSkillTargets(targets), {
    ...options,
    sourceDir: options.sourceDir || resolveHomelabSkillsSourceDir(),
    stateFile: options.stateFile || homelabSkillsStateFile(),
    categoryDescription: CATEGORY_DESCRIPTION,
  })
}

let running: Promise<void> = Promise.resolve()

/** Runs after anything already queued; never throws. Off with STUDIO_HOMELAB_SKILLS=0. */
export function scheduleHomelabSkillsInstall(options: ApplyUiSkillsOptions = {}): Promise<void> {
  running = running.then(async () => {
    if (!homelabSkillsEnabled()) {
      logger.info('[homelab-skills] install is off (%s)', HOMELAB_SKILLS_ENV)
      return
    }
    try {
      await applyHomelabSkills(await allUiSkillTargets(), options)
    } catch (err) {
      logger.warn(err, '[homelab-skills] run failed (retry on next start)')
    }
  })
  return running
}

export interface HomelabSkillsStatus {
  enabled: boolean
  skills: BundledUiSkill[]
  targets: Array<{ kind: string; label: string; dir: string; statuses: Record<string, UiSkillStatus> }>
}

export async function homelabSkillsStatus(): Promise<HomelabSkillsStatus> {
  const skills = listBundledHomelabSkills()
  const state = await readUiSkillsState(homelabSkillsStateFile())
  const targets = []
  for (const target of homelabSkillTargets(await allUiSkillTargets())) {
    targets.push({ kind: target.kind, label: target.label, dir: target.dir, statuses: await uiSkillStatuses(target, state, skills) })
  }
  return { enabled: homelabSkillsEnabled(), skills, targets }
}
