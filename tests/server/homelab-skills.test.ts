import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appHome = vi.hoisted(() => require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'homelab-skills-app-')) as string)
vi.mock('../../packages/server/src/modules/studio/public/config', async (orig) => {
  const real = await orig<any>()
  return { ...real, config: { ...real.config, appHome } }
})

import {
  HOMELAB_SKILLS_CATEGORY, applyHomelabSkills, homelabSkillTargets, homelabSkillsEnabled, listBundledHomelabSkills,
  resolveHomelabSkillsSourceDir,
} from '../../packages/server/src/modules/studio/services/homelab-skills'
import { UI_SKILLS_CATEGORY, type UiSkillTarget } from '../../packages/server/src/modules/studio/services/ui-skills'
import { validateSkillContent } from '../../packages/ekko-agent/src/tools/skills'

const BUNDLE = resolve(__dirname, '../../packages/homelab-skills')
const SCRIPT = join(BUNDLE, 'look-before-build/scripts/awesome_search.py')
const FIXTURE = resolve(__dirname, '../fixtures/awesome-sample.md')
const EXPECTED = ['caveman', 'caveman-commit', 'caveman-review', 'code-map', 'look-before-build', 'megacave', 'repo-pack', 'to-markdown', 'ultracave']

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'homelab-skills-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.STUDIO_HOMELAB_SKILLS })

describe('the homelab skills bundle', () => {
  it('ships every skill, and each passes Ekko\'s skill check', () => {
    expect(resolveHomelabSkillsSourceDir({}, join(BUNDLE, 'x/y/z/w/v/u'))).toBe(BUNDLE)
    const skills = listBundledHomelabSkills(BUNDLE)
    expect(skills.map(skill => skill.name)).toEqual(EXPECTED)
    for (const skill of skills) {
      expect(skill.description.length, skill.name).toBeGreaterThan(20)
      expect(validateSkillContent(skill.name, readFileSync(join(BUNDLE, skill.name, 'SKILL.md'), 'utf8')), skill.name).toBeNull()
    }
  })

  it('keeps the Apache licence and NOTICE with every caveman skill', () => {
    for (const name of EXPECTED.filter(name => /cave/.test(name))) {
      expect(readFileSync(join(BUNDLE, name, 'LICENSE'), 'utf8')).toContain('Apache License')
      expect(readFileSync(join(BUNDLE, name, 'NOTICE'), 'utf8')).toContain('Julius Brussee')
    }
  })
})

describe('installing', () => {
  const hermes: UiSkillTarget = { kind: 'hermes', label: 'Hermes profile work', profile: 'work', dir: '', category: true }

  it('puts the skills in a homelab-skills category next to the UI skills, and leaves flat folders flat', () => {
    const targets = homelabSkillTargets([
      { ...hermes, dir: join(dir, 'skills', UI_SKILLS_CATEGORY) },
      { kind: 'claude-code', label: 'Claude Code', dir: join(dir, '.claude', 'skills') },
    ])
    expect(targets.map(target => target.dir)).toEqual([join(dir, 'skills', HOMELAB_SKILLS_CATEGORY), join(dir, '.claude', 'skills')])
  })

  it('copies the bundle once with its own record file and category description', async () => {
    const stateFile = join(dir, 'state.json')
    const [result] = await applyHomelabSkills([{ ...hermes, dir: join(dir, 'skills', UI_SKILLS_CATEGORY) }], { sourceDir: BUNDLE, stateFile })
    expect(result.installed).toEqual(EXPECTED)
    const category = join(dir, 'skills', HOMELAB_SKILLS_CATEGORY)
    expect(existsSync(join(category, 'look-before-build', 'scripts', 'awesome_search.py'))).toBe(true)
    expect(readFileSync(join(category, 'DESCRIPTION.md'), 'utf8')).toMatch(/^Homelab skills/)
    expect(existsSync(join(dir, 'skills', UI_SKILLS_CATEGORY))).toBe(false)
    rmSync(join(category, 'caveman'), { recursive: true })
    const [again] = await applyHomelabSkills([{ ...hermes, dir: join(dir, 'skills', UI_SKILLS_CATEGORY) }], { sourceDir: BUNDLE, stateFile })
    expect(again.installed).toEqual([])
    expect(existsSync(join(category, 'caveman'))).toBe(false)
  })

  it('is off with STUDIO_HOMELAB_SKILLS=0', () => {
    expect(homelabSkillsEnabled({})).toBe(true)
    expect(homelabSkillsEnabled({ STUDIO_HOMELAB_SKILLS: 'off' })).toBe(false)
  })
})

describe('look-before-build search', () => {
  const search = (...args: string[]) => execFileSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: dir } })

  it('ranks matching entries with their section, and skips table-of-contents links and badges', () => {
    const hits = JSON.parse(search('photo backup', '--list', FIXTURE, '--json'))
    expect(hits[0]).toMatchObject({ name: 'Immich', url: 'https://immich.app/', section: 'Photo Galleries' })
    expect(hits.some((hit: any) => hit.name === 'Software')).toBe(false)
    const [mealie] = JSON.parse(search('recipe', '--list', FIXTURE, '--json'))
    expect(mealie.name).toBe('Mealie')
    expect(mealie.description).not.toContain('badge')
  })

  it('says so when nothing matches', () => {
    expect(search('quantum toaster', '--list', FIXTURE)).toMatch(/^no matches for 'quantum toaster'/)
  })
})
