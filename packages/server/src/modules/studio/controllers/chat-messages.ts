import type { Context } from 'koa'
import { chatMessenger } from '../services/chat-messages/service'

/** Chats messaging each other (docs/chat-messages.md). */
export const CHAT_MESSAGE_ACTIONS = ['list', 'ask', 'send']

function fail(ctx: Context, error: unknown) {
  const status = Number((error as { status?: number })?.status)
  ctx.status = status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

export async function tool(ctx: Context) {
  try {
    const input = ((ctx.request as any).body || {}) as Record<string, any>
    const action = String((ctx.params as Record<string, string>).action || '')
    const caller = ctx.state.user ?? null
    const from = String(input.sessionId || input.from || '')
    const to = input.chat
    const messenger = chatMessenger()
    switch (action) {
      case 'list':
        ctx.body = messenger.list({ from, limit: input.limit }, caller)
        return
      case 'ask':
        ctx.body = await messenger.ask({ from, to, text: input.text, timeoutMs: Number(input.timeout_s) * 1000 || undefined }, caller)
        return
      case 'send':
        ctx.body = await messenger.send({ from, to, text: input.text, answer: input.answer === true }, caller)
        return
      default:
        throw Object.assign(new Error(`Unknown action ${action}: use ${CHAT_MESSAGE_ACTIONS.join(', ')}`), { status: 400 })
    }
  } catch (error) { fail(ctx, error) }
}
