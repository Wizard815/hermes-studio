/**
 * The LLM wiki's family MCP server (Wizard815/LLM-will-remember-this, its
 * llmwiki-mcp-bridge plugin): stateless JSON-RPC over POST at `<wiki>/family-mcp`,
 * one Bearer token per family member, shared agent or service. The token decides
 * what is visible; Studio only uses it to ask `whoami` (Connections → LLM wiki →
 * Test). Hermes itself talks to the wiki from the memory provider
 * (assets/hermes-plugins/llm_wiki).
 */

export const LLM_WIKI_MCP_PATH = '/family-mcp'
const TIMEOUT_MS = 10_000

export class LlmWikiError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

/** `http://wiki:27123`, `http://wiki:27123/` or `.../family-mcp` → `http://wiki:27123`. */
export function wikiBaseUrl(value: unknown): string {
  const url = String(value ?? '').trim().replace(/\/+$/, '').replace(/\/family-mcp$/i, '')
  if (url && !/^https?:\/\/[^\s/]+(?:\/\S*)?$/i.test(url)) {
    throw new LlmWikiError("The wiki's address must start with http:// or https://, for example http://wiki.lan:27123", 400)
  }
  return url
}

/** Parses a JSON or text/event-stream MCP answer and returns the reply for `id` (from the parked WIP). */
export function parseMcpReply(text: string, id: number): any {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const body = JSON.parse(trimmed)
    return Array.isArray(body) ? body.find(item => item?.id === id) ?? body[0] : body
  }
  let found: any = null
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try {
      const message = JSON.parse(line.slice(5).trim())
      if (message?.id === id || found === null) found = message
    } catch { /* keep-alive or partial frame */ }
  }
  return found
}

export interface WikiIdentity {
  name: string
  /** admin | member | child | shared | shared-parents | service | master */
  kind: string
  id: string
}

/** The first line of `whoami`: "You are acting for: Name (kind, id x)." */
export function parseWhoami(text: string): WikiIdentity | null {
  const match = /You are acting for: (.+?) \(([^,]+), id ([^)]+)\)/.exec(text || '')
  return match ? { name: match[1], kind: match[2].trim(), id: match[3].trim() } : null
}

/** Whose notes the token sees, in words the settings screen can show. */
export function wikiView(identity: WikiIdentity | null): 'own' | 'household' | 'everyone' | 'service' | 'unknown' {
  if (!identity) return 'unknown'
  if (identity.kind === 'master') return 'everyone'
  if (identity.kind.startsWith('shared')) return 'household'
  if (identity.kind === 'service') return 'service'
  return 'own'
}

let nextId = 1

/** One tool call on the wiki with a given token; returns the tool's text. */
export async function callWikiTool(url: string, token: string, tool: string, args: Record<string, unknown> = {}, fetcher: typeof fetch = fetch): Promise<string> {
  const base = wikiBaseUrl(url)
  if (!base) throw new LlmWikiError("Add the wiki's address first.", 400)
  if (!token) throw new LlmWikiError('Add a wiki token for this profile first.', 400)
  const id = nextId++
  let response: Response
  try {
    response = await fetcher(`${base}${LLM_WIKI_MCP_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new LlmWikiError(`The wiki is not reachable at ${base}: ${error instanceof Error ? error.message : String(error)}. Check the address and that Obsidian (or the wiki's container) is running.`)
  }
  const text = await response.text()
  if (response.status === 401 || response.status === 403) throw new LlmWikiError('The wiki refused this token. Make a new one with family-setup.mjs token <id> and paste it again.')
  if (response.status === 404) throw new LlmWikiError(`The wiki has no ${LLM_WIKI_MCP_PATH} at ${base}. Turn on the LLMWIKI MCP Bridge plugin in Obsidian, or check the port (the Local REST API's, 27123 by default).`)
  if (!response.ok) throw new LlmWikiError(`The wiki answered HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  let reply: any
  try { reply = parseMcpReply(text, id) } catch { throw new LlmWikiError('The wiki sent an answer Studio could not read.') }
  if (reply?.error) throw new LlmWikiError(String(reply.error.message || 'The wiki refused the request.'))
  const content = Array.isArray(reply?.result?.content) ? reply.result.content : []
  const out = content.map((item: any) => String(item?.text || '')).join('\n').trim()
  if (reply?.result?.isError) throw new LlmWikiError(out || `${tool} failed`, 400)
  return out
}
