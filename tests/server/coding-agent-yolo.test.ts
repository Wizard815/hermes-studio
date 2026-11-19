import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatApprovalMode, chatApprovalOverride, launchAsks, setChatApprovalOverride, toggleChatYolo, writeAgentApprovalSettings } from '../../packages/server/src/modules/coding-agents/services/approvals'
import { parseCodingAgentSessionCommand, toggleCodingAgentYolo } from '../../packages/server/src/modules/coding-agents/services/session-command'
import { applyResponseStreamEvent, flushResponseRunToDb } from '../../packages/server/src/modules/studio/services/chat-run/response-stream'
import { extractResponseText } from '../../packages/server/src/modules/studio/services/chat-run/response-utils'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { configureRunState } from '../../packages/server/src/modules/studio/public/run-state'
import { codingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

describe('/yolo switches one coding-agent chat to acting without asking, and back', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'yolo-'))

  it('turns this chat to auto, then back to the agent\'s own mode', () => {
    const root = dir()
    const agents = join(root, 'approvals.json')
    const chats = join(root, 'chat-approvals.json')
    writeAgentApprovalSettings({ agents: { codex: 'guarded' } }, agents)
    expect(toggleChatYolo('codex', 'chat-a', agents, chats)).toEqual({ mode: 'auto', previous: 'guarded', yolo: true })
    expect(chatApprovalMode('codex', 'chat-a', agents, chats)).toBe('auto')
    // Only this chat: another chat with the same agent still follows the agent's mode.
    expect(chatApprovalMode('codex', 'chat-b', agents, chats)).toBe('guarded')
    expect(toggleChatYolo('codex', 'chat-a', agents, chats)).toEqual({ mode: 'guarded', previous: 'auto', yolo: false })
    expect(chatApprovalOverride('chat-a', chats)).toBeUndefined()
  })

  it('turns asking on for this chat when the agent itself is set to never ask', () => {
    const root = dir()
    const agents = join(root, 'approvals.json')
    const chats = join(root, 'chat-approvals.json')
    writeAgentApprovalSettings({ agents: { codex: 'auto' } }, agents)
    expect(toggleChatYolo('codex', 'chat-a', agents, chats)).toEqual({ mode: 'ask', previous: 'auto', yolo: false })
    expect(toggleChatYolo('codex', 'chat-a', agents, chats)).toEqual({ mode: 'auto', previous: 'ask', yolo: true })
  })

  it('decides whether the chat\'s next turn asks; a workflow step that requires approval still asks', () => {
    setChatApprovalOverride('chat-launch', null)
    writeAgentApprovalSettings({ agents: { codex: 'ask' } })
    const launch = { agentId: 'codex', command: 'codex', sessionId: 'chat-launch' }
    expect(launchAsks(launch)).toBe(true)
    setChatApprovalOverride('chat-launch', 'auto')
    expect(launchAsks(launch)).toBe(false)
    expect(launchAsks({ ...launch, sessionId: 'another-chat' })).toBe(true)
    expect(launchAsks({ ...launch, approvalRequired: true })).toBe(true)
    setChatApprovalOverride('chat-launch', null)
  })

  it('is a coding-agent chat command', () => {
    expect(parseCodingAgentSessionCommand('/yolo')).toEqual({ name: 'yolo', rawName: 'yolo', args: '' })
    expect(parseCodingAgentSessionCommand('/YOLO ')?.name).toBe('yolo')
  })
})

describe('the /yolo note and what it does to a running chat', () => {
  const sessionId = `yolo-run-${Date.now().toString(36)}`
  const emitted: Array<{ event: string; payload: any }> = []

  beforeAll(() => { initAllHermesTables() })
  beforeEach(() => {
    emitted.length = 0
    writeAgentApprovalSettings({ agents: { codex: 'ask' } })
    setChatApprovalOverride(sessionId, null)
    configureRunState({
      applyResponseStreamEvent, calcAndUpdateUsage: async () => ({}), completeWorkspaceRunCheckpoint: () => undefined,
      extractResponseText, flushResponseRunToDb,
      getChatRunServer: () => ({ emitExternalEvent: (_id: string, event: string, payload: unknown) => { emitted.push({ event, payload }) } }),
      getOrCreateSession: () => ({ messages: [], isWorking: false, events: [], queue: [] }),
      startWorkspaceRunCheckpoint: () => undefined, updateContextTokenUsage: () => undefined,
    } as any)
    codingAgentRunManager.start({ agentSessionId: sessionId, agentId: 'codex', mode: 'global', profile: 'default', provider: 'custom:llama',
      model: 'qwen3-coder-next', sessionId, command: 'codex', args: [], shellCommand: '', workspaceDir: tmpdir() })
  })
  afterEach(() => {
    codingAgentRunManager.stop(sessionId)
    setChatApprovalOverride(sessionId, null)
  })

  const run = () => (codingAgentRunManager as any).runs.get(sessionId)
  const command = { key: 'command:rm', action: { kind: 'command' as const, command: 'rm -rf build' }, title: 'Codex wants to run a command', command: 'rm -rf build' }

  it('says which mode is now on, and approves what the agent is waiting on', async () => {
    const waiting = codingAgentRunManager.askApproval(run(), command)
    expect(emitted.some(entry => entry.event === 'approval.requested')).toBe(true)

    const on = toggleCodingAgentYolo(sessionId, 'codex', true)
    expect(on.yolo).toBe(true)
    expect(on.message).toContain('YOLO on for this chat: Codex now acts without asking')
    expect(on.message).toContain('The approval it was waiting on is approved.')
    expect(on.message).toContain('Send /yolo again to go back to: Codex asks before running commands')
    expect(await waiting).toBe('once')
    expect(emitted.find(entry => entry.event === 'approval.resolved')?.payload).toMatchObject({ choice: 'once', resolved: true })
    // Later questions in this chat are answered without a card.
    emitted.length = 0
    expect(await codingAgentRunManager.askApproval(run(), command)).toBe('once')
    expect(emitted.some(entry => entry.event === 'approval.requested')).toBe(false)

    const off = toggleCodingAgentYolo(sessionId, 'codex', false)
    expect(off).toMatchObject({ yolo: false, mode: 'ask', previous: 'auto' })
    expect(off.message).toBe('YOLO off for this chat: Codex asks before running commands and before writing outside this chat\'s folder. Send /yolo again to let it act without asking.')
    void codingAgentRunManager.askApproval(run(), command)
    expect(emitted.some(entry => entry.event === 'approval.requested')).toBe(true)
  })
})
