import type { ImportedMessage } from './types'

export function seconds(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value)
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return seconds(numeric, fallback)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return fallback
}

/** Text parts of a content value (string, or an array of text blocks). */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: any) => {
      if (typeof part === 'string') return part
      if (part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Agent bookkeeping that is not part of the conversation. */
export function isNoise(text: string): boolean {
  const trimmed = text.trim()
  return !trimmed
    || trimmed.startsWith('<command-name>')
    || trimmed.startsWith('<command-message>')
    || trimmed.startsWith('<local-command-stdout>')
    || trimmed.startsWith('<local-command-stderr>')
    || trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<user_instructions>')
    || trimmed.startsWith('# AGENTS.md instructions')
    || trimmed.startsWith('<permissions instructions>')
    || trimmed.startsWith('Caveat: The messages below were generated')
}

export function toolOutput(value: unknown, maxChars: number): string {
  let text = typeof value === 'string' ? value : textOf(value)
  if (!text && value != null && typeof value !== 'string') {
    try { text = JSON.stringify(value) } catch { text = '' }
  }
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} more characters not imported]`
}

export function toolArguments(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? {}) } catch { return '{}' }
}

export function titleFrom(messages: ImportedMessage[], fallback: string): string {
  const first = messages.find(message => message.role === 'user' && message.content.trim())
  const text = (first?.content || '').replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export function cleanTitle(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}
