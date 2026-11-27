import { ref } from 'vue'
import { normalizeReplyStyle, type ReplyStyle } from '../../../shared/reply-style'

/** The reply style picked in the composer's settings (docs/reply-styles.md); one choice for this browser. */
export const REPLY_STYLE_STORAGE_KEY = 'hermes_reply_style'

function read(): ReplyStyle {
  try { return normalizeReplyStyle(localStorage.getItem(REPLY_STYLE_STORAGE_KEY)) } catch { return 'normal' }
}

export const replyStyle = ref<ReplyStyle>(read())

export function setReplyStyle(style: ReplyStyle): void {
  replyStyle.value = style
  try {
    if (style === 'normal') localStorage.removeItem(REPLY_STYLE_STORAGE_KEY)
    else localStorage.setItem(REPLY_STYLE_STORAGE_KEY, style)
  } catch { /* the choice still holds for this page */ }
}

/** The run field: nothing for normal, so runs without a style look exactly as before. */
export function replyStyleRunField(): { reply_style?: Exclude<ReplyStyle, 'normal'> } {
  const style = replyStyle.value
  return style === 'normal' ? {} : { reply_style: style }
}
