// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { REPLY_EMOJI, emojiReply, replyStyleInstruction } from '../../packages/shared/reply-style'
import { replyStyleMessages } from '../../packages/client/src/i18n/reply-style-messages'
import { DEFAULT_REPLY_STYLE, REPLY_STYLE_STORAGE_KEY, isEmojiToggleCommand, replyStyle, replyStyleRunField, setReplyStyle, toggleEmojiReplies } from '../../packages/client/src/utils/reply-style'
import EmojiReplyCard from '../../packages/client/src/components/hermes/chat/EmojiReplyCard.vue'

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => keys(item, prefix ? `${prefix}.${key}` : key))
}

describe('TestReplyStyle_emojiSet', () => {
  it('has ten distinct emoji, each with a message in every locale', () => {
    expect(REPLY_EMOJI).toHaveLength(10)
    expect(new Set(REPLY_EMOJI.map(entry => entry.emoji)).size).toBe(10)
    const english = keys((replyStyleMessages as any).en).sort()
    for (const entry of REPLY_EMOJI) expect(english).toContain(`replyStyle.emoji.${entry.key}`)
    for (const [locale, table] of Object.entries(replyStyleMessages)) {
      expect(keys(table).sort(), locale).toEqual(english)
      const i18n = createI18n({ legacy: false, locale, messages: { [locale]: table as any }, missingWarn: false, fallbackWarn: false })
      for (const key of english) expect(i18n.global.t(key, { style: 'x' }), `${locale} ${key}`).not.toBe(key)
    }
  })

  it('knows a reply that is only one of the ten, with or without the variation selector', () => {
    expect(emojiReply(' ✅\n')?.key).toBe('done')
    expect(emojiReply('⚠')?.key).toBe('warning')
    expect(emojiReply('⚠️')?.key).toBe('warning')
    expect(emojiReply('✅ done')).toBeNull()
    expect(emojiReply('😀')).toBeNull()
    expect(emojiReply('')).toBeNull()
  })
})

describe('TestReplyStyle_instruction', () => {
  it('lists the ten emoji with the safety exceptions for emoji, says nothing for normal', () => {
    const text = replyStyleInstruction('emoji')
    for (const entry of REPLY_EMOJI) expect(text).toContain(entry.emoji)
    expect(text).toMatch(/cannot be undone/)
    expect(text).toMatch(/"explain"/)
    expect(replyStyleInstruction('caveman')).toMatch(/verbatim/)
    expect(replyStyleInstruction('normal')).toBe('')
    expect(replyStyleInstruction('something else')).toBe('')
  })
})

describe('TestReplyStyle_setting', () => {
  beforeEach(() => setReplyStyle('normal'))

  it('is kept in this browser and adds reply_style to runs only when on', () => {
    expect(replyStyleRunField()).toEqual({})
    setReplyStyle('emoji')
    expect(localStorage.getItem(REPLY_STYLE_STORAGE_KEY)).toBe('emoji')
    expect(replyStyleRunField()).toEqual({ reply_style: 'emoji' })
    setReplyStyle('normal')
    expect(localStorage.getItem(REPLY_STYLE_STORAGE_KEY)).toBe('normal')
  })

  it('defaults to emoji and /emoji toggles it off and on', () => {
    expect(DEFAULT_REPLY_STYLE).toBe('emoji')
    expect(toggleEmojiReplies()).toBe('emoji')
    expect(replyStyle.value).toBe('emoji')
    expect(toggleEmojiReplies()).toBe('normal')
    expect(localStorage.getItem(REPLY_STYLE_STORAGE_KEY)).toBe('normal')
    setReplyStyle('caveman')
    expect(toggleEmojiReplies()).toBe('emoji')
    expect(isEmojiToggleCommand(' /emoji ')).toBe(true)
    expect(isEmojiToggleCommand('/EMOJI')).toBe(true)
    expect(isEmojiToggleCommand('/emoji please')).toBe(false)
    expect(isEmojiToggleCommand('emoji')).toBe(false)
  })
})

describe('TestReplyStyle_card', () => {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: (replyStyleMessages as any).en } })

  it('says what the emoji means and sends explain or continue', async () => {
    const wrapper = mount(EmojiReplyCard, { props: { content: '⏳', actions: true }, global: { plugins: [i18n] } })
    expect(wrapper.text()).toContain('Started, still running')
    const buttons = wrapper.findAll('button')
    await buttons[0].trigger('click')
    await buttons[1].trigger('click')
    expect(wrapper.emitted('send')).toEqual([['explain'], ['continue']])
  })

  it('shows nothing for a worded reply', () => {
    const wrapper = mount(EmojiReplyCard, { props: { content: 'Done. Tests pass.', actions: true }, global: { plugins: [i18n] } })
    expect(wrapper.find('[data-testid="emoji-reply"]').exists()).toBe(false)
  })
})
