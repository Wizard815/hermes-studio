// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { baseCompile } from '@intlify/message-compiler'
import { uiSkillsMessages } from '../../packages/client/src/i18n/ui-skills-messages'
import { installedCount, targetsForSkillsPage, type UiSkillsInfo } from '../../packages/client/src/api/studio/ui-skills'
import { PAPER_MCP, paperServerConfig, paperServersAdded } from '../../packages/client/src/api/hermes/extensions'

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value }
  return Object.assign({}, ...Object.entries(value as Record<string, unknown>).map(([key, inner]) => flatten(inner, prefix ? `${prefix}.${key}` : key)))
}

describe('UI skills and Paper strings', () => {
  it('has every message in every locale, and each compiles with the same placeholders', () => {
    const en = flatten(uiSkillsMessages.en)
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) || []).sort()
    for (const [locale, messages] of Object.entries(uiSkillsMessages)) {
      const local = flatten(messages)
      expect(Object.keys(local).sort(), locale).toEqual(Object.keys(en).sort())
      for (const [key, text] of Object.entries(local)) {
        const errors: string[] = []
        baseCompile(text, { onError: () => errors.push(key) })
        expect(errors, `${locale}.${key}`).toEqual([])
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(en[key]))
      }
    }
    expect(Object.keys(uiSkillsMessages).sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-TW'].sort())
    expect(uiSkillsMessages.en.uiSkills.title).toBe('UI skills (bundled)')
  })
})

describe('Skills page card', () => {
  const info: UiSkillsInfo = {
    enabled: true, disabledByEnv: false, env: 'STUDIO_UI_SKILLS',
    source: { repo: 'https://github.com/jakubkrehel/skills', author: 'Jakub Krehel', licence: 'MIT', commit: 'x' },
    skills: [{ name: 'better-ui', description: '' }, { name: 'better-motion', description: '' }],
    targets: [
      { kind: 'hermes', label: 'Hermes profile default', profile: 'default', dir: '/h/skills/ui-skills', skills: { 'better-ui': 'installed', 'better-motion': 'removed' } },
      { kind: 'hermes', label: 'Hermes profile work', profile: 'work', dir: '/h/profiles/work/skills/ui-skills', skills: { 'better-ui': 'installed', 'better-motion': 'edited' } },
      { kind: 'ekko', label: 'Ekko profile default', profile: 'default', dir: '/e', skills: {} },
      { kind: 'claude-code', label: 'Claude Code', profile: null, dir: '/home/.claude/skills', skills: { 'better-ui': 'installed' } },
      { kind: 'shared', label: 'Shared', profile: null, dir: '/home/.agents/skills', skills: { 'better-ui': 'pending' } },
    ],
  }

  it('shows the folder this page\'s agent reads', () => {
    expect(targetsForSkillsPage(info, 'hermes', 'work').map(t => t.dir)).toEqual(['/h/profiles/work/skills/ui-skills'])
    expect(targetsForSkillsPage(info, 'ekko').map(t => t.kind)).toEqual(['ekko'])
    expect(targetsForSkillsPage(info, 'claude').map(t => t.kind)).toEqual(['claude-code'])
    for (const page of ['codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor', 'antigravity']) {
      expect(targetsForSkillsPage(info, page).map(t => t.kind), page).toEqual(['shared'])
    }
  })

  it('counts installed and edited copies, not removed or pending ones', () => {
    expect(info.targets.map(installedCount)).toEqual([1, 2, 0, 1, 0])
  })
})

describe('Paper on the MCP catalog', () => {
  it('adds the remote server with OAuth sign-in and spots it once added', () => {
    expect(PAPER_MCP.title).toBe('Paper (paper.design)')
    expect(paperServerConfig()).toEqual({ url: 'https://mcp.paper.design', auth: 'oauth' })
    expect(paperServersAdded([
      { name: 'paper', url: 'https://mcp.paper.design' },
      { name: 'other', url: 'https://example.com/mcp' },
      { name: 'paper-2', url: 'https://mcp.paper.design/mcp' },
      { name: 'stdio', url: '' },
    ])).toEqual(['paper', 'paper-2'])
  })
})
