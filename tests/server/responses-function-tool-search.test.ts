import { describe, expect, it } from 'vitest'
import { openAiChatSseToResponsesEvents, type CanonicalResponsesEvent } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses-stream'
import { openAiChatToResponses, responseMcpToolRoutes } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'
import { portableResponsesResult } from '../../packages/server/src/modules/coding-agents/protocol/adapters/portable-responses'

// Hermes offers its deferred-tool search as an ordinary function named `tool_search`; Codex declares the
// Responses API's built-in `tool_search` tool. Only the latter may come back as a `tool_search_call`:
// Hermes ignores that item type, saw no tool call, and ended its turn right after saying what it would do.
const hermesBody = { tools: [{ type: 'function', name: 'tool_search', parameters: { type: 'object', properties: { queries: { type: 'array' } } } }] }
const codexBody = { tools: [{ type: 'tool_search', execution: 'client', parameters: { type: 'object', properties: { query: { type: 'string' } } } }] }

function bytes(lines: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder()
  return (async function* () { for (const l of lines) yield enc.encode(l) })()
}

const chatSse = [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: "I'll look up the process tool." } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'tool_search', arguments: '' } }] } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"queries":["process kill"]}' } }] } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
  'data: [DONE]\n\n',
]

async function streamed(body: any) {
  const events: CanonicalResponsesEvent[] = []
  for await (const e of openAiChatSseToResponsesEvents(bytes(chatSse), { model: 'm', mcpToolRoutes: responseMcpToolRoutes(body) })) events.push(e)
  const done = events.filter(e => e.type === 'response.output_item.done').map(e => (e.data as any).item)
  const deltas = events.filter(e => e.type === 'response.function_call_arguments.delta').length
  return { done, deltas }
}

describe('a function named tool_search', () => {
  it('stays a function_call for a client that offered it as a function (Hermes), streaming', async () => {
    const { done, deltas } = await streamed(hermesBody)
    const call = done.find(i => i.type === 'function_call')
    expect(call).toMatchObject({ type: 'function_call', name: 'tool_search', arguments: '{"queries":["process kill"]}' })
    expect(done.some(i => i.type === 'tool_search_call')).toBe(false)
    expect(deltas).toBeGreaterThan(0)
  })

  it('stays a function_call without streaming, and through the portable Responses path', () => {
    const chat = { choices: [{ message: { content: "I'll look it up.", tool_calls: [{ id: 'c1', function: { name: 'tool_search', arguments: '{"queries":["x"]}' } }] } }] }
    const out = openAiChatToResponses(chat, { model: 'm', mcpToolRoutes: responseMcpToolRoutes(hermesBody) }).output
    expect(out.find((i: any) => i.name === 'tool_search' || i.type === 'tool_search_call')).toMatchObject({ type: 'function_call', name: 'tool_search' })
    const portable = portableResponsesResult({ output: [{ type: 'function_call', name: 'tool_search', call_id: 's1', arguments: '{"queries":["x"]}' }] }, hermesBody).output[0]
    expect(portable).toMatchObject({ type: 'function_call', name: 'tool_search' })
  })

  it('is still the built-in tool_search_call for a client that declared the built-in tool (Codex)', async () => {
    const { done } = await streamed(codexBody)
    expect(done.find(i => i.type === 'tool_search_call')).toMatchObject({ type: 'tool_search_call', arguments: { queries: ['process kill'] } })
    const chat = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'tool_search', arguments: '{"query":"x"}' } }] } }] }
    expect(openAiChatToResponses(chat, { model: 'm', mcpToolRoutes: responseMcpToolRoutes(codexBody) }).output[0]).toMatchObject({ type: 'tool_search_call' })
  })
})
