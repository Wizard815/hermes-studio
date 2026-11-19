import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Codex's app-server protocol: the test plays Codex and sends its notifications.
const appServer = vi.hoisted(() => ({ notify: undefined as undefined | ((method: string, params: any) => void), finish: undefined as undefined | (() => void) }))
vi.mock('../../packages/server/src/modules/coding-agents/services/codex/app-server-turn', () => ({
  CodexAppServerTurn: class {
    constructor(_child: unknown, handlers: { notify: (method: string, params: any) => void }) { appServer.notify = handlers.notify }
    run() { return new Promise<void>(resolve => { appServer.finish = resolve }) }
  },
}))

import { applyResponseStreamEvent, flushResponseRunToDb } from '../../packages/server/src/modules/studio/services/chat-run/response-stream'
import { extractResponseText } from '../../packages/server/src/modules/studio/services/chat-run/response-utils'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { configureRunState } from '../../packages/server/src/modules/studio/public/run-state'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { openAiChatSseToResponsesEvents, type CanonicalResponsesEvent } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses-stream'
import { writeAgentApprovalSettings } from '../../packages/server/src/modules/coding-agents/services/approvals'

// What a llama-server (Qwen3-Coder, --jinja) streams: one token per chunk.
const TEXT = "I'll help you create a Python script to connect to HPE Aruba switches and APs via COM port. Let me create the complete script for you:"
const REASONING = 'The user wants a serial console script. Plan the connection first.'
const tokens = (text: string) => text.match(/\S+\s*|\s+/g) || []

function llamaSse(options: { reasoning?: boolean } = {}): string {
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'qwen3-coder-next', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  return [
    frame({ role: 'assistant', content: null }),
    ...(options.reasoning ? tokens(REASONING).map(token => frame({ reasoning_content: token })) : []),
    ...tokens(TEXT).map(token => frame({ content: token })),
    frame({}, 'stop'),
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 43800, completion_tokens: 292, total_tokens: 44092, prompt_tokens_details: { cached_tokens: 24000 } } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
}

/** The bytes as the network delivers them: split at arbitrary points, not at frame boundaries. */
async function* bytes(text: string, size = 7): AsyncGenerator<Uint8Array> {
  const encoded = new TextEncoder().encode(text)
  for (let index = 0; index < encoded.length; index += size) yield encoded.slice(index, index + size)
}

async function gatewayEvents(options: { reasoning?: boolean } = {}): Promise<CanonicalResponsesEvent[]> {
  const events: CanonicalResponsesEvent[] = []
  for await (const event of openAiChatSseToResponsesEvents(bytes(llamaSse(options)), { model: 'qwen3-coder-next' })) events.push(event)
  return events
}

describe('the gateway translates a streamed Chat Completions reply exactly once', () => {
  it('turns each llama-server token into one Responses text delta, in order, complete', async () => {
    const events = await gatewayEvents({ reasoning: true })
    const deltas = events.filter(event => event.type === 'response.output_text.delta').map(event => event.data.delta)
    expect(deltas).toEqual(tokens(TEXT))
    const reasoning = events.filter(event => event.type === 'response.reasoning_summary_text.delta').map(event => event.data.delta)
    expect(reasoning.join('')).toBe(REASONING)
    const completed = events.find(event => event.type === 'response.completed')!.data.response as any
    expect(completed.output.find((item: any) => item.type === 'message').content[0].text).toBe(TEXT)
    expect(completed.usage).toMatchObject({ input_tokens: 43800, output_tokens: 292 })
    expect(events.filter(event => event.type === 'response.completed')).toHaveLength(1)
  })
})

describe('a Codex chat shows the reply exactly once', () => {
  let workspaceDir = ''
  let sessionId = ''
  let manager: CodingAgentRunManager
  const emitted: Array<{ event: string; payload: any }> = []

  beforeAll(() => { initAllHermesTables() })

  beforeEach(async () => {
    emitted.length = 0
    appServer.notify = undefined
    appServer.finish = undefined
    workspaceDir = await mkdtemp(join(tmpdir(), 'codex-once-'))
    sessionId = `codex-once-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    configureRunState({
      applyResponseStreamEvent,
      calcAndUpdateUsage: async () => ({}),
      completeWorkspaceRunCheckpoint: () => undefined,
      extractResponseText,
      flushResponseRunToDb,
      getChatRunServer: () => ({ emitExternalEvent: (_id: string, event: string, payload: unknown) => { emitted.push({ event, payload }) } }),
      getOrCreateSession: () => ({ messages: [], isWorking: false, events: [], queue: [] }),
      startWorkspaceRunCheckpoint: () => undefined,
      updateContextTokenUsage: () => undefined,
    } as any)
    manager = new CodingAgentRunManager()
  })

  afterEach(async () => {
    manager?.stop(sessionId)
    writeAgentApprovalSettings({ agents: { codex: 'ask' } })
    if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true })
  })

  async function startCodex(script: string) {
    const command = join(workspaceDir, 'codex')
    await writeFile(command, `#!/bin/sh\n${script}\n`)
    await chmod(command, 0o755)
    manager.start({ agentSessionId: sessionId, agentId: 'codex', mode: 'global', profile: 'default', provider: 'custom:llama',
      model: 'qwen3-coder-next', sessionId, command, args: [], shellCommand: '', workspaceDir })
    manager.send(sessionId, 'write a python script for aruba switches')
  }

  const chatText = (kind = 'message.delta') => emitted.filter(entry => entry.event === kind).map(entry => String(entry.payload?.delta ?? '')).join('')

  async function completed() {
    await vi.waitFor(() => expect(emitted.some(entry => entry.event === 'run.completed' || entry.event === 'run.failed')).toBe(true), { timeout: 5000 })
    return emitted.find(entry => entry.event === 'run.completed')
  }

  it('on the app-server (Codex asks before acting), the proxy copy of the stream is not shown again', async () => {
    writeAgentApprovalSettings({ agents: { codex: 'ask' } })
    await startCodex('cat >/dev/null')
    await vi.waitFor(() => expect(appServer.notify).toBeTypeOf('function'))
    // Codex reads the gateway's stream and re-announces each piece; both reach Studio, interleaved.
    const proxy = (await gatewayEvents({ reasoning: true })).filter(event => event.type !== 'response.created')
    let reasoningIndex = 0
    let textIndex = 0
    for (const event of proxy) {
      manager.handleResponseEvent(sessionId, event)
      if (event.type === 'response.reasoning_summary_text.delta') {
        appServer.notify!('item/reasoning/summaryTextDelta', { itemId: 'rs_1', summaryIndex: 0, delta: tokens(REASONING)[reasoningIndex++] })
      }
      if (event.type === 'response.output_text.delta') {
        appServer.notify!('item/agentMessage/delta', { itemId: 'msg_1', delta: tokens(TEXT)[textIndex++] })
      }
    }
    appServer.notify!('item/completed', { item: { type: 'reasoning', id: 'rs_1', summary: [REASONING], content: [] } })
    appServer.notify!('item/completed', { item: { type: 'agentMessage', id: 'msg_1', text: TEXT } })
    appServer.notify!('turn/completed', { turn: { id: 't1', status: 'completed' } })
    appServer.finish!()

    const done = await completed()
    expect(chatText()).toBe(TEXT)
    expect(emitted.filter(entry => entry.event === 'message.delta').map(entry => entry.payload.delta)).toEqual(tokens(TEXT))
    expect(chatText('reasoning.delta')).toBe(REASONING)
    expect(done?.payload.output).toBe(TEXT)
  })

  it('on exec (Codex acts without asking), the proxy streams the reply once and the final items add nothing', async () => {
    writeAgentApprovalSettings({ agents: { codex: 'auto' } })
    const lines = [
      { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: REASONING } },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: TEXT } },
      { type: 'turn.completed', usage: { input_tokens: 43800, cached_input_tokens: 24000, output_tokens: 292 } },
    ].map(line => `'${JSON.stringify(line).replace(/'/g, `'\\''`)}'`)
    // Codex prints its JSONL after the model reply streamed through the proxy.
    await startCodex(`sleep 0.4\nprintf '%s\\n' ${lines.join(' ')}`)
    for (const event of (await gatewayEvents({ reasoning: true })).filter(event => event.type !== 'response.created')) manager.handleResponseEvent(sessionId, event)

    expect(await completed()).toBeTruthy()
    expect(chatText()).toBe(TEXT)
    expect(chatText('reasoning.delta')).toBe(REASONING)
  })
})
