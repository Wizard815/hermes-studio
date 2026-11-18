// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'

const mocks = vi.hoisted(() => ({
  openChatInHerdr: vi.fn(async (_id: string) => undefined),
  superAdmin: { value: true },
}))

const chat = reactive<any>({
  activeSessionId: 'chat-1',
  activeSession: { id: 'chat-1', source: 'cli', title: 'Old Hermes chat', messages: [] },
  runtimeMode: 'hermes',
  isStreaming: false,
  isAborting: false,
  activeMessageReference: null,
  cancelledAttachmentDrafts: new Map(),
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
  clearMessageReference: vi.fn(),
  setSessionReasoningEffort: vi.fn(),
})
const herdr = reactive({ enabled: true })

vi.mock('naive-ui', async importOriginal => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  useDialog: () => ({ warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), create: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }) }))
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => chat }))
vi.mock('@/stores/hermes/herdr', () => ({ useHerdrStore: () => herdr }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => reactive({ selectedProvider: '', selectedModel: '', modelGroups: [], profileModelGroups: [] }) }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => reactive({ activeProfileName: 'default' }) }))
vi.mock('@/stores/hermes/settings', () => ({ useSettingsStore: () => reactive({ display: {} }) }))
vi.mock('@/api/studio/sessions', () => ({ fetchContextLength: vi.fn(async () => ({ context_length: 0 })) }))
vi.mock('@/api/hermes/model-context', () => ({ setModelContext: vi.fn() }))
vi.mock('@/api/hermes/skills', () => ({ fetchSkills: vi.fn(async () => []) }))
vi.mock('@/api/hermes/skill-bundles', () => ({ fetchSkillBundles: vi.fn(async () => []), deleteSkillBundleApi: vi.fn() }))
vi.mock('@/api/client', () => ({ isStoredSuperAdmin: () => mocks.superAdmin.value }))
vi.mock('@/utils/mission-url', () => ({ openChatInHerdr: mocks.openChatInHerdr }))
vi.mock('@/api/coding-agents/herdr', () => ({}))
vi.mock('@/api/coding-agents', () => ({}))
vi.mock('@/api/studio/orb', () => ({}))

import ChatInput from '@/components/hermes/chat/ChatInput.vue'

const stubs = { VoiceDialogueControls: true, BundleCreateModal: true, ImagePreviewOverlay: true, ScreenshotButton: true }

async function typeAndSend(text: string) {
  const wrapper = mount(ChatInput, { global: { stubs } })
  await flushPromises()
  const textarea = wrapper.find('textarea')
  await textarea.setValue(text)
  await (wrapper.vm as any).$?.setupState?.handleSend?.()
  await flushPromises()
  return wrapper
}

describe('/herdr in the chat box', () => {
  beforeEach(() => {
    mocks.openChatInHerdr.mockClear()
    chat.sendMessage.mockClear()
    mocks.superAdmin.value = true
    herdr.enabled = true
    chat.activeSession = { id: 'chat-1', source: 'cli', title: 'Old Hermes chat', messages: [] }
  })

  it('opens the chat in herdr and is not sent to the agent', async () => {
    const wrapper = await typeAndSend('/herdr')
    expect(mocks.openChatInHerdr).toHaveBeenCalledWith('chat-1')
    expect(chat.sendMessage).not.toHaveBeenCalled()
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('works for Ekko chats too', async () => {
    chat.activeSession = { id: 'chat-1', source: 'builtin_agent', agent: 'ekko-agent', title: 'Ekko', messages: [] }
    await typeAndSend('/herdr')
    expect(mocks.openChatInHerdr).toHaveBeenCalledWith('chat-1')
    expect(chat.sendMessage).not.toHaveBeenCalled()
  })

  it('is listed in the slash menu with its description', async () => {
    const wrapper = mount(ChatInput, { global: { stubs } })
    await flushPromises()
    const names = ((wrapper.vm as any).$.setupState.filteredBridgeCommands as { name: string; description: string }[])
    expect(names.find(command => command.name === 'herdr')?.description).toBe('herdr.slashCommand')
  })

  it('stays out where the chat has no herdr space or herdr is off', async () => {
    chat.activeSession = { id: 'chat-1', source: 'cli', title: 'Archived', messages: [], isArchived: true }
    let wrapper = mount(ChatInput, { global: { stubs } })
    await flushPromises()
    expect((wrapper.vm as any).$.setupState.filteredBridgeCommands.some((command: { name: string }) => command.name === 'herdr')).toBe(false)
    chat.activeSession = { id: 'chat-1', source: 'cli', title: 'Old Hermes chat', messages: [] }
    herdr.enabled = false
    wrapper = mount(ChatInput, { global: { stubs } })
    await flushPromises()
    expect((wrapper.vm as any).$.setupState.filteredBridgeCommands.some((command: { name: string }) => command.name === 'herdr')).toBe(false)
  })

  it('is sent as plain text for people who cannot use herdr', async () => {
    mocks.superAdmin.value = false
    await typeAndSend('/herdr')
    expect(mocks.openChatInHerdr).not.toHaveBeenCalled()
    expect(chat.sendMessage).toHaveBeenCalledWith('/herdr', undefined)
  })
})
