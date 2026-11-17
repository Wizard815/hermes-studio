/**
 * ALLGlance, the gateway in front of Vikunja (and the GLANCE apps). Tasks are
 * Vikunja's; Studio only marks a linked task done once its agent work is
 * approved, through the gateway's own `allglance_update_task` MCP tool (the
 * same write Omi's approved items go through).
 */

export interface AllGlancePort {
  configured(): Promise<boolean>
  completeTask(taskId: string): Promise<void>
  getTask?(taskId: string): Promise<{ id: string; title: string; done: boolean } | null>
}

export class AllGlanceError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

/** Parse a Streamable HTTP answer: plain JSON, or the first `data:` line of an event stream. */
export function parseMcpBody(text: string): any {
  const line = text.split('\n').find(l => l.startsWith('data:'))
  return line ? JSON.parse(line.slice(5)) : text ? JSON.parse(text) : null
}

export class AllGlanceMcp implements AllGlancePort {
  private nextId = 1
  constructor(private readonly connection: () => Promise<{ url: string; token: string }>, private readonly fetcher: typeof fetch = fetch) {}

  async configured(): Promise<boolean> {
    return !!(await this.connection()).url
  }

  async tool(name: string, args: Record<string, unknown>): Promise<any> {
    const { url, token } = await this.connection()
    if (!url) throw new AllGlanceError('ALLGlance is not connected. Add its address in Connections → Agent work.', 409)
    let res: Response
    try {
      res = await this.fetcher(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new AllGlanceError(`ALLGlance is unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await res.text()
    if (!res.ok) throw new AllGlanceError(`ALLGlance answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    let body: any
    try { body = parseMcpBody(text) } catch { throw new AllGlanceError('ALLGlance sent an answer Studio could not read') }
    if (body?.error) throw new AllGlanceError(body.error.message || 'ALLGlance tool failed', 400)
    const out = body?.result?.content?.[0]?.text ?? ''
    if (body?.result?.isError) throw new AllGlanceError(String(out || 'ALLGlance tool failed'), 400)
    try { return JSON.parse(out) } catch { return out }
  }

  async completeTask(taskId: string): Promise<void> {
    await this.tool('allglance_update_task', { source: 'vikunja', id: String(taskId), done: true })
  }
}
