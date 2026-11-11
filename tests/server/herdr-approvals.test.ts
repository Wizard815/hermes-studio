import { describe, expect, it } from 'vitest'
import { withApprovals } from '../../packages/server/src/modules/coding-agents/services'

describe('agents in herdr ask before acting', () => {
  it('drops the flags that skip approvals from terminal launches', () => {
    expect(withApprovals(['--append-system-prompt-file', '/p', '--dangerously-skip-permissions', '--effort', 'high'])).toEqual(['--append-system-prompt-file', '/p', '--effort', 'high'])
    expect(withApprovals(['exec', '--dangerously-bypass-approvals-and-sandbox', '--yolo'])).toEqual(['exec'])
    expect(withApprovals([])).toEqual([])
  })
})
