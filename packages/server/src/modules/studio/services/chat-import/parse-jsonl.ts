import { basename } from 'node:path'
import { readJsonl } from './guard'
import { cleanTitle, isNoise, seconds, textOf, titleFrom, toolArguments, toolOutput } from './parse-common'
import type { ChatImportLimits, ImportedMessage, ParsedChat } from './types'

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

type Limits = Pick<ChatImportLimits, 'maxFileBytes' | 'maxToolOutputChars' | 'maxMessagesPerChat'>

class Transcript {
  messages: ImportedMessage[] = []
  started = 0
  last = 0
  private toolNames = new Map<string, string>()
  constructor(private limits: Limits) {}

  at(value: unknown): number {
    const ts = seconds(value, this.last || this.started)
    if (ts && (!this.started || ts < this.started)) this.started = ts
    if (ts > this.last) this.last = ts
    return ts
  }

  push(message: ImportedMessage) {
    if (this.messages.length >= this.limits.maxMessagesPerChat) return
    this.messages.push(message)
  }

  user(text: string, timestamp: number) {
    if (!isNoise(text)) this.push({ role: 'user', content: text, timestamp })
  }

  call(message: ImportedMessage, id: string, name: string, args: unknown) {
    const callId = id || `call_${this.messages.length}_${message.tool_calls?.length ?? 0}`
    message.tool_calls = [...(message.tool_calls || []), { id: callId, type: 'function', function: { name: name || 'tool', arguments: toolArguments(args) } }]
    this.toolNames.set(callId, name || 'tool')
  }

  result(callId: string, output: unknown, timestamp: number, name?: string) {
    this.push({
      role: 'tool',
      tool_call_id: callId || null,
      tool_name: name || this.toolNames.get(callId) || null,
      content: toolOutput(output, this.limits.maxToolOutputChars),
      timestamp,
    })
  }
}

function hasBody(message: ImportedMessage): boolean {
  return !!message.content.trim() || !!message.tool_calls?.length
}

function idFromFile(path: string): string {
  return basename(path).match(UUID)?.[1] || basename(path).replace(/\.jsonl$/i, '')
}

/** Claude Code: `~/.claude/projects/<project>/<session>.jsonl`. */
export async function parseClaudeSession(path: string, limits: Limits): Promise<ParsedChat> {
  const t = new Transcript(limits)
  let id = idFromFile(path)
  let cwd: string | null = null
  let title = ''
  let model = ''
  let current: { id: string; message: ImportedMessage } | null = null
  const flush = () => {
    if (current && hasBody(current.message)) t.push(current.message)
    current = null
  }
  for await (const record of readJsonl(path, limits.maxFileBytes)) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'summary' && record.summary) { title ||= cleanTitle(record.summary); continue }
    if (record.type === 'custom-title' && record.customTitle) { title = cleanTitle(record.customTitle); continue }
    if (record.type !== 'user' && record.type !== 'assistant') continue
    if (record.isSidechain) continue
    if (typeof record.sessionId === 'string' && record.sessionId) id = record.sessionId
    if (!cwd && typeof record.cwd === 'string' && record.cwd) cwd = record.cwd
    const ts = t.at(record.timestamp)
    const content = record.message?.content
    if (record.type === 'user') {
      flush()
      if (record.isMeta) continue
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'tool_result') t.result(String(part.tool_use_id || ''), part.content, ts)
        }
        t.user(textOf(content.filter((part: any) => part?.type !== 'tool_result')), ts)
      } else {
        t.user(textOf(content), ts)
      }
      continue
    }
    const messageModel = String(record.message?.model || '')
    if (messageModel && !messageModel.startsWith('<')) model ||= messageModel
    const messageId = String(record.message?.id || record.uuid || '')
    if (!current || current.id !== messageId) {
      flush()
      current = { id: messageId, message: { role: 'assistant', content: '', timestamp: ts } }
    }
    const target: ImportedMessage = current.message
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
    for (const part of parts) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        target.content = target.content ? `${target.content}\n\n${part.text}` : part.text
      } else if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
        target.reasoning = target.reasoning ? `${target.reasoning}\n\n${part.thinking}` : part.thinking
      } else if (part?.type === 'tool_use') {
        t.call(target, String(part.id || ''), String(part.name || ''), part.input)
      }
    }
  }
  flush()
  return { kind: 'claude-code', originalId: id, title: title || titleFrom(t.messages, 'Claude Code chat'), startedAt: t.started, lastActive: t.last, cwd, model, messages: t.messages }
}

function codexOutput(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && 'output' in parsed) return (parsed as any).output
    } catch { /* plain text */ }
    return value
  }
  if (value && typeof value === 'object' && 'content' in value) return (value as any).content
  return value
}

/** Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`. */
export async function parseCodexSession(path: string, limits: Limits): Promise<ParsedChat> {
  const t = new Transcript(limits)
  let id = idFromFile(path)
  let cwd: string | null = null
  let model = ''
  let reasoning = ''
  for await (const record of readJsonl(path, limits.maxFileBytes)) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'session_meta' && record.payload) {
      if (record.payload.id) id = String(record.payload.id)
      if (record.payload.cwd) cwd = String(record.payload.cwd)
      t.at(record.payload.timestamp ?? record.timestamp)
      continue
    }
    if (record.type === 'turn_context' && record.payload) {
      model ||= String(record.payload.model || '')
      cwd ||= record.payload.cwd ? String(record.payload.cwd) : null
      continue
    }
    // Older rollouts wrote items at the top level.
    const item = record.type === 'response_item' ? record.payload : (record.payload ? null : record)
    if (!item || typeof item !== 'object') continue
    const ts = t.at(record.timestamp)
    if (item.type === 'message') {
      const text = textOf(item.content)
      if (item.role === 'user') t.user(text, ts)
      else if (item.role === 'assistant' && text.trim()) {
        t.push({ role: 'assistant', content: text, timestamp: ts, ...(reasoning ? { reasoning } : {}) })
        reasoning = ''
      }
    } else if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary.map((part: any) => part?.text || '').filter(Boolean).join('\n') : ''
      if (summary) reasoning = reasoning ? `${reasoning}\n\n${summary}` : summary
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call') {
      const message: ImportedMessage = { role: 'assistant', content: '', timestamp: ts, ...(reasoning ? { reasoning } : {}) }
      reasoning = ''
      const name = item.name || (item.type === 'local_shell_call' ? 'shell' : 'tool')
      t.call(message, String(item.call_id || item.id || ''), String(name), item.arguments ?? item.input ?? item.action)
      t.push(message)
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output' || item.type === 'local_shell_call_output') {
      t.result(String(item.call_id || ''), codexOutput(item.output), ts)
    }
  }
  return { kind: 'codex', originalId: id, title: titleFrom(t.messages, 'Codex chat'), startedAt: t.started, lastActive: t.last, cwd, model, messages: t.messages }
}

/** OpenClaw: `~/.openclaw/agents/<agent>/sessions/<id>.jsonl`. */
export async function parseOpenClawSession(path: string, limits: Limits): Promise<ParsedChat> {
  const t = new Transcript(limits)
  let id = basename(path).replace(/\.jsonl$/i, '')
  let cwd: string | null = null
  let model = ''
  for await (const record of readJsonl(path, limits.maxFileBytes)) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'session') {
      if (record.id) id = String(record.id)
      if (record.cwd) cwd = String(record.cwd)
      t.at(record.timestamp)
      continue
    }
    if (record.type === 'model_change') { model ||= String(record.modelId || record.model || ''); continue }
    if (record.type !== 'message' || !record.message) continue
    const message = record.message
    const ts = t.at(record.timestamp ?? message.timestamp)
    if (message.role === 'user') {
      t.user(textOf(message.content), ts)
    } else if (message.role === 'assistant') {
      model ||= String(message.model || '')
      const out: ImportedMessage = { role: 'assistant', content: '', timestamp: ts }
      const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }]
      for (const part of parts) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) out.content = out.content ? `${out.content}\n\n${part.text}` : part.text
        else if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) out.reasoning = part.thinking
        else if (part?.type === 'toolCall') t.call(out, String(part.id || ''), String(part.name || ''), part.arguments)
      }
      if (hasBody(out)) t.push(out)
    } else if (message.role === 'toolResult') {
      t.result(String(message.toolCallId || ''), message.content, ts, message.toolName ? String(message.toolName) : undefined)
    }
  }
  return { kind: 'openclaw', originalId: id, title: titleFrom(t.messages, 'OpenClaw chat'), startedAt: t.started, lastActive: t.last, cwd, model, messages: t.messages }
}
