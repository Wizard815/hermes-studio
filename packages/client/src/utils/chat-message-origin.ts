/**
 * A message one Studio chat sent another (docs/chat-messages.md). Studio stores
 * it as "💬 From “Name”: text" or "↩ Reply from “Name”[ to “…”]: text"; a herdr
 * thread's mirrored transcript holds the raw <studio_chat_message> input.
 */
export interface ChatMessageOrigin { kind: 'from' | 'reply'; chat: string; text: string }

const DISPLAY = /^(?:💬 From|(↩) Reply from) “([^”]{1,120})”(?: to “[^”]*”)?: ([\s\S]*)$/
const RAW = /<studio_chat_(message|reply) from_chat="([^"]{1,120})"[^>]*>\n?([\s\S]*?)\n?<\/studio_chat_\1>/

export function parseChatMessageOrigin(text: string): ChatMessageOrigin | null {
  const value = String(text || '').trim()
  const shown = DISPLAY.exec(value)
  if (shown) return { kind: shown[1] ? 'reply' : 'from', chat: shown[2], text: shown[3].trim() }
  const raw = RAW.exec(value)
  if (raw) return { kind: raw[1] === 'reply' ? 'reply' : 'from', chat: raw[2], text: raw[3].trim() }
  return null
}
