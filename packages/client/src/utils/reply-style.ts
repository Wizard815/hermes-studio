import { ref } from 'vue'
import { normalizeReplyStyle, type ReplyStyle } from '../../../shared/reply-style'

/**
 * The reply style picked in the composer's settings or with /emoji
 * (docs/reply-styles.md); one choice for this browser. Emoji is the default.
 */
export const REPLY_STYLE_STORAGE_KEY = 'hermes_reply_style'
export const DEFAULT_REPLY_STYLE: ReplyStyle = 'emoji'

function read(): ReplyStyle {
  try {
    const saved = localStorage.getItem(REPLY_STYLE_STORAGE_KEY)
    return saved === null ? DEFAULT_REPLY_STYLE : normalizeReplyStyle(saved)
  } catch { return DEFAULT_REPLY_STYLE }
}

export const replyStyle = ref<ReplyStyle>(read())

export function setReplyStyle(style: ReplyStyle): void {
  replyStyle.value = style
  try { localStorage.setItem(REPLY_STYLE_STORAGE_KEY, style) } catch { /* the choice still holds for this page */ }
}

/** `/emoji` in Studio's composer: emoji replies on, or back to normal when they are on. Returns the new style. */
export function toggleEmojiReplies(): ReplyStyle {
  const next: ReplyStyle = replyStyle.value === 'emoji' ? 'normal' : 'emoji'
  setReplyStyle(next)
  return next
}

/** `/emoji` alone (any case, spaces around it); `/emoji something` still goes to the agent. */
export const isEmojiToggleCommand = (text: string) => /^\/emoji$/i.test(text.trim())

/** The run field: nothing for normal, so runs without a style look exactly as before. */
export function replyStyleRunField(): { reply_style?: Exclude<ReplyStyle, 'normal'> } {
  const style = replyStyle.value
  return style === 'normal' ? {} : { reply_style: style }
}
