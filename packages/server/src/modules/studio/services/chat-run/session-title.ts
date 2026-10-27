import {
  createChatEkkoAuthorizedProviderFetch as createAuthorizedProviderFetch,
  createChatEkkoModelClient as createModelClient,
  getChatEkkoAgent as getGlobalEkkoAgent,
  resolveChatEkkoModelProviderConfigs as resolveModelProviderConfigs,
  resolveChatEkkoProviderRuntimeConfig as resolveEkkoProviderRuntimeConfig,
} from '../../public/chat-agent-runtime'
import { logger } from '../../public/logging'
import { getSession, updateSession } from '../../repositories/session-store'

export const SESSION_TITLE_MAX_CHARS = 15
const SESSION_TITLE_TIMEOUT_MS = 30_000
const SESSION_TITLE_PROMPT_MAX_CHARS = 4000
const SESSION_TITLE_SYSTEM_PROMPT = [
  `You write short titles for chat conversations. Read the user's first message and reply with a title of at most ${SESSION_TITLE_MAX_CHARS} characters (spaces included).`,
  'Reply in the same language as the message. Output only the title: no quotes, no markdown, no trailing punctuation, no explanation.',
].join(' ')

type EmitFn = (event: string, payload: any) => void

/** Clamp a raw model reply to a single-line title of at most 15 characters. */
export function normalizeGeneratedTitle(raw: unknown): string {
  const firstLine = String(raw ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || ''
  const cleaned = firstLine
    .replace(/^(?:title|标题)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’`*#\s]+|["'“”‘’`*\s.。]+$/g, '')
  const chars = Array.from(cleaned.replace(/\s+/g, ' '))
  if (chars.length <= SESSION_TITLE_MAX_CHARS) return chars.join('')
  const clipped = chars.slice(0, SESSION_TITLE_MAX_CHARS).join('')
  // Prefer ending on a whole word when that keeps most of the title.
  const lastSpace = clipped.lastIndexOf(' ')
  return (lastSpace >= SESSION_TITLE_MAX_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped).trim()
}

export interface GenerateSessionTitleOptions {
  profile: string
  provider: string
  model: string
  prompt: string
  /** Reuse the chat run's model client; otherwise one is built from provider/model. */
  modelClient?: any
  baseUrl?: string
  apiKey?: string
  apiMode?: string
}

export async function generateSessionTitle(options: GenerateSessionTitleOptions): Promise<string> {
  const prompt = options.prompt.trim().slice(0, SESSION_TITLE_PROMPT_MAX_CHARS)
  if (!prompt) return ''
  let modelClient = options.modelClient
  if (!modelClient) {
    const runtimeConfig = await resolveEkkoProviderRuntimeConfig({
      profile: options.profile,
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    })
    const { providerConfig } = resolveModelProviderConfigs({
      provider: runtimeConfig.provider,
      baseUrl: runtimeConfig.baseUrl,
      apiKey: runtimeConfig.apiKey,
      model: options.model,
      apiMode: runtimeConfig.apiMode,
      timeoutMs: SESSION_TITLE_TIMEOUT_MS,
    })
    modelClient = createModelClient(providerConfig, {
      fetch: createAuthorizedProviderFetch({
        profile: options.profile,
        provider: options.provider,
        model: options.model,
        accessToken: runtimeConfig.apiKey,
      }),
    })
  }
  const result = await getGlobalEkkoAgent(options.profile).runIsolated(
    {
      modelClient,
      toolsEnabled: false,
      skillsEnabled: false,
      systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
      runtimeInstructions: [],
      maxSteps: 1,
      maxModelRetries: 0,
      modelDefaults: { model: options.model },
    },
    {
      messages: [{ role: 'user', content: prompt }],
      memoryEnabled: false,
      metadata: { purpose: 'session-title', profile: options.profile },
      logContext: { profile: options.profile },
    },
  )
  if (result.output.toolCalls?.length) return ''
  return normalizeGeneratedTitle(result.output.content)
}

/**
 * Fire-and-forget: name a freshly created session from its first prompt using the
 * model the chat was started with. The title is only applied while the session
 * still carries the provisional prompt-derived title, so manual renames win.
 */
export function scheduleSessionTitle(
  sessionId: string,
  provisionalTitle: string,
  emit: EmitFn,
  options: GenerateSessionTitleOptions,
): void {
  void (async () => {
    try {
      const title = await generateSessionTitle(options)
      if (!title) return
      // Coding-agent runtimes create the session row lazily; wait briefly for it.
      let session = getSession(sessionId)
      for (let i = 0; !session && i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 500))
        session = getSession(sessionId)
      }
      if (!session || (session.title || '') !== provisionalTitle || title === session.title) return
      updateSession(sessionId, { title } as any)
      emit('session.title.updated', { event: 'session.title.updated', session_id: sessionId, title })
    } catch (err) {
      logger.debug(err, '[session-title] failed to generate title for session %s', sessionId)
    }
  })()
}
