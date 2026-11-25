import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolLoadStore, toolLoadNoticeText } from '../../packages/server/src/modules/studio/services/tool-load'
import { DEFAULT_WATCHER_KINDS, WATCHER_KINDS } from '../../packages/shared/watcher'

// Too many tools for a small model (docs/hermes-tool-load.md).
describe('tool load notice', () => {
  const dirs: string[] = []
  const store = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-load-'))
    dirs.push(dir)
    return { path: join(dir, 'hermes-tool-load.json'), store: new ToolLoadStore(() => join(dir, 'hermes-tool-load.json')) }
  }
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('tells a chat once when it has more tools than the threshold (80 by default), counting the ones tool search hides', () => {
    const { store: tools, path } = store()
    expect(tools.settings()).toEqual({ threshold: 80 })
    expect(tools.observe({ sessionId: 'small', profile: 'default', tool_count: 40, total_tool_count: 40 })).toBeNull()
    const notice = tools.observe({ sessionId: 'rea', profile: 'rea', tool_count: 8, total_tool_count: 252, deferred_tool_count: 247, tool_search_active: true, tool_search: 'auto' }, 1000)
    expect(notice).toEqual({ sessionId: 'rea', profile: 'rea', total: 252, deferred: 247, toolSearchActive: true, toolSearch: 'auto', threshold: 80, at: 1000, dismissed: false })
    expect(tools.observe({ sessionId: 'rea', profile: 'rea', total_tool_count: 252 })).toBeNull()
    expect(JSON.parse(readFileSync(path, 'utf8')).chats.rea.total).toBe(252)
    expect(toolLoadNoticeText(notice!)).toBe('This chat has 252 tools; small models may struggle. Tool search hides 247 of them behind tool_search, which small models often cannot use. Turn off tool search or some plugins or MCP servers for the "rea" profile.')
  })

  it('uses the plain tool count from an older bridge, keeps a dismissal and survives a restart', () => {
    const { store: tools, path } = store()
    expect(tools.observe({ sessionId: 'old', profile: 'default', tool_count: 120 })?.total).toBe(120)
    expect(tools.dismiss('old')?.dismissed).toBe(true)
    const again = new ToolLoadStore(() => path)
    expect(again.notice('old')?.dismissed).toBe(true)
    expect(again.dismiss('missing')).toBeNull()
  })

  it('a threshold of 0 turns the notice off; out-of-range values are clamped', () => {
    const { store: tools } = store()
    expect(tools.saveSettings({ threshold: 0 })).toEqual({ threshold: 0 })
    expect(tools.observe({ sessionId: 'x', total_tool_count: 900 })).toBeNull()
    expect(tools.saveSettings({ threshold: 99999 })).toEqual({ threshold: 2000 })
    expect(tools.saveSettings({ threshold: 'nope' })).toEqual({ threshold: 2000 })
  })

  it('the watcher has an info kind for it, in the bell by default', () => {
    expect(WATCHER_KINDS).toContain('tool_load')
    expect(DEFAULT_WATCHER_KINDS.tool_load).toEqual({ alert: true, mattermost: false })
  })

  it('the bridge counts visible and deferred tools and reads tools.tool_search.enabled', async () => {
    const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-bridge-tool-load.py')], {
      cwd: resolve('.'), timeout: 25_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    expect(stdout).toContain('Hermes bridge tool load verified')
  }, 30_000)
})
