import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserActivityLog, cleanActivity } from '../../packages/server/src/modules/studio/services/screen/activity'

describe('browser activity log', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('keeps addresses without their query strings and names the chat and agent', () => {
    const entry = cleanActivity({ kind: 'navigate', summary: 'Opened  a\\npage', url: 'https://bank.test/login?token=secret#x', outcome: 'done' }, { sessionId: 's1', agentId: 'codex' })
    expect(entry).toMatchObject({ kind: 'navigate', url: 'https://bank.test/login', sessionId: 's1', agentId: 'codex', outcome: 'done' })
    expect(JSON.stringify(entry)).not.toContain('secret')
    expect(cleanActivity({ kind: '', summary: 'x' })).toBeNull()
    expect(cleanActivity({ kind: 'click', summary: 'x', outcome: 'hacked' })?.outcome).toBe('done')
  })

  it('remembers entries across restarts and filters by chat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'activity-'))
    dirs.push(dir)
    const log = new BrowserActivityLog(dir)
    log.add(cleanActivity({ kind: 'click', summary: 'a' }, { sessionId: 's1' })!)
    log.add(cleanActivity({ kind: 'approval', summary: 'b', outcome: 'refused' }, { sessionId: 's2' })!)
    expect(readdirSync(dir)).toHaveLength(1)
    const again = new BrowserActivityLog(dir)
    expect(again.list().map(item => item.summary)).toEqual(['a', 'b'])
    expect(again.list({ sessionId: 's2' })).toMatchObject([{ summary: 'b', outcome: 'refused' }])
  })
})
