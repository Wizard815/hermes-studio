import { createHash } from 'node:crypto'
import type { HistoryToolCall } from './loop-detector'

/**
 * Reads the current turn out of a model request that a coding agent sends
 * through Studio's model gateway: the tool calls since the user's last message
 * (and whether each failed, where the protocol says so) and a key for the turn,
 * so a new prompt from the user starts a new run.
 */
export type GatewayProtocol = 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'gemini_contents'

export interface GatewayTurn {
  /** Changes when the user sends a new message (count of user messages + the last one's hash). */
  turnKey: string
  calls: HistoryToolCall[]
}

const asArray = (value: unknown): any[] => Array.isArray(value) ? value : []

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return asArray(content).map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('')
}

function key(count: number, text: string): string {
  return `${count}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`
}

function chatCompletions(body: any): GatewayTurn {
  const messages = asArray(body?.messages)
  let start = -1
  let users = 0
  messages.forEach((message, index) => { if (message?.role === 'user') { start = index; users++ } })
  const calls: HistoryToolCall[] = []
  const byId = new Map<string, HistoryToolCall>()
  for (const message of messages.slice(start + 1)) {
    if (message?.role === 'assistant') {
      for (const call of asArray(message.tool_calls)) {
        const entry = { id: String(call?.id || ''), name: String(call?.function?.name || call?.name || ''), args: call?.function?.arguments ?? call?.arguments, answered: false }
        calls.push(entry)
        if (entry.id) byId.set(entry.id, entry)
      }
    } else if (message?.role === 'tool') {
      const entry = byId.get(String(message.tool_call_id || ''))
      if (entry) entry.answered = true
    }
  }
  return { turnKey: key(users, start >= 0 ? textOf(messages[start]?.content) : ''), calls }
}

function anthropicMessages(body: any): GatewayTurn {
  const messages = asArray(body?.messages)
  // A user message made only of tool results continues the turn; one with text starts it.
  const isPrompt = (message: any) => message?.role === 'user'
    && (typeof message.content === 'string' || asArray(message.content).some(block => block?.type !== 'tool_result'))
  let start = -1
  let users = 0
  messages.forEach((message, index) => { if (isPrompt(message)) { start = index; users++ } })
  const calls: HistoryToolCall[] = []
  const byId = new Map<string, HistoryToolCall>()
  for (const message of messages.slice(start + 1)) {
    for (const block of asArray(message?.content)) {
      if (message.role === 'assistant' && block?.type === 'tool_use') {
        const entry = { id: String(block.id || ''), name: String(block.name || ''), args: block.input, answered: false }
        calls.push(entry)
        if (entry.id) byId.set(entry.id, entry)
      } else if (message.role === 'user' && block?.type === 'tool_result') {
        const entry = byId.get(String(block.tool_use_id || ''))
        if (entry) { entry.answered = true; entry.failed = block.is_error === true }
      }
    }
  }
  return { turnKey: key(users, start >= 0 ? textOf(messages[start]?.content) : ''), calls }
}

function codexResponses(body: any): GatewayTurn {
  if (typeof body?.input === 'string') return { turnKey: key(1, body.input), calls: [] }
  const items = asArray(body?.input)
  const isPrompt = (item: any) => item?.role === 'user' && (item.type === undefined || item.type === 'message')
  let start = -1
  let users = 0
  items.forEach((item, index) => { if (isPrompt(item)) { start = index; users++ } })
  const calls: HistoryToolCall[] = []
  const byId = new Map<string, HistoryToolCall>()
  for (const item of items.slice(start + 1)) {
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const entry = { id: String(item.call_id || item.id || ''), name: String(item.name || ''), args: item.arguments ?? item.input, answered: false }
      calls.push(entry)
      if (entry.id) byId.set(entry.id, entry)
    } else if (item?.type === 'local_shell_call') {
      const entry = { id: String(item.call_id || item.id || ''), name: 'shell', args: item.action?.command ?? item.action, answered: false }
      calls.push(entry)
      if (entry.id) byId.set(entry.id, entry)
    } else if (typeof item?.type === 'string' && item.type.endsWith('_output')) {
      const entry = byId.get(String(item.call_id || ''))
      if (entry) entry.answered = true
    }
  }
  return { turnKey: key(users, start >= 0 ? textOf(items[start]?.content) : ''), calls }
}

function geminiContents(body: any): GatewayTurn {
  const contents = asArray(body?.contents)
  const isPrompt = (content: any) => content?.role !== 'model' && asArray(content?.parts).some(part => typeof part?.text === 'string')
  let start = -1
  let users = 0
  contents.forEach((content, index) => { if (isPrompt(content)) { start = index; users++ } })
  const calls: HistoryToolCall[] = []
  const pending: HistoryToolCall[] = []
  for (const content of contents.slice(start + 1)) {
    for (const part of asArray(content?.parts)) {
      if (part?.functionCall) {
        const entry = { id: '', name: String(part.functionCall.name || ''), args: part.functionCall.args, answered: false }
        calls.push(entry)
        pending.push(entry)
      } else if (part?.functionResponse) {
        const entry = pending.shift()
        if (entry) entry.answered = true
      }
    }
  }
  return { turnKey: key(users, start >= 0 ? textOf(asArray(contents[start]?.parts)) : ''), calls }
}

export function readGatewayTurn(protocol: GatewayProtocol, body: unknown): GatewayTurn {
  try {
    if (protocol === 'chat_completions') return chatCompletions(body)
    if (protocol === 'anthropic_messages') return anthropicMessages(body)
    if (protocol === 'gemini_contents') return geminiContents(body)
    return codexResponses(body)
  } catch {
    return { turnKey: '', calls: [] }
  }
}
