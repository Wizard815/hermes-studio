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

describe('/yolo in a coding-agent chat', () => {
  beforeEach(() => {
    chat.sendMessage.mockClear()
    herdr.enabled = false
  })

  it('is in the slash menu with what it does for coding agents', async () => {
    chat.activeSession = { id: 'chat-1', source: 'coding_agent', codingAgentId: 'codex', agent: 'codex', title: 'Codex chat', messages: [] }
    const wrapper = mount(ChatInput, { global: { stubs } })
    await flushPromises()
    const commands = (wrapper.vm as any).$.setupState.filteredBridgeCommands as { name: string; description: string }[]
    expect(commands.find(command => command.name === 'yolo')?.description).toBe('chat.slashCommands.codingAgentYolo')
    // Still only the commands coding agents answer.
    expect(commands.map(command => command.name).sort()).toEqual(['cleanroom', 'compact', 'context', 'status', 'usage', 'yolo'])
  })

  it('keeps the Hermes description in Hermes chats', async () => {
    chat.activeSession = { id: 'chat-1', source: 'cli', title: 'Hermes chat', messages: [] }
    const wrapper = mount(ChatInput, { global: { stubs } })
    await flushPromises()
    const commands = (wrapper.vm as any).$.setupState.filteredBridgeCommands as { name: string; description: string }[]
    expect(commands.find(command => command.name === 'yolo')?.description).toBe('chat.slashCommands.yolo')
  })

  it('is sent to the agent chat as a command', async () => {
    chat.activeSession = { id: 'chat-1', source: 'coding_agent', codingAgentId: 'codex', agent: 'codex', title: 'Codex chat', messages: [] }
    await typeAndSend('/yolo')
    expect(chat.sendMessage).toHaveBeenCalledWith('/yolo', undefined)
  })
})
