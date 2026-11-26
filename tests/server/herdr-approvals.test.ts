import { describe, expect, it } from 'vitest'
import { withApprovals, withApprovalsEnv } from '../../packages/server/src/modules/coding-agents/services'

describe('agents in herdr ask before acting', () => {
  it('drops the flags that skip approvals from terminal launches', () => {
    expect(withApprovals(['--append-system-prompt-file', '/p', '--dangerously-skip-permissions', '--effort', 'high'])).toEqual(['--append-system-prompt-file', '/p', '--effort', 'high'])
    expect(withApprovals(['exec', '--dangerously-bypass-approvals-and-sandbox', '--yolo'])).toEqual(['exec'])
    expect(withApprovals(['--always-approve', '--no-auto-update'])).toEqual(['--no-auto-update'])
    expect(withApprovals([])).toEqual([])
  })

  it('makes OpenCode ask in a terminal instead of allowing every tool', () => {
    expect(JSON.parse(withApprovalsEnv('opencode', { A: '1' }).OPENCODE_PERMISSION)).toEqual({ '*': 'ask' })
    expect(withApprovalsEnv('claude-code', { A: '1' })).toEqual({ A: '1' })
  })
})
