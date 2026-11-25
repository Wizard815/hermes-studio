import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_AUTO_MODE_NOTICE_KEY, answerClaudeFirstRun, claudeConfigFile } from '../../packages/server/src/modules/coding-agents/services/herdr/first-run'
import { hermesMetricsUndecided, withHermesMetricsDeclined } from '../../packages/server/src/modules/hermes/services/herdr-first-run'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'first-run-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const KEY = 'sk-studio-gateway-0123456789abcdefTAIL'

describe('Claude Code in a herdr pane skips its first-run questions', () => {
  it('a fresh home: onboarding done, the launch key approved, the folder trusted', () => {
    const home = temp()
    const now = 1_795_000_000_000
    const result = answerClaudeFirstRun({ home, workspace: '/srv/app', apiKey: KEY, now })
    expect(result).toEqual({ file: join(home, '.claude.json'), changed: true })
    const config = JSON.parse(readFileSync(result.file, 'utf8'))
    expect(config).toEqual({
      hasCompletedOnboarding: true,
      theme: 'dark',
      customApiKeyResponses: { approved: ['0123456789abcdefTAIL'], rejected: [] },
      [CLAUDE_AUTO_MODE_NOTICE_KEY]: now,
      projects: { '/srv/app': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    })
    // Again: nothing to change.
    expect(answerClaudeFirstRun({ home, workspace: '/srv/app', apiKey: KEY, now: now + 60_000 }).changed).toBe(false)
  })

  it('keeps what is there, and takes a key someone said "No" to off the rejected list', () => {
    const home = temp()
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      theme: 'light', numStartups: 4, userID: 'abc',
      customApiKeyResponses: { approved: ['other'], rejected: ['0123456789abcdefTAIL'] },
      projects: { '/srv/app': { allowedTools: ['Bash'] } },
    }))
    answerClaudeFirstRun({ home, workspace: '/srv/app/', apiKey: KEY, skipPermissions: true })
    const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(config).toMatchObject({
      theme: 'light', numStartups: 4, userID: 'abc', hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
      customApiKeyResponses: { approved: ['other', '0123456789abcdefTAIL'], rejected: [] },
      projects: { '/srv/app': { allowedTools: ['Bash'], hasTrustDialogAccepted: true } },
    })
  })

  it('reads the auto mode billing notice for a gateway launch, and renews an answer older than an hour (Claude Code asks again after 24 h)', () => {
    const home = temp()
    const file = join(home, '.claude.json')
    const now = 1_795_000_000_000
    writeFileSync(file, JSON.stringify({ [CLAUDE_AUTO_MODE_NOTICE_KEY]: now - 30 * 60_000 }))
    answerClaudeFirstRun({ home, apiKey: KEY, now })
    expect(JSON.parse(readFileSync(file, 'utf8'))[CLAUDE_AUTO_MODE_NOTICE_KEY]).toBe(now - 30 * 60_000)
    answerClaudeFirstRun({ home, apiKey: KEY, now: now + 23 * 3600_000 })
    expect(JSON.parse(readFileSync(file, 'utf8'))[CLAUDE_AUTO_MODE_NOTICE_KEY]).toBe(now + 23 * 3600_000)
    // An agent on its own sign-in (no gateway) is not answered for.
    const own = temp()
    answerClaudeFirstRun({ home: own, workspace: '/srv/app', now })
    expect(JSON.parse(readFileSync(join(own, '.claude.json'), 'utf8'))[CLAUDE_AUTO_MODE_NOTICE_KEY]).toBeUndefined()
  })

  it('an agent on its own sign-in keeps its onboarding (login); only the folder is trusted', () => {
    const home = temp()
    answerClaudeFirstRun({ home, workspace: '/srv/app' })
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({
      projects: { '/srv/app': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    })
  })

  it('uses CLAUDE_CONFIG_DIR and leaves a file it cannot read alone', () => {
    const dir = temp()
    expect(claudeConfigFile({ configDir: dir })).toBe(join(dir, '.claude.json'))
    writeFileSync(join(dir, '.claude.json'), '{ half written')
    expect(answerClaudeFirstRun({ configDir: dir, workspace: '/srv/app', apiKey: KEY }).changed).toBe(false)
    expect(readFileSync(join(dir, '.claude.json'), 'utf8')).toBe('{ half written')
  })
})

describe('Hermes in a herdr pane skips its metrics question', () => {
  it('answers "No thanks" only for a profile that never answered', () => {
    expect(hermesMetricsUndecided({})).toBe(true)
    expect(hermesMetricsUndecided({ telemetry: { shared_metrics: { enabled: true, send: true } } })).toBe(false)
    // An old "No" without the offer version is asked again by Hermes.
    expect(hermesMetricsUndecided({ telemetry: { shared_metrics: { enabled: false, send: false } } })).toBe(true)
    const answered = withHermesMetricsDeclined({ model: { default: 'x' }, telemetry: { other: 1 } })
    expect(answered).toEqual({ model: { default: 'x' }, telemetry: { other: 1, shared_metrics: { enabled: false, send: false, offer_version: 2 } } })
    expect(hermesMetricsUndecided(answered)).toBe(false)
  })
})
