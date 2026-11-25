import type { DatabaseSync } from 'node:sqlite'
import type { WatcherAction, WatcherEvent, WatcherKind, WatcherSeverity } from '../../../../../../shared/watcher'

/** What a source reports; the store adds id, time and read. */
export interface WatcherEventInput {
  kind: WatcherKind
  severity: WatcherSeverity
  text: string
  sessionId?: string
  taskId?: string
  agent?: string
  folder?: string
  link?: string
  action?: WatcherAction
  trace?: string
}

interface Row {
  id: number; time: number; kind: string; severity: string; session_id: string; task_id: string
  agent: string; folder: string; text: string; link: string; action: string; trace: string; read: number
}

function toEvent(row: Row): WatcherEvent {
  let action: WatcherAction | undefined
  try { action = row.action ? JSON.parse(row.action) : undefined } catch { action = undefined }
  return {
    id: Number(row.id), time: Number(row.time), kind: row.kind as WatcherKind, severity: row.severity as WatcherSeverity,
    sessionId: row.session_id, taskId: row.task_id, agent: row.agent, folder: row.folder, text: row.text, link: row.link,
    ...(action ? { action } : {}), ...(row.trace ? { trace: row.trace } : {}), read: !!row.read,
  }
}

const clip = (value: unknown, max: number) => String(value ?? '').slice(0, max)

/**
 * The watcher's history: one small SQLite table in Studio's own database,
 * pruned by count and age on every insert. Alerts only; nothing here is a
 * source of truth for approvals or limits.
 */
export class WatcherStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS watcher_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        task_id TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT '',
        folder TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        link TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        trace TEXT NOT NULL DEFAULT '',
        read INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_watcher_events_time ON watcher_events(time);
      CREATE INDEX IF NOT EXISTS idx_watcher_events_read ON watcher_events(read, id);
    `)
  }

  add(input: WatcherEventInput, time: number): WatcherEvent {
    const result = this.db.prepare(`INSERT INTO watcher_events (time, kind, severity, session_id, task_id, agent, folder, text, link, action, trace)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      time, input.kind, input.severity, clip(input.sessionId, 200), clip(input.taskId, 80), clip(input.agent, 80),
      clip(input.folder, 1000), clip(input.text, 600), clip(input.link, 1000),
      input.action ? JSON.stringify({ kind: input.action.kind, value: clip(input.action.value, 2000) }) : '', clip(input.trace, 1000),
    )
    return this.get(Number(result.lastInsertRowid))!
  }

  get(id: number): WatcherEvent | null {
    const row = this.db.prepare('SELECT * FROM watcher_events WHERE id=?').get(id) as unknown as Row | undefined
    return row ? toEvent(row) : null
  }

  /** Newest first. */
  list(options: { limit?: number; unreadOnly?: boolean; before?: number } = {}): WatcherEvent[] {
    const limit = Math.max(1, Math.min(500, Math.round(options.limit || 50)))
    const where: string[] = []
    const args: Array<number> = []
    if (options.unreadOnly) where.push('read=0')
    if (options.before) { where.push('id<?'); args.push(options.before) }
    const rows = this.db.prepare(`SELECT * FROM watcher_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as unknown as Row[]
    return rows.map(toEvent)
  }

  unreadCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM watcher_events WHERE read=0').get() as any)?.n || 0)
  }

  total(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM watcher_events').get() as any)?.n || 0)
  }

  markRead(ids: number[]): number {
    let changed = 0
    for (const id of ids) changed += Number(this.db.prepare('UPDATE watcher_events SET read=1 WHERE id=? AND read=0').run(id).changes)
    return changed
  }

  markAllRead(): number {
    return Number(this.db.prepare('UPDATE watcher_events SET read=1 WHERE read=0').run().changes)
  }

  clear(ids?: number[]): number {
    if (!ids) return Number(this.db.prepare('DELETE FROM watcher_events').run().changes)
    let changed = 0
    for (const id of ids) changed += Number(this.db.prepare('DELETE FROM watcher_events WHERE id=?').run(id).changes)
    return changed
  }

  /** Keep at most `maxCount` rows and none older than `maxAgeMs`. */
  prune(maxCount: number, maxAgeMs: number, now: number): number {
    let removed = Number(this.db.prepare('DELETE FROM watcher_events WHERE time<?').run(now - maxAgeMs).changes)
    const total = this.total()
    if (total > maxCount) {
      removed += Number(this.db.prepare('DELETE FROM watcher_events WHERE id IN (SELECT id FROM watcher_events ORDER BY id ASC LIMIT ?)').run(total - maxCount).changes)
    }
    return removed
  }
}
