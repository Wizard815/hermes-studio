// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import naive from 'naive-ui'
import PinComment from '@/components/common/PinComment.vue'
import { imageName, pinCommentText, pinPercent, setPinCommentTarget } from '@/utils/pin-comment'
import { pinCommentMessages } from '@/i18n/pin-comment-messages'

const i18n = () => createI18n({ legacy: false, locale: 'en', messages: { en: pinCommentMessages.en as any } })

afterEach(() => setPinCommentTarget(null))

describe('TestPinComment_text', () => {
  it('writes the comment the way the chat reads it', () => {
    expect(pinCommentText('17-projects-marked-in-chats.png', 9, 25, '  test ')).toBe('Comment on 17-projects-marked-in-chats.png (pinned at 9% from the left, 25% from the top): test')
    expect(pinCommentText(' ', 0, 100, 'x')).toBe('Comment on this image (pinned at 0% from the left, 100% from the top): x')
  })

  it('clamps and rounds the spot, and names images by file', () => {
    expect([pinPercent(45, 500), pinPercent(-3, 100), pinPercent(130, 100), pinPercent(5, 0)]).toEqual([9, 0, 100, 0])
    expect(imageName('/api/hermes/files/shots/17-projects-marked-in-chats.png?x=1')).toBe('17-projects-marked-in-chats.png')
    expect(imageName('https://h/a%20b.jpg')).toBe('a b.jpg')
    expect(imageName('/api/studio/files/download?path=%2Fsrv%2Fshots%2F17-projects-marked-in-chats.png&token=x')).toBe('17-projects-marked-in-chats.png')
    expect(imageName('data:image/png;base64,AAAA', 'Browser screenshot')).toBe('Browser screenshot')
    expect(imageName('blob:http://h/123')).toBe('this image')
  })

  it('every locale has every string', () => {
    const keys = Object.keys(pinCommentMessages.en.pinComment).sort()
    for (const [locale, messages] of Object.entries(pinCommentMessages)) expect(Object.keys(messages.pinComment).sort(), locale).toEqual(keys)
  })
})

describe('TestPinComment_component', () => {
  function mountPin(active = true) {
    const wrapper = mount(PinComment, { props: { name: 'shot.png', active }, slots: { default: '<img src="shot.png" alt="">' }, global: { plugins: [i18n(), naive] }, attachTo: document.body })
    const layer = () => wrapper.get('[data-testid="pin-comment-layer"]')
    layer().element.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON: () => ({}) })
    return { wrapper, layer }
  }

  it('a click pins a spot, and Send posts the comment to the chat and leaves a numbered mark', async () => {
    const send = vi.fn(async () => {})
    setPinCommentTarget(send)
    const { wrapper, layer } = mountPin()
    await layer().trigger('click', { clientX: 136, clientY: 100 })
    await wrapper.get('[data-testid="pin-comment-input"] textarea').setValue('test')
    await wrapper.get('[data-testid="pin-comment-popover"]').trigger('submit')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('Comment on shot.png (pinned at 9% from the left, 25% from the top): test')
    expect(wrapper.find('[data-testid="pin-comment-popover"]').exists()).toBe(false)
    expect(wrapper.findAll('.pin-comment-mark--sent').map(mark => mark.text())).toEqual(['1'])
    expect(wrapper.emitted('sent')?.[0]).toEqual(['Comment on shot.png (pinned at 9% from the left, 25% from the top): test'])
    wrapper.unmount()
  })

  it('an empty comment is not sent, Escape cancels, a failed send keeps the draft, and inactive pins nothing', async () => {
    const send = vi.fn(async () => { throw new Error('offline') })
    setPinCommentTarget(send)
    const { wrapper, layer } = mountPin()
    await layer().trigger('click', { clientX: 300, clientY: 150 })
    await wrapper.get('[data-testid="pin-comment-popover"]').trigger('submit')
    expect(send).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="pin-comment-input"] textarea').setValue('fix this')
    await wrapper.get('[data-testid="pin-comment-popover"]').trigger('submit')
    await flushPromises()
    expect(wrapper.emitted('error')?.[0]?.[0]).toContain('offline')
    expect((wrapper.get('[data-testid="pin-comment-input"] textarea').element as HTMLTextAreaElement).value).toBe('fix this')
    await wrapper.get('[data-testid="pin-comment-input"] textarea').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="pin-comment-popover"]').exists()).toBe(false)
    await wrapper.setProps({ active: false })
    expect(wrapper.find('[data-testid="pin-comment-layer"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
