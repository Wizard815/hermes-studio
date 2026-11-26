import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkedSourcePath } from './guard'
import { cleanTitle, seconds, toolArguments, toolOutput } from './parse-common'
import type { ChatImportLimits, ImportedMessage } from './types'

const COMPRESSION_END_REASONS = new Set(['compression', 'compressed'])

type Db = { prepare: (sql: string) => { all: (...params: any[]) => any[]; get: (...params: any[]) => any }; close: () => void }

export interface HermesDbChat {
  originalId: string
  sessionIds: string[]
  title: string
  startedAt: number
  lastActive: number
  messageCount: number
  userMessages: number
  cwd: string | null
  model: string
}

/**
 * Open another install's state.db read-only. A database with an unmerged
 * write-ahead log that cannot be opened in place is copied to a temporary
 * folder first, so the source is never written.
 */
export async function withHermesDb<T>(path: string, read: (db: Db, columns: { sessions: Set<string>; messages: Set<string> }) => T): Promise<T> {
  checkedSourcePath(path)
  const { DatabaseSync } = await import('node:sqlite')
  let db: Db
  let copy = ''
  try {
    db = new DatabaseSync(path, { open: true, readOnly: true }) as unknown as Db
    db.prepare('SELECT 1 FROM sessions LIMIT 1').get()
  } catch {
    copy = await mkdtemp(join(tmpdir(), 'studio-chat-import-db-'))
    await copyFile(path, join(copy, 'state.db'))
    if (existsSync(`${path}-wal`)) await copyFile(`${path}-wal`, join(copy, 'state.db-wal'))
    db = new DatabaseSync(join(copy, 'state.db'), { open: true }) as unknown as Db
  }
  try {
    const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))
    const sessions = columns('sessions')
    const messages = columns('messages')
    if (!sessions.has('id') || !messages.has('session_id')) throw new Error('Not a Hermes state.db')
    return read(db, { sessions, messages })
  } finally {
    db.close()
    if (copy) await rm(copy, { recursive: true, force: true })
  }
}

export async function isHermesStateDb(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    return await withHermesDb(path, () => true)
  } catch {
    return false
  }
}

function activeFilter(columns: Set<string>, alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  const parts: string[] = []
  if (columns.has('active')) parts.push(`COALESCE(${prefix}active, 1) != 0`)
  if (columns.has('_compressed_summary')) parts.push(`COALESCE(${prefix}_compressed_summary, 0) = 0`)
  return parts.length ? ` AND ${parts.join(' AND ')}` : ''
}

/** Every conversation in a Hermes state.db; compression continuations are merged into one chat. */
export async function listHermesChats(path: string): Promise<HermesDbChat[]> {
  return withHermesDb(path, (db, columns) => {
    const pick = (name: string, fallback = 'NULL') => columns.sessions.has(name) ? name : `${fallback} AS ${name}`
    const rows = db.prepare(`SELECT id, ${pick('parent_session_id')}, ${pick('end_reason')}, ${pick('title')}, ${pick('started_at', '0')},
      ${pick('ended_at')}, ${pick('model')}, ${pick('cwd')} FROM sessions ORDER BY started_at, id`).all() as any[]
    const counts = new Map<string, { all: number; user: number; first: string; last: number }>()
    for (const row of db.prepare(`SELECT session_id, COUNT(*) AS n, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS u, MAX(timestamp) AS last
      FROM messages WHERE role IN ('user', 'assistant', 'tool')${activeFilter(columns.messages)} GROUP BY session_id`).all() as any[]) {
      counts.set(String(row.session_id), { all: Number(row.n) || 0, user: Number(row.u) || 0, first: '', last: seconds(row.last) })
    }
    const byId = new Map(rows.map(row => [String(row.id), row]))
    const continuation = new Map<string, string>()
    for (const row of rows) {
      const parent = row.parent_session_id ? byId.get(String(row.parent_session_id)) : null
      if (!parent || !COMPRESSION_END_REASONS.has(String(parent.end_reason || ''))) continue
      // The latest child of a compressed session continues it; rows are ordered by start.
      continuation.set(String(parent.id), String(row.id))
    }
    const continuing = new Set(continuation.values())
    const chats: HermesDbChat[] = []
    for (const root of rows) {
      const rootId = String(root.id)
      if (continuing.has(rootId)) continue
      const chain = [root]
      const seen = new Set([rootId])
      for (let next = continuation.get(rootId); next && !seen.has(next) && chain.length < 100; next = continuation.get(next)) {
        seen.add(next)
        chain.push(byId.get(next))
      }
      const ids = chain.map(row => String(row.id))
      const tally = ids.map(id => counts.get(id)).filter(Boolean) as Array<{ all: number; user: number; last: number }>
      const latest = chain[chain.length - 1]
      const titled = [...chain].reverse().find(row => row.title)
      let title = titled ? cleanTitle(titled.title) : ''
      if (!title) {
        const first = db.prepare(`SELECT content FROM messages WHERE session_id = ? AND role = 'user'${activeFilter(columns.messages)} ORDER BY id LIMIT 1`).get(rootId) as any
        const text = String(first?.content || '').replace(/\s+/g, ' ').trim()
        title = text.length > 60 ? `${text.slice(0, 60)}…` : text
      }
      chats.push({
        originalId: rootId,
        sessionIds: ids,
        title: title || 'Hermes chat',
        startedAt: seconds(root.started_at),
        lastActive: Math.max(seconds(latest.ended_at), ...tally.map(item => item.last), seconds(root.started_at)),
        messageCount: tally.reduce((sum, item) => sum + item.all, 0),
        userMessages: tally.reduce((sum, item) => sum + item.user, 0),
        cwd: chain.map(row => row.cwd).find(Boolean) || null,
        model: String(latest.model || root.model || ''),
      })
    }
    return chats
  })
}

function normalizeToolCalls(value: unknown): ImportedMessage['tool_calls'] {
  let calls: unknown = value
  if (typeof value === 'string') {
    try { calls = JSON.parse(value) } catch { return null }
  }
  if (!Array.isArray(calls) || !calls.length) return null
  return calls.map((call: any, index) => ({
    id: String(call?.id || call?.call_id || `call_${index}`),
    type: 'function' as const,
    function: {
      name: String(call?.function?.name || call?.name || 'tool'),
      arguments: toolArguments(call?.function?.arguments ?? call?.arguments ?? {}),
    },
  }))
}

/** Messages of one chat (its session chain), oldest first. */
export async function readHermesChat(path: string, sessionIds: string[], limits: Pick<ChatImportLimits, 'maxMessagesPerChat' | 'maxToolOutputChars'>): Promise<ImportedMessage[]> {
  if (!sessionIds.length) return []
  return withHermesDb(path, (db, columns) => {
    const placeholders = sessionIds.map(() => '?').join(', ')
    const order = sessionIds.map((_, index) => `WHEN ? THEN ${index}`).join(' ')
    const rows = db.prepare(`SELECT * FROM messages WHERE session_id IN (${placeholders}) AND role IN ('user', 'assistant', 'tool')${activeFilter(columns.messages)}
      ORDER BY CASE session_id ${order} ELSE ${sessionIds.length} END, id LIMIT ?`).all(...sessionIds, ...sessionIds, limits.maxMessagesPerChat) as any[]
    const messages: ImportedMessage[] = []
    for (const row of rows) {
      const role = String(row.role) as ImportedMessage['role']
      const toolCalls = role === 'assistant' ? normalizeToolCalls(row.tool_calls) : null
      const content = role === 'tool' ? toolOutput(row.content ?? '', limits.maxToolOutputChars) : String(row.content ?? '')
      if (role !== 'tool' && !content.trim() && !toolCalls?.length) continue
      messages.push({
        role,
        content,
        timestamp: seconds(row.timestamp),
        tool_calls: toolCalls,
        tool_call_id: row.tool_call_id ? String(row.tool_call_id) : null,
        tool_name: row.tool_name ? String(row.tool_name) : null,
        reasoning: row.reasoning ? String(row.reasoning) : (row.reasoning_content ? String(row.reasoning_content) : null),
        finish_reason: row.finish_reason ? String(row.finish_reason) : null,
      })
    }
    return messages
  })
}
