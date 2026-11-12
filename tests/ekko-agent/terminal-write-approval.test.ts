import { describe, expect, it } from 'vitest'
import { toolApprovalRequirement } from '../../packages/ekko-agent/src/tools/approval'

describe('Ekko asks before running a command in an open Studio terminal', () => {
  it('asks when the typed text is submitted, not for plain typing', () => {
    expect(toolApprovalRequirement('studio_terminal_write', { terminal: 't1', text: 'rm -rf ~', enter: true }))
      .toMatchObject({ key: 'studio:terminal-write', command: 'rm -rf ~' })
    expect(toolApprovalRequirement('studio_terminal_write', { terminal: 't1', key: 'Enter' })).toMatchObject({ key: 'studio:terminal-write' })
    expect(toolApprovalRequirement('studio_terminal_write', { terminal: 't1', text: 'ls' })).toBeUndefined()
  })
})
