import { request } from '../client'

/** UI skills (bundled), docs/ui-skills.md. */
export type UiSkillStatus = 'installed' | 'removed' | 'edited' | 'kept-existing' | 'pending'
export type UiSkillTargetKind = 'hermes' | 'ekko' | 'claude-code' | 'shared'

export interface UiSkillsInfo {
  enabled: boolean
  disabledByEnv: boolean
  env: string
  source: { repo: string; author: string; licence: string; commit: string }
  skills: Array<{ name: string; description: string }>
  targets: Array<{ kind: UiSkillTargetKind; label: string; profile: string | null; dir: string; skills: Record<string, UiSkillStatus> }>
}

/** Hermes and Ekko keep the skills in this category folder. */
export const UI_SKILLS_CATEGORY = 'ui-skills'

export const fetchUiSkills = () => request<UiSkillsInfo>('/api/studio/ui-skills')

export const setUiSkillsEnabled = (enabled: boolean) =>
  request<{ enabled: boolean; disabledByEnv: boolean }>('/api/studio/ui-skills', { method: 'PUT', body: JSON.stringify({ enabled }) })

/** How many of the bundled skills a target has now. */
export function installedCount(target: UiSkillsInfo['targets'][number]): number {
  return Object.values(target.skills).filter(status => status === 'installed' || status === 'edited').length
}

/** The targets a Skills page shows: Hermes for the profile, the coding agent's folder, or every one. */
export function targetsForSkillsPage(info: UiSkillsInfo, page: string, profile?: string | null): UiSkillsInfo['targets'] {
  if (page === 'hermes') return info.targets.filter(target => target.kind === 'hermes' && (!profile || target.profile === profile))
  if (page === 'ekko') return info.targets.filter(target => target.kind === 'ekko' && (!profile || target.profile === profile))
  if (page === 'claude' || page === 'claude-code') return info.targets.filter(target => target.kind === 'claude-code')
  return info.targets.filter(target => target.kind === 'shared')
}
