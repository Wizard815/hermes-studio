import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let savedAppConfig: Record<string, unknown> = {}
const appHome = vi.hoisted(() => require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ui-skills-app-')) as string)
vi.mock('../../packages/server/src/modules/studio/public/config', async (orig) => {
  const real = await orig<any>()
  return { ...real, config: { ...real.config, appHome } }
})
vi.mock('../../packages/server/src/modules/studio/services/config/app-config', async (orig) => ({
  ...(await orig<any>()),
  readAppConfig: async () => savedAppConfig,
}))

import {
  UI_SKILLS_CATEGORY, applyUiSkills, cleanRoomUiSkillMounts, codingAgentUiSkillTargets, forgetUiSkillsSettingCache,
  listBundledUiSkills, readUiSkillsState, scheduleUiSkillsInstall, registerUiSkillTargetProvider, uiSkillsMirrorDir, resolveUiSkillsSourceDir, uiSkillStatuses, uiSkillsPointer, uiSkillsSetting,
  type UiSkillTarget,
} from '../../packages/server/src/modules/studio/services/ui-skills'
import { validateSkillContent } from '../../packages/ekko-agent/src/tools/skills'

const BUNDLE = resolve(__dirname, '../../packages/ui-skills')
const EXPECTED = [
  'better-accessibility', 'better-colors', 'better-interface', 'better-layout', 'better-motion',
  'better-typography', 'better-ui', 'better-writing', 'build-design', 'interface-review',
]

let dir = ''
let source = ''
let stateFile = ''

function skill(root: string, name: string, body = 'Body') {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} guide\n---\n\n${body}\n`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ui-skills-'))
  source = join(dir, 'bundle')
  stateFile = join(dir, 'state', 'ui-skills.json')
  skill(source, 'better-ui')
  skill(source, 'better-motion')
  savedAppConfig = {}
  forgetUiSkillsSettingCache()
  delete process.env.STUDIO_UI_SKILLS
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.STUDIO_UI_SKILLS
})

const hermes = (profile: string): UiSkillTarget => ({ kind: 'hermes', label: `Hermes profile ${profile}`, profile, dir: join(dir, 'hermes', profile, 'skills', UI_SKILLS_CATEGORY), category: true })
const claude = (): UiSkillTarget => ({ kind: 'claude-code', label: 'Claude Code', dir: join(dir, 'home', '.claude', 'skills') })
const run = (targets: UiSkillTarget[]) => applyUiSkills(targets, { sourceDir: source, stateFile })

describe('the bundle', () => {
  it('ships the ten UI skills with their licence, and each passes Ekko\'s skill check', () => {
    expect(resolveUiSkillsSourceDir({}, join(__dirname, '../../packages/server/src/modules/studio/services/ui-skills'))).toBe(BUNDLE)
    const skills = listBundledUiSkills(BUNDLE)
    expect(skills.map(s => s.name)).toEqual(EXPECTED)
    for (const { name } of skills) {
      expect(readFileSync(join(BUNDLE, name, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2026 Jakub Krehel')
      expect(validateSkillContent(name, readFileSync(join(BUNDLE, name, 'SKILL.md'), 'utf8'))).toBeNull()
    }
    expect(readFileSync(join(BUNDLE, 'README.md'), 'utf8')).toContain('jakubkrehel/skills')
  })
})

describe('applyUiSkills', () => {
  it('installs once into every Hermes profile and the coding agents, with a category description for Hermes', async () => {
    const targets = [hermes('default'), hermes('work'), claude()]
    const first = await run(targets)
    expect(first.map(r => r.installed)).toEqual([['better-motion', 'better-ui'], ['better-motion', 'better-ui'], ['better-motion', 'better-ui']])
    expect(readFileSync(join(hermes('work').dir, 'better-ui', 'SKILL.md'), 'utf8')).toContain('name: better-ui')
    expect(readFileSync(join(hermes('default').dir, 'DESCRIPTION.md'), 'utf8')).toMatch(/^UI skills \(bundled\)/)
    expect(existsSync(join(claude().dir, 'DESCRIPTION.md'))).toBe(false)

    const second = await run(targets)
    expect(second.every(r => !r.installed.length && !r.updated.length)).toBe(true)
    const state = await readUiSkillsState(stateFile)
    expect(state.targets[resolve(claude().dir)].skills['better-ui'].outcome).toBe('installed')
  })

  it('a skill the user removed stays removed', async () => {
    await run([claude()])
    rmSync(join(claude().dir, 'better-ui'), { recursive: true })
    const again = await run([claude()])
    expect(again[0].installed).toEqual([])
    expect(existsSync(join(claude().dir, 'better-ui'))).toBe(false)
    const statuses = await uiSkillStatuses(claude(), await readUiSkillsState(stateFile), listBundledUiSkills(source))
    expect(statuses).toEqual({ 'better-motion': 'installed', 'better-ui': 'removed' })
  })

  it('never overwrites an edited copy, even when the bundle changes', async () => {
    await run([claude()])
    writeFileSync(join(claude().dir, 'better-ui', 'SKILL.md'), '---\nname: better-ui\ndescription: mine\n---\n\nMy rules\n')
    skill(source, 'better-ui', 'New upstream body')
    skill(source, 'better-motion', 'New upstream body')
    const again = await run([claude()])
    expect(again[0].updated).toEqual(['better-motion'])
    expect(readFileSync(join(claude().dir, 'better-ui', 'SKILL.md'), 'utf8')).toContain('My rules')
    expect(readFileSync(join(claude().dir, 'better-motion', 'SKILL.md'), 'utf8')).toContain('New upstream body')
    const statuses = await uiSkillStatuses(claude(), await readUiSkillsState(stateFile), listBundledUiSkills(source))
    expect(statuses['better-ui']).toBe('edited')
  })

  it('leaves a folder of the same name the user already had', async () => {
    skill(claude().dir, 'better-ui', 'The user\'s own')
    const result = await run([claude()])
    expect(result[0].kept).toEqual(['better-ui'])
    expect(readFileSync(join(claude().dir, 'better-ui', 'SKILL.md'), 'utf8')).toContain('The user\'s own')
  })

  it('a new profile gets the skills on the next run', async () => {
    await run([hermes('default')])
    const result = await run([hermes('default'), hermes('new')])
    expect(result[0].installed).toEqual([])
    expect(result[1].installed).toEqual(['better-motion', 'better-ui'])
  })
})

describe('the switch', () => {
  it('is on by default and off with the Settings switch or STUDIO_UI_SKILLS=0', async () => {
    expect(await uiSkillsSetting({})).toEqual({ enabled: true, disabledByEnv: false })
    expect(await uiSkillsSetting({ STUDIO_UI_SKILLS: '0' })).toEqual({ enabled: false, disabledByEnv: true })
    savedAppConfig = { uiSkills: false }
    expect(await uiSkillsSetting({})).toEqual({ enabled: false, disabledByEnv: false })
  })

  it('off: no pointer for native agents and no clean-room mounts', async () => {
    const home = join(dir, 'home')
    await applyUiSkills(codingAgentUiSkillTargets(home), { sourceDir: BUNDLE, stateFile })
    expect(await uiSkillsPointer(home)).toContain('~/.agents/skills/<name>/SKILL.md')
    expect(await uiSkillsPointer(home)).toContain('better-interface')
    savedAppConfig = { uiSkills: false }
    forgetUiSkillsSettingCache()
    expect(await uiSkillsPointer(home)).toBe('')
    expect(await cleanRoomUiSkillMounts(home)).toEqual([])
  })
})

describe('clean rooms', () => {
  it('mount the mirrored skills read-only into both folders, without one the user removed on the host', async () => {
    const home = join(dir, 'home')
    registerUiSkillTargetProvider('coding-agents', () => codingAgentUiSkillTargets(home))
    await scheduleUiSkillsInstall({ sourceDir: source })
    expect(uiSkillsMirrorDir()).toBe(join(appHome, 'ui-skills', 'bundle'))
    expect(existsSync(join(appHome, 'ui-skills', 'bundle', 'better-ui', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'skills', 'better-ui', 'SKILL.md'))).toBe(true)
    rmSync(join(home, '.claude', 'skills', 'better-ui'), { recursive: true })
    const mounts = await cleanRoomUiSkillMounts(home)
    expect(mounts.map(m => m.inside)).toEqual([
      '/root/.claude/skills/better-motion',
      '/root/.agents/skills/better-motion', '/root/.agents/skills/better-ui',
    ])
    expect(mounts[0].source).toBe(join(appHome, 'ui-skills', 'bundle', 'better-motion'))
    rmSync(appHome, { recursive: true, force: true })
  })
})

describe('coding agent folders', () => {
  it('Claude Code gets ~/.claude/skills and the other agents the shared ~/.agents/skills', () => {
    const targets = codingAgentUiSkillTargets('/h')
    expect(targets.map(t => [t.kind, t.dir])).toEqual([['claude-code', '/h/.claude/skills'], ['shared', '/h/.agents/skills']])
  })
})
