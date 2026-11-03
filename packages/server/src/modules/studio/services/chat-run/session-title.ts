import {
  createChatEkkoAuthorizedProviderFetch as createAuthorizedProviderFetch,
  createChatEkkoModelClient as createModelClient,
  getChatEkkoAgent as getGlobalEkkoAgent,
  resolveChatEkkoModelProviderConfigs as resolveModelProviderConfigs,
  resolveChatEkkoProviderRuntimeConfig as resolveEkkoProviderRuntimeConfig,
} from '../../public/chat-agent-runtime'
import { logger } from '../../public/logging'
import { getSession, updateSession } from '../../repositories/session-store'

/**
 * Session title generation configuration for Hermes Studio.
 * 
 * Key improvements:
 * - Increased max chars from 15 to 25 for better descriptiveness
 * - Better system prompt that guides model toward meaningful titles
 * - Enhanced normalization with Unicode support and smart truncation
 * - Fallback strategy when model generation fails
 */
export const SESSION_TITLE_MAX_CHARS = 25
const SESSION_TITLE_TIMEOUT_MS = 30_000
const SESSION_TITLE_PROMPT_MAX_CHARS = 4000

/**
 * System prompt that guides the model to generate meaningful titles from the first prompt.
 * 
 * This prompt is designed to:
 * - Focus on the core intent/topic of the conversation
 * - Be language-agnostic and natural
 * - Stay within the 25-character UI display limit
 * - Avoid generic words while being descriptive
 */
const SESSION_TITLE_SYSTEM_PROMPT = [
  `You are a title generator for chat conversations.`,
  `Read the user's first message carefully and generate a concise, descriptive title.`,
  `Requirements:`,
  `- Extract the CORE topic or intent (not just generic words)`,
  `- Use at most ${SESSION_TITLE_MAX_CHARS} characters (including spaces)`,
  `- Prioritize nouns and important verbs`,
  `- Omit articles (a, an, the) and redundant words when possible`,
  `- Keep the first letter capitalized`,
  `- If the message is a question, keep the question word if it's essential`,
  `- Use the SAME LANGUAGE as the input`,
  `- Output ONLY the title text, nothing else.`,
  `- No quotes, no markdown, no explanation, no prefix.`,
  ``,
  `Examples:`,
  `- "How do I fix my login bug?" → "Fix login bug"`,
  `- "Create a Python todo app" → "Python todo app"`,
  `- "Explain quantum physics" → "Quantum physics"`,
  `- "Debug React component" → "Debug React component"`,
].join('\n')

type EmitFn = (event: string, payload: any) => void

/**
 * Clamp a raw model reply to a single-line title of at most 25 characters.
 * 
 * This function intelligently truncates and cleans the title:
 * - Handles Unicode characters properly (uses Array.from)
 * - Prefers word boundaries for cleaner breaks
 * - Falls back to punctuation-aware truncation
 * - Removes common prefixes and quotes
 */
export function normalizeGeneratedTitle(raw: unknown): string {
  const rawString = String(raw ?? '')
  
  // Extract first non-empty line
  const firstLine = rawString
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0) || ''
  
  let cleaned = firstLine
  
  // Remove common prefixes (title:, Title:, etc.)
  cleaned = cleaned
    .replace(/^(?:title|标题|subject|topic|name|名前)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’`*#\s]+/, '')  // Strip leading quotes/special chars
    .replace(/["'“”‘’`*\s.。!?，。？！]+$/, '')  // Strip trailing quotes, spaces, punctuation
  
  // Count characters properly (handles Unicode)
  const chars = Array.from(cleaned)
  
  // If within limit, return trimmed
  if (chars.length <= SESSION_TITLE_MAX_CHARS) {
    return chars.join('').trim()
  }
  
  // Need to truncate - find optimal breaking point
  const clipped = chars.slice(0, SESSION_TITLE_MAX_CHARS).join('')
  
  // Strategy 1: Look for punctuation near the end (last 30%)
  const lastPunctuation = clipped.search(/[.!?，。？！]$/)
  if (lastPunctuation >= SESSION_TITLE_MAX_CHARS * 0.7) {
    return clipped.slice(0, lastPunctuation + 1).trim()
  }
  
  // Strategy 2: Look for word boundary (last 40%)
  const lastSpace = clipped.lastIndexOf(' ')
  if (lastSpace >= SESSION_TITLE_MAX_CHARS * 0.6) {
    return clipped.slice(0, lastSpace).trim()
  }
  
  // Strategy 3: Check for hyphenated words
  const lastHyphen = clipped.lastIndexOf('-')
  if (lastHyphen >= SESSION_TITLE_MAX_CHARS * 0.6) {
    return clipped.slice(0, lastHyphen).trim()
  }
  
  // Strategy 4: Just truncate cleanly
  return clipped.trim()
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
 * 
 * This function:
 * - Uses the model to generate an intelligent title
 * - Falls back to a clean version of the first message if model fails
 * - Only updates if the generated title is meaningfully different
 */
export function scheduleSessionTitle(
  sessionId: string,
  provisionalTitle: string,
  emit: EmitFn,
  options: GenerateSessionTitleOptions,
): void {
  void (async () => {
    try {
      // Try to generate title using the model
      let title = await generateSessionTitle(options)
      
      // Fallback: if model failed, clean up the provisional title
      if (!title && provisionalTitle) {
        title = normalizeGeneratedTitle(provisionalTitle) || 'New Chat'
      }
      
      if (!title) return
      
      // Wait for session to be created (coding-agent runtimes create it lazily)
      let session = getSession(sessionId)
      for (let i = 0; !session && i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 500))
        session = getSession(sessionId)
      }
      
      if (!session) return
      
      const currentTitle = session.title || ''
      
      // Only update if:
      // 1. Current title still matches provisional (user hasn't manually changed it)
      // 2. New title is meaningfully different from current
      if (currentTitle !== provisionalTitle) return
      
      // Compare normalized versions
      const normalizedCurrent = currentTitle.toLowerCase().replace(/\s+/g, ' ').trim()
      const normalizedNew = title.toLowerCase().replace(/\s+/g, ' ').trim()
      
      // Only update if different enough to be an improvement
      if (normalizedNew !== normalizedCurrent && normalizedNew.length >= 3) {
        updateSession(sessionId, { title } as any)
        emit('session.title.updated', { 
          event: 'session.title.updated', 
          session_id: sessionId, 
          title 
        })
      }
    } catch (err) {
      // Log error but don't fail - fallback is handled above
      logger.debug(err, '[session-title] failed to generate title for session %s', sessionId)
    }
  })()
}
