import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerAcpPermission } from '../../packages/server/src/modules/coding-agents/protocol/acp/permission'
import { codexApprovalRequest, codexApprovalResponse } from '../../packages/server/src/modules/coding-agents/services/codex/app-server-turn'
import { buildCursorTurnArgs } from '../../packages/server/src/modules/coding-agents/services/cursor/turn-process'
import { buildAntigravityTurnArgs } from '../../packages/server/src/modules/coding-agents/services/antigravity/turn-process'
import { agentAsksBeforeActing, readAgentApprovalSettings, writeAgentApprovalSettings } from '../../packages/server/src/modules/coding-agents/services/approvals'

const options = [
  { optionId: 'a1', kind: 'allow_once' },
  { optionId: 'a2', kind: 'allow_always' },
  { optionId: 'r1', kind: 'reject_once' },
]

describe('agents ask in Studio before acting', () => {
  it('answers an ACP permission request with the agent\'s own option for Studio\'s answer', async () => {
    const params = { options, toolCall: { title: 'rm notes.txt', kind: 'execute', rawInput: { command: 'rm notes.txt' } } }
    const asked: any[] = []
    const deny = await answerAcpPermission(params, 'Qwen Code', async request => { asked.push(request); return 'deny' })
    expect(deny).toEqual({ outcome: { outcome: 'selected', optionId: 'r1' } })
    expect(asked[0]).toMatchObject({ key: 'execute:rm', title: 'Qwen Code wants to rm notes.txt', command: 'rm notes.txt' })
    // "For this chat" is remembered by Studio; the agent is only told "once".
    expect(await answerAcpPermission(params, 'Qwen Code', async () => 'session')).toEqual({ outcome: { outcome: 'selected', optionId: 'a1' } })
    expect(await answerAcpPermission({ options: [] }, 'X', async () => 'once')).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('maps Codex app-server approval requests and answers', () => {
    expect(codexApprovalRequest('item/commandExecution/requestApproval', { command: 'rm -rf build', reason: 'clean' }))
      .toEqual({ key: 'command:rm', title: 'Codex wants to run a command', description: 'clean', command: 'rm -rf build' })
    expect(codexApprovalResponse('item/commandExecution/requestApproval', 'deny')).toEqual({ decision: 'decline' })
    expect(codexApprovalResponse('item/fileChange/requestApproval', 'session')).toEqual({ decision: 'acceptForSession' })
    expect(codexApprovalResponse('execCommandApproval', 'once')).toEqual({ decision: 'approved' })
  })

  it('drops the act-unchecked flag for Cursor and Antigravity when they should ask', () => {
    expect(buildCursorTurnArgs([], '', false, [], true)).toContain('--force')
    expect(buildCursorTurnArgs([], '', false, [], false)).not.toContain('--force')
    expect(buildAntigravityTurnArgs([], '', false, '', true)).toContain('--dangerously-skip-permissions')
    expect(buildAntigravityTurnArgs(['--dangerously-skip-permissions'], '', false, '', false)).not.toContain('--dangerously-skip-permissions')
  })

  it('asks by default; an agent set to auto acts without asking', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'approvals-')), 'approvals.json')
    expect(agentAsksBeforeActing('claude-code', file)).toBe(true)
    writeAgentApprovalSettings({ agents: { 'claude-code': 'auto' } }, file)
    expect(agentAsksBeforeActing('claude-code', file)).toBe(false)
    expect(agentAsksBeforeActing('codex', file)).toBe(true)
    expect(readAgentApprovalSettings(file)).toEqual({ agents: { 'claude-code': 'auto' } })
    expect(() => writeAgentApprovalSettings({ agents: { codex: 'yolo' } }, file)).toThrow()
  })
})
