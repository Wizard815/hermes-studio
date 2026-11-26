import type { AgentActivity, AgentWork } from './store'

/**
 * Studio's part of the wiki's daily digest. Pondering Orb and Hermes write the
 * day's note (`daily/YYYY-MM-DD.md` in the LLMWIKI vault, through the vault's
 * Obsidian Local REST API); Studio owns one "## Hermes Studio" section in it:
 * agent work done, blocked and awaiting approval. The section is rewritten as a
 * whole each time, so writing it again never duplicates lines.
 */

export interface WikiPort {
  configured(): Promise<boolean>
  /** Replace Studio's section of a day's note (creating the note when needed). */
  writeSection(day: string, markdown: string): Promise<{ path: string }>
}

export class WikiError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

/** Local calendar day (the server's time zone, TZ) as YYYY-MM-DD. */
export function localDay(at = Date.now()): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dayBounds(day: string): { start: number; end: number } {
  const [y, m, d] = day.split('-').map(Number)
  const start = new Date(y, m - 1, d).getTime()
  return { start, end: new Date(y, m - 1, d + 1).getTime() }
}

const DAILY_TEMPLATE = 'schema/templates/DAILY.md'

export function fillTemplate(text: string, day: string): string {
  return text.replace(/\{\{\s*(date|title)(:[^}]*)?\s*\}\}/g, day)
}

/** Replace the body of a "## heading" section, or add the section at the end (the same rule Orb uses). */
export function setSection(text: string, heading: string, body: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^##\s/.test(l) && l.replace(/^##\s+/, '').trim() === heading)
  if (start === -1) return `${text.replace(/\n+$/, '')}\n\n## ${heading}\n\n${body}\n`
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break }
  return [...lines.slice(0, start + 1), '', body, '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
}

const line = (w: AgentWork, extra = '') =>
  `- ${w.title}${w.vikunjaTaskId ? ` (Vikunja #${w.vikunjaTaskId})` : ''}${w.agent ? ` · ${w.agent}` : ''}${extra}${w.summary ? `: ${w.summary.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`

const VIA: Record<string, string> = { studio: 'Studio', mattermost: 'Mattermost', orb: 'Orb' }

/**
 * The digest for a day: work finished or decided that day, and work that is
 * blocked or awaiting approval now (the daily summary lists every item still
 * waiting for approval, whatever day it was asked).
 */
export function buildDigest(day: string, work: AgentWork[], activity: AgentActivity[]): string {
  const { start, end } = dayBounds(day)
  const today = (at: number) => at >= start && at < end
  const done = work.filter(w => w.status === 'done' && today(w.decidedAt || w.updatedAt))
  const rejected = work.filter(w => w.status === 'rejected' && today(w.decidedAt || w.updatedAt))
  const blocked = work.filter(w => w.status === 'blocked')
  const waiting = work.filter(w => w.status === 'awaiting_approval')
  const touched = new Set(activity.filter(a => today(a.at)).map(a => a.workId))
  const working = work.filter(w => (w.status === 'working' || w.status === 'queued') && touched.has(w.id))
  const sec = (title: string, items: string[]) => (items.length ? [`### ${title}`, '', ...items, ''] : [])
  const parts = [
    ...sec('Done', done.map(w => line(w, w.decision === 'approved' ? `, approved in ${VIA[w.decidedVia] || w.decidedVia}` : ''))),
    ...sec('Awaiting approval', waiting.map(w => line(w))),
    ...sec('Blocked', blocked.map(w => line(w))),
    ...sec('Rejected', rejected.map(w => line(w, `, rejected in ${VIA[w.decidedVia] || w.decidedVia}`))),
    ...sec('In progress', working.map(w => line(w))),
  ]
  return (parts.length ? parts.join('\n') : '- No agent work today.').trim()
}

/** The vault's Obsidian Local REST API, as Orb reaches it. */
export class ObsidianWiki implements WikiPort {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly connection: () => Promise<{ url: string; token: string; folder: string; section: string }>, private readonly fetcher: typeof fetch = fetch) {}

  async configured(): Promise<boolean> {
    return !!(await this.connection()).url
  }

  private async call(url: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
    const { token } = await this.connection()
    try {
      const res = await this.fetcher(url, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) }, signal: AbortSignal.timeout(15_000) })
      return { status: res.status, text: await res.text() }
    } catch (error) {
      throw new WikiError(`The wiki is unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private vaultUrl(base: string, path: string): string {
    return `${base}/vault/${path.split('/').map(encodeURIComponent).join('/')}`
  }

  writeSection(day: string, markdown: string): Promise<{ path: string }> {
    // One at a time: two writes at once on a new day would both create the note.
    const run = this.chain.then(() => this.writeNow(day, markdown))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async writeNow(day: string, markdown: string): Promise<{ path: string }> {
    const { url, folder, section } = await this.connection()
    if (!url) throw new WikiError('The wiki is not set up. Add its address in Connections → Agent work.', 409)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new WikiError('day must be YYYY-MM-DD', 400)
    const path = `${folder}/${day}.md`
    const current = await this.call(this.vaultUrl(url, path), { headers: { Accept: 'text/markdown' } })
    let text: string
    if (current.status < 300) text = current.text
    else if (current.status === 404) {
      const template = await this.call(this.vaultUrl(url, DAILY_TEMPLATE), { headers: { Accept: 'text/markdown' } })
      text = template.status < 300
        ? fillTemplate(template.text, day)
        : `---\ntitle: "${day}"\ntype: daily\ntags: [daily]\ncreated: ${day}\nstatus: open\nrelated: []\n---\n\n# ${day}\n\n## Worked on\n\n- \n`
    } else throw new WikiError(`The wiki answered ${current.status} for ${path}`)
    const next = setSection(text, section, markdown)
    if (next === text) return { path }
    const put = await this.call(this.vaultUrl(url, path), { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, body: next })
    if (put.status >= 300) throw new WikiError(`The wiki refused ${path} (${put.status})`)
    return { path }
  }
}
