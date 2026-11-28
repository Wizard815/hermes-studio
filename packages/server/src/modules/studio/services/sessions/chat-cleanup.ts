/**
 * Clean up's smart parts (docs/chat-list.md): which pull requests a chat
 * mentions and whether they merged, a one-line summary of a chat, and the key
 * facts of a chat saved to the LLM wiki before it is deleted.
 *
 * Everything here reads a chat's own recent messages. The model used is the
 * chat's own (else the profile's default), with no tools and no memory.
 */

export interface CleanupMessage { role: string; content: unknown }

export interface CleanupChat {
  id: string
  title: string
  profile: string
  provider: string
  model: string
  apiMode: string
  messageCount: number
}

export interface CleanupPr { url: string; state: 'open' | 'draft' | 'merged' | 'closed' | 'unknown'; title: string }

export interface ChatCleanupDeps {
  messages: (id: string, limit: number) => CleanupMessage[]
  /** The profile's default model when the chat has none. */
  defaultModel: (profile: string) => Promise<{ provider: string; model: string; apiMode?: string } | null>
  ask: (options: { profile: string; provider: string; model: string; apiMode?: string; systemPrompt: string; prompt: string; purpose: string }) => Promise<string | null>
  prs: (links: string[]) => Promise<Record<string, { state?: string; title?: string } | { error: string }>>
  wikiReady: (profile: string) => Promise<boolean>
  wikiCapture: (profile: string, title: string, content: string) => Promise<string>
}

const PR_LINK = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi
const TRANSCRIPT_CHARS = 12_000

export const SUMMARY_PROMPT = [
  'You summarize a chat so its owner can decide whether to delete it.',
  'Write ONE line, at most 100 characters: what the chat was about and how it ended (done, open question, waiting).',
  'Use the same language as the chat. Output only the line: no quotes, no markdown, no prefix.',
].join('\n')

export const FACTS_PROMPT = [
  'The owner is about to delete this chat. Write the facts worth keeping from it, for their notes.',
  'Markdown bullets, at most 8, one short line each: decisions, results, names, numbers, links, open follow-ups.',
  'Leave out small talk and anything already obvious. Never include passwords, keys, tokens or other secrets.',
  'If nothing is worth keeping, answer exactly: NOTHING',
].join('\n')

export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : String((part as any)?.text ?? ''))).join(' ')
  return content == null ? '' : JSON.stringify(content)
}

/** github.com pull request links in a chat's messages, newest mention last, each once. */
export function prLinksIn(messages: CleanupMessage[]): string[] {
  const seen = new Map<string, true>()
  for (const message of messages) {
    for (const match of messageText(message.content).match(PR_LINK) || []) {
      const link = match.replace(/\/+$/, '')
      seen.delete(link)
      seen.set(link, true)
    }
  }
  return [...seen.keys()].slice(-5)
}

/** The chat as plain text for a model, the newest part kept when it is long. */
export function transcript(messages: CleanupMessage[]): string {
  const lines = messages.map(message => `${message.role === 'user' ? 'Person' : 'Assistant'}: ${messageText(message.content).replace(/\s+/g, ' ').trim()}`)
  const text = lines.join('\n')
  return text.length > TRANSCRIPT_CHARS ? `…${text.slice(-TRANSCRIPT_CHARS)}` : text
}

export function oneLine(raw: string | null): string {
  const line = String(raw || '').split(/\r?\n/).map(item => item.trim()).find(Boolean) || ''
  return line.replace(/^["'“”*`]+|["'“”*`]+$/g, '').replace(/^(?:summary|tl;?dr)\s*[:：]\s*/i, '').trim().slice(0, 160)
}

export class ChatCleanupService {
  private readonly summaryCache = new Map<string, string>()

  constructor(private readonly deps: ChatCleanupDeps) {}

  /** For each chat: the pull requests it mentions and their state. */
  async prs(chats: CleanupChat[]): Promise<Record<string, CleanupPr[]>> {
    const links = new Map(chats.map(chat => [chat.id, prLinksIn(this.deps.messages(chat.id, 50))]))
    const all = [...new Set([...links.values()].flat())]
    const states = all.length ? await this.deps.prs(all) : {}
    const out: Record<string, CleanupPr[]> = {}
    for (const [id, list] of links) {
      if (!list.length) continue
      out[id] = list.map(url => {
        const status = states[url] as any
        const state = status && !status.error && ['open', 'draft', 'merged', 'closed'].includes(status.state) ? status.state : 'unknown'
        return { url, state, title: String(status?.title || '') }
      })
    }
    return out
  }

  private async model(chat: CleanupChat) {
    if (chat.provider && chat.model) return { provider: chat.provider, model: chat.model, apiMode: chat.apiMode || undefined }
    return this.deps.defaultModel(chat.profile)
  }

  /** A one-line summary per chat; remembered until the chat gets new messages. */
  async summaries(chats: CleanupChat[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    const queue = [...chats]
    const worker = async () => {
      for (let chat = queue.shift(); chat; chat = queue.shift()) {
        const key = `${chat.id}:${chat.messageCount}`
        const cached = this.summaryCache.get(key)
        if (cached !== undefined) { if (cached) out[chat.id] = cached; continue }
        const messages = this.deps.messages(chat.id, 30)
        const model = messages.length ? await this.model(chat).catch(() => null) : null
        if (!model) continue
        const line = oneLine(await this.deps.ask({ profile: chat.profile, ...model, systemPrompt: SUMMARY_PROMPT, prompt: `Chat title: ${chat.title || '(none)'}\n\n${transcript(messages)}`, purpose: 'chat-cleanup-summary' }).catch(() => null))
        this.summaryCache.set(key, line)
        if (line) out[chat.id] = line
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, chats.length) }, worker))
    return out
  }

  async wikiProfiles(profiles: string[]): Promise<string[]> {
    const unique = [...new Set(profiles)]
    const ready = await Promise.all(unique.map(profile => this.deps.wikiReady(profile).catch(() => false)))
    return unique.filter((_, index) => ready[index])
  }

  /**
   * Save each chat's key facts to its profile's wiki inbox, as a note named
   * after the chat. A chat whose save fails is in `errors`, so the caller keeps it.
   */
  async saveToWiki(chats: CleanupChat[]): Promise<{ saved: string[]; skipped: string[]; errors: Array<{ id: string; error: string }> }> {
    const saved: string[] = []
    const skipped: string[] = []
    const errors: Array<{ id: string; error: string }> = []
    for (const chat of chats) {
      try {
        if (!(await this.deps.wikiReady(chat.profile))) throw new Error(`The LLM wiki is not set up for the profile "${chat.profile}".`)
        const messages = this.deps.messages(chat.id, 50)
        if (!messages.length) { skipped.push(chat.id); continue }
        const model = await this.model(chat)
        if (!model) throw new Error('No model to write the notes with. Pick a model for this chat or the profile.')
        const facts = String(await this.deps.ask({ profile: chat.profile, ...model, systemPrompt: FACTS_PROMPT, prompt: `Chat title: ${chat.title || '(none)'}\n\n${transcript(messages)}`, purpose: 'chat-cleanup-facts' }) || '').trim()
        if (!facts || /^NOTHING\.?$/i.test(facts)) { skipped.push(chat.id); continue }
        const when = new Date().toISOString().slice(0, 10)
        await this.deps.wikiCapture(chat.profile, `Chat: ${chat.title || chat.id.slice(0, 8)}`, `Saved from a Studio chat before it was deleted (${when}).\n\n${facts}`)
        saved.push(chat.id)
      } catch (error) {
        errors.push({ id: chat.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { saved, skipped, errors }
  }
}
