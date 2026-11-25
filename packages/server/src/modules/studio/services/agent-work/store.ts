import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Agent work and its activity log. Tasks themselves live in Vikunja (reached
 * through ALLGlance): a row here only links to the Vikunja task id and records
 * the agent's side of the work (who works on it, its state, the approval).
 */

export const AGENT_WORK_STATUSES = ['queued', 'working', 'blocked', 'awaiting_approval', 'done', 'rejected'] as const
export type AgentWorkStatus = typeof AGENT_WORK_STATUSES[number]
export type DecisionVia = 'studio' | 'mattermost' | 'orb'
export const DECISION_VIAS: DecisionVia[] = ['studio', 'mattermost', 'orb']

export interface MattermostPostRef { id: string; channelId: string; kind: string; resolved?: boolean }

export interface AgentWork {
  id: string
  title: string
  vikunjaTaskId: string
  agent: string
  sessionId: string
  status: AgentWorkStatus
  summary: string
  decision: '' | 'approved' | 'rejected'
  decidedVia: '' | DecisionVia
  decidedBy: string
  decidedAt: number
  vikunjaDoneAt: number
  vikunjaError: string
  createdAt: number
  updatedAt: number
}

export interface AgentActivity {
  id: number
  workId: string
  at: number
  kind: string
  status: string
  actor: string
  via: string
  message: string
}

interface Row {
  id: string; title: string; vikunja_task_id: string; agent: string; session_id: string; status: string
  summary: string; decision: string; decided_via: string; decided_by: string; decided_at: number
  vikunja_done_at: number; vikunja_error: string; created_at: number; updated_at: number
  action_token: string; mm_posts: string
}

function toWork(row: Row): AgentWork {
  return {
    id: row.id, title: row.title, vikunjaTaskId: row.vikunja_task_id, agent: row.agent, sessionId: row.session_id,
    status: row.status as AgentWorkStatus, summary: row.summary, decision: row.decision as AgentWork['decision'],
    decidedVia: row.decided_via as AgentWork['decidedVia'], decidedBy: row.decided_by, decidedAt: Number(row.decided_at) || 0,
    vikunjaDoneAt: Number(row.vikunja_done_at) || 0, vikunjaError: row.vikunja_error,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

export class AgentWorkStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_work (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        vikunja_task_id TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        summary TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL DEFAULT '',
        decided_via TEXT NOT NULL DEFAULT '',
        decided_by TEXT NOT NULL DEFAULT '',
        decided_at INTEGER NOT NULL DEFAULT 0,
        vikunja_done_at INTEGER NOT NULL DEFAULT 0,
        vikunja_error TEXT NOT NULL DEFAULT '',
        action_token TEXT NOT NULL DEFAULT '',
        mm_posts TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_work_status ON agent_work(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_agent_work_task ON agent_work(vikunja_task_id);
      CREATE TABLE IF NOT EXISTS agent_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT '',
        via TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_agent_activity_work ON agent_activity(work_id, id);
      CREATE INDEX IF NOT EXISTS idx_agent_activity_at ON agent_activity(at);
    `)
  }

  private row(id: string): Row | null {
    return (this.db.prepare('SELECT * FROM agent_work WHERE id=?').get(id) as unknown as Row) || null
  }

  get(id: string): AgentWork | null {
    const row = this.row(id)
    return row ? toWork(row) : null
  }

  create(input: { title: string; vikunjaTaskId?: string; agent?: string; sessionId?: string; status?: AgentWorkStatus; summary?: string }, now = Date.now()): AgentWork {
    const id = randomUUID()
    this.db.prepare(`INSERT INTO agent_work (id,title,vikunja_task_id,agent,session_id,status,summary,action_token,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, input.title, input.vikunjaTaskId || '', input.agent || '', input.sessionId || '',
      input.status || 'queued', input.summary || '', randomBytes(24).toString('hex'), now, now)
    return this.get(id)!
  }

  /** Remove the work and its activity. False when there was none. */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agent_work WHERE id=?').run(id)
    this.db.prepare('DELETE FROM agent_activity WHERE work_id=?').run(id)
    return Number(result.changes) === 1
  }

  list(filter: { status?: AgentWorkStatus[]; limit?: number } = {}): AgentWork[] {
    const limit = Math.max(1, Math.min(500, Number(filter.limit) || 200))
    const statuses = filter.status?.filter(s => (AGENT_WORK_STATUSES as readonly string[]).includes(s)) || []
    const where = statuses.length ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : ''
    return (this.db.prepare(`SELECT * FROM agent_work ${where} ORDER BY updated_at DESC LIMIT ?`).all(...statuses, limit) as unknown as Row[]).map(toWork)
  }

  /** Change the working state. Decided work (approved or rejected) keeps its state. */
  setStatus(id: string, status: AgentWorkStatus, summary: string | undefined, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE agent_work SET status=?, summary=COALESCE(?, summary), updated_at=?,
        decision=CASE WHEN ?='awaiting_approval' THEN '' ELSE decision END
      WHERE id=? AND decision=''`).run(status, summary ?? null, now, status, id)
    return Number(result.changes) === 1
  }

  /**
   * Decide pending work. Only the first decision wins (the WHERE clause makes it
   * atomic), so approving the same item from two places at once is safe.
   */
  decide(id: string, decision: 'approved' | 'rejected', via: DecisionVia, by: string, now = Date.now()): boolean {
    const status = decision === 'approved' ? 'done' : 'rejected'
    const result = this.db.prepare(`UPDATE agent_work SET status=?, decision=?, decided_via=?, decided_by=?, decided_at=?, updated_at=?
      WHERE id=? AND status='awaiting_approval' AND decision=''`).run(status, decision, via, by, now, now, id)
    return Number(result.changes) === 1
  }

  setVikunjaResult(id: string, ok: boolean, error = '', now = Date.now()): void {
    this.db.prepare('UPDATE agent_work SET vikunja_done_at=?, vikunja_error=? WHERE id=?').run(ok ? now : 0, ok ? '' : error.slice(0, 500), id)
  }

  /** Approved work linked to a Vikunja task that is not marked done there yet. */
  pendingVikunja(): AgentWork[] {
    return (this.db.prepare(`SELECT * FROM agent_work WHERE decision='approved' AND vikunja_task_id<>'' AND vikunja_done_at=0 ORDER BY decided_at`).all() as unknown as Row[]).map(toWork)
  }

  actionToken(id: string): string {
    return this.row(id)?.action_token || ''
  }

  posts(id: string): MattermostPostRef[] {
    try { const list = JSON.parse(this.row(id)?.mm_posts || '[]'); return Array.isArray(list) ? list : [] } catch { return [] }
  }

  setPosts(id: string, posts: MattermostPostRef[]): void {
    this.db.prepare('UPDATE agent_work SET mm_posts=? WHERE id=?').run(JSON.stringify(posts.slice(-50)), id)
  }

  /** Work waiting for approval that has a Mattermost approval post. */
  pendingApprovalPosts(): Array<{ work: AgentWork; posts: MattermostPostRef[] }> {
    return this.list({ status: ['awaiting_approval'] }).map(work => ({ work, posts: this.posts(work.id).filter(p => p.kind === 'awaiting_approval' && !p.resolved) }))
      .filter(item => item.posts.length)
  }

  log(workId: string, entry: { kind: string; status?: string; actor?: string; via?: string; message?: string }, now = Date.now()): AgentActivity {
    const result = this.db.prepare('INSERT INTO agent_activity (work_id,at,kind,status,actor,via,message) VALUES (?,?,?,?,?,?,?)')
      .run(workId, now, entry.kind, entry.status || '', entry.actor || '', entry.via || '', String(entry.message || '').slice(0, 2000))
    return { id: Number(result.lastInsertRowid), workId, at: now, kind: entry.kind, status: entry.status || '', actor: entry.actor || '', via: entry.via || '', message: String(entry.message || '').slice(0, 2000) }
  }

  activity(filter: { workId?: string; since?: number; until?: number; limit?: number } = {}): AgentActivity[] {
    const clauses: string[] = [], args: Array<string | number> = []
    if (filter.workId) { clauses.push('work_id=?'); args.push(filter.workId) }
    if (filter.since) { clauses.push('at>=?'); args.push(filter.since) }
    if (filter.until) { clauses.push('at<?'); args.push(filter.until) }
    const limit = Math.max(1, Math.min(1000, Number(filter.limit) || 200))
    const rows = this.db.prepare(`SELECT id, work_id AS workId, at, kind, status, actor, via, message FROM agent_activity
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit) as unknown as AgentActivity[]
    return rows.map(r => ({ ...r, id: Number(r.id), at: Number(r.at) }))
  }

  counts(): Record<AgentWorkStatus, number> {
    const out = Object.fromEntries(AGENT_WORK_STATUSES.map(s => [s, 0])) as Record<AgentWorkStatus, number>
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM agent_work GROUP BY status').all() as Array<{ status: string; n: number }>) {
      if (row.status in out) out[row.status as AgentWorkStatus] = Number(row.n)
    }
    return out
  }
}
