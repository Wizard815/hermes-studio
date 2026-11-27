import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ChatMessenger, type ChatRow } from '../../packages/server/src/modules/studio/services/chat-messages/service'

// Live check of chats messaging each other (docs/chat-messages.md) with real models on
// OpenRouter: each chat is a model with the real ekko_studio_use_chats tool description,
// and its calls go to the real ChatMessenger. Studio's chat runs are stood in by a small
// model loop with one history per chat. Stops once it has spent LIVE_BUDGET_USD.
const MODEL = process.env.LIVE_CHAT_MODEL || 'anthropic/claude-haiku-5.5'
const BUDGET = Number(process.env.LIVE_BUDGET_USD || 0.5)
let spent = 0

async function complete(messages: any[], tools: any[]) {
  if (spent >= BUDGET) throw new Error(`Live budget of $${BUDGET} used up ($${spent.toFixed(4)})`)
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer proxy-injected' },
      body: JSON.stringify({ model: MODEL, messages, tools, max_tokens: 800, usage: { include: true } }),
    })
    const body: any = await response.json().catch(() => ({}))
    spent += Number(body?.usage?.cost || 0)
    if (response.ok && body.choices?.[0]) return body.choices[0].message
    if (attempt >= 2) throw new Error(`${MODEL}: ${response.status} ${JSON.stringify(body).slice(0, 300)}`)
  }
}

// The tool as agents see it, read from the MCP server.
const mcp = readFileSync(resolve(__dirname, '../../bin/ekko-studio-mcp.mjs'), 'utf8')
const description = /name: 'ekko_studio_use_chats',\s*toolset: 'use',\s*description: '((?:[^'\\]|\\.)*)'/.exec(mcp)![1].replace(/\\'/g, '\'')
const tools = [{ type: 'function', function: { name: 'ekko_studio_use_chats', description, parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'ask', 'send'] }, arguments: { type: 'object' } }, required: ['action'] } } }]
const person = { id: 1, role: 'user' }

describe.runIf(process.env.LIVE_CHATS === '1')('TestChats_live', () => {
  it('a chat asks another chat and gets its answer, and a sent message comes back as a turn', async () => {
    const rows: Record<string, ChatRow> = {
      argos: { id: 'argos', title: 'Argos tests', profile: 'default', studio_user_id: '1' },
      planner: { id: 'planner', title: 'Weekend planner', profile: 'default', studio_user_id: '1' },
    }
    const system: Record<string, string> = {
      argos: 'You are a Studio chat working on the Argos repo. Facts you know from this chat: the Argos test server listens on port 9477, and `make test-dev` runs the Go tests in about 40 seconds. Answer briefly.',
      planner: 'You are a Studio chat helping your person plan their week. You do not know anything about the Argos repo yourself. Answer briefly.',
    }
    const history: Record<string, any[]> = { argos: [], planner: [] }
    const shown: string[] = []
    const calls: string[] = []
    const busy = new Set<string>()
    const messenger: ChatMessenger = new ChatMessenger({
      getSession: id => rows[id] ?? null,
      list: () => Object.values(rows),
      busy: id => busy.has(id),
      run: input => run(input),
    })
    async function run({ sessionId, input, display }: { sessionId: string; input: string; display: string }) {
      shown.push(`[${sessionId}] ${display}`)
      const messages = history[sessionId]
      messages.push({ role: 'user', content: input })
      for (let step = 0; step < 6; step++) {
        const reply = await complete([{ role: 'system', content: system[sessionId] }, ...messages], tools)
        messages.push({ role: 'assistant', content: reply.content || '', ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) })
        if (!reply.tool_calls?.length) return { ok: true, output: String(reply.content || '') }
        for (const call of reply.tool_calls) {
          const args = JSON.parse(call.function.arguments || '{}')
          const fields = { ...(args.arguments || {}) }
          calls.push(`${sessionId} ${args.action} ${fields.chat || ''}`)
          let result: unknown
          try {
            result = args.action === 'list' ? messenger.list({ from: sessionId }, person)
              : args.action === 'ask' ? await messenger.ask({ from: sessionId, to: fields.chat, text: fields.text }, person)
                : messenger.send({ from: sessionId, to: fields.chat, text: fields.text }, person)
          } catch (error) { result = { error: (error as Error).message } }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
        }
      }
      return { ok: false, error: 'too many steps' }
    }
    // The person's own turn in the planner (Studio marks a chat busy while its turn runs).
    const personTurn = async (text: string) => {
      busy.add('planner')
      try { return await run({ sessionId: 'planner', input: text, display: text }) } finally { busy.delete('planner') }
    }

    const first = await personTurn('What port does the Argos test server use? My Argos chat knows: ask it.')
    console.log('calls:', calls.join(' | '))
    console.log('planner answered:', first.output)
    expect(calls.some(call => call.startsWith('planner ask argos'))).toBe(true)
    expect(first.output).toContain('9477')

    calls.length = 0
    const second = await personTurn('Send my Argos chat a note asking how long make test-dev takes. Don\'t wait for it; just tell me you sent it.')
    console.log('planner said:', second.output)
    await messenger.idle()
    console.log('calls:', calls.join(' | '))
    console.log('shown:\n' + shown.join('\n'))
    expect(calls.some(call => call.startsWith('planner send argos'))).toBe(true)
    const back = shown.find(line => line.startsWith('[planner] ↩ Reply from “Argos tests” to'))
    expect(back).toMatch(/40/)
    console.log(`spent $${spent.toFixed(4)}`)
  }, 300_000)
})
