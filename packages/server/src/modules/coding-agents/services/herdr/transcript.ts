import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
  /** Unix seconds. */
  timestamp: number
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: any) => {
      if (typeof part === 'string') return part
      if (part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function seconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return Math.floor(Date.now() / 1000)
}

/** Agent-internal bookkeeping that should not appear as chat text. */
function isNoise(text: string): boolean {
  const trimmed = text.trim()
  return !trimmed
    || trimmed.startsWith('<command-name>')
    || trimmed.startsWith('<local-command-stdout>')
    || trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<user_instructions>')
    || trimmed.startsWith('Caveat: The messages below were generated')
}

/**
 * Parse one transcript line from Claude Code, Codex, or a plain {role, content}
 * record. Tool calls, tool results and system records are skipped: Studio shows
 * the conversation, the live pane shows everything else.
 */
export function parseTranscriptLine(line: string): TranscriptMessage | null {
  let record: any
  try { record = JSON.parse(line) } catch { return null }
  if (!record || typeof record !== 'object') return null

  // Claude Code: {type: 'user'|'assistant', message: {role, content}, timestamp}
  if ((record.type === 'user' || record.type === 'assistant') && record.message) {
    if (record.isMeta || record.isSidechain) return null
    const content = record.message.content
    if (Array.isArray(content) && content.some((part: any) => part?.type === 'tool_result')) return null
    const text = textOf(content)
    if (isNoise(text)) return null
    return { role: record.type, content: text, timestamp: seconds(record.timestamp) }
  }

  // Codex rollout: {type: 'response_item', payload: {type: 'message', role, content}}
  if (record.type === 'response_item' && record.payload?.type === 'message') {
    const role = record.payload.role
    if (role !== 'user' && role !== 'assistant') return null
    const text = textOf(record.payload.content)
    if (isNoise(text)) return null
    return { role, content: text, timestamp: seconds(record.timestamp) }
  }

  // Generic.
  if ((record.role === 'user' || record.role === 'assistant') && record.content != null) {
    const text = textOf(record.content)
    if (isNoise(text)) return null
    return { role: record.role, content: text, timestamp: seconds(record.timestamp) }
  }
  return null
}

/**
 * Read complete lines appended after `offset`. Returns the new offset, which
 * stops before any trailing partial line so it is re-read once finished.
 */
export async function readTranscriptFrom(path: string, offset: number, maxBytes = 4 * 1024 * 1024): Promise<{ messages: TranscriptMessage[]; offset: number }> {
  const info = await stat(path)
  const start = info.size < offset ? 0 : offset
  if (info.size === start) return { messages: [], offset: start }
  const length = Math.min(info.size - start, maxBytes)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const text = buffer.toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline < 0) return { messages: [], offset: start }
    const complete = text.slice(0, lastNewline + 1)
    const messages = complete.split('\n').map(parseTranscriptLine).filter((m): m is TranscriptMessage => m !== null)
    return { messages, offset: start + Buffer.byteLength(complete, 'utf8') }
  } finally {
    await handle.close()
  }
}

async function findFile(root: string, match: (name: string) => boolean, depth: number): Promise<string | null> {
  if (depth < 0) return null
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    if (entry.isFile() && match(entry.name)) return join(root, entry.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findFile(join(root, entry.name), match, depth - 1)
    if (found) return found
  }
  return null
}

/** Locate a transcript when herdr only reported a session id. */
export async function locateTranscript(agent: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(sessionId)) return null
  const home = homedir()
  if (agent === 'claude-code') {
    const root = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'projects') : join(home, '.claude', 'projects')
    return findFile(root, name => name === `${sessionId}.jsonl`, 1)
  }
  if (agent === 'codex') {
    const root = join(env.CODEX_HOME || join(home, '.codex'), 'sessions')
    return findFile(root, name => name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`), 3)
  }
  return null
}
