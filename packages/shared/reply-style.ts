/**
 * Reply styles (docs/reply-styles.md): cheaper answers, picked in the chat
 * composer's settings. "emoji" lets the model answer with one emoji from a
 * fixed set when that says it all; "caveman" asks for terse words. The
 * instruction goes into the run's system instructions, which stay the same
 * while the style is on, so the prompt cache (and llama.cpp's KV cache through
 * Argos) keeps working.
 */

export type ReplyStyle = 'normal' | 'emoji' | 'caveman'
export const REPLY_STYLES: ReplyStyle[] = ['normal', 'emoji', 'caveman']

/** The ten emoji a reply may be, and what each one means. Order is the legend's order. */
export const REPLY_EMOJI = [
  { emoji: '✅', key: 'done', meaning: 'done, yes, it works' },
  { emoji: '❌', key: 'no', meaning: 'no, it failed, or it is not possible' },
  { emoji: '👍', key: 'ok', meaning: 'OK, understood, going ahead' },
  { emoji: '❓', key: 'question', meaning: 'I need more information from you' },
  { emoji: '⚠️', key: 'warning', meaning: 'done, but there is a problem you should know about' },
  { emoji: '⏳', key: 'running', meaning: 'started, still running' },
  { emoji: '🤔', key: 'unsure', meaning: 'not sure, it depends' },
  { emoji: '🚫', key: 'blocked', meaning: 'blocked: needs your approval or access' },
  { emoji: '👀', key: 'looking', meaning: 'seen, I will look into it' },
  { emoji: '🎉', key: 'finished', meaning: 'all finished and checked' },
] as const

export type ReplyEmojiKey = typeof REPLY_EMOJI[number]['key']

const bare = (text: string) => text.replace(/️/g, '').trim()

/** The set entry when a whole reply is one of the ten emoji (variation selector and spaces ignored), else null. */
export function emojiReply(text: string | null | undefined) {
  const value = bare(String(text || ''))
  if (!value || value.length > 4) return null
  return REPLY_EMOJI.find(entry => bare(entry.emoji) === value) || null
}

export function normalizeReplyStyle(value: unknown): ReplyStyle {
  return value === 'emoji' || value === 'caveman' ? value : 'normal'
}

/** What the agent is told for a style; empty for normal. */
export function replyStyleInstruction(style: unknown): string {
  switch (normalizeReplyStyle(style)) {
    case 'emoji':
      return [
        'Reply style: emoji (the user wants to save tokens).',
        'When your whole final answer to the latest message fits one of these, reply with only that single emoji, nothing else:',
        ...REPLY_EMOJI.map(entry => `${entry.emoji} ${entry.meaning}`),
        'When it does not fit (the user asked for facts, code, a list, a choice or an explanation), answer in as few plain words as possible.',
        'Use words, never only an emoji, when: the user asked to delete, wipe, overwrite or change something that cannot be undone and you have not done it yet (ask to confirm, saying exactly what will be lost); there is a security risk; or you need an answer from the user (say what you need).',
        'When the user says "explain", give the full worded answer to your previous reply. When the user says "continue", carry on with the work.',
        'This shapes only your final message. Use tools as usual.',
      ].join('\n')
    case 'caveman':
      return [
        'Reply style: caveman (the user wants to save tokens).',
        'Answer first. No greeting, recap, hedging or closing offer. Short words, fragments are fine. One idea per sentence.',
        'Keep every technical fact exact: code, commands, paths, numbers and errors stay verbatim. Never drop not, never, no, only or except.',
        'Use full sentences for security warnings, irreversible steps and questions to the user. Code, commits and files you write stay normal.',
      ].join('\n')
    default:
      return ''
  }
}

/** The messages behind the Explain and Continue buttons on an emoji reply. */
export const EMOJI_EXPLAIN_MESSAGE = 'explain'
export const EMOJI_CONTINUE_MESSAGE = 'continue'
