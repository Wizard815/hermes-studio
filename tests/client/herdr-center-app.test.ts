// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, reactive } from 'vue'

/** HerdrCenter's wiring of the Herdr App layout (HerdrAppView has its own tests: herdr-app-view). */
const herdr = reactive<any>({
  status: { settings: { enabled: true }, keys: { prefix: 'ctrl+b', newChat: 'prefix+n', reopen: 'prefix+t' }, home: '/home/me' },
  enabled: true,
  connected: true,
  error: '',
  bridge: {
    connected: true,
    focusedPaneId: 'w1:p2',
    workspaces: [{ workspace_id: 'w1', label: 'api' }, { workspace_id: 'w9', label: 'scratch' }],
    panes: [{ pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', label: 'One', studioSessionId: 'chat-1', studioAgent: 'claude-code', nativeSessionId: null },
      { pane_id: 'w9:p1', workspace_id: 'w9', studioSessionId: null, studioAgent: null, nativeSessionId: null }],
    chatSpaces: ['chat-1'],
    elevatedChats: ['chat-1'],
  },
  elevatedChats: new Set(['chat-1']),
  isElevated(id: string) { return this.elevatedChats?.has(id) ?? false },
  noteElevated: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  refresh: vi.fn(async () => undefined),
})
const api = vi.hoisted(() => ({ focusHerdrPane: vi.fn(async () => undefined), reopen: vi.fn(async () => ({ reopened: [], remaining: 0 })), open: vi.fn(async () => ({ link: { paneId: 'w1:p2' } })) }))
const app = vi.hoisted(() => ({ step: vi.fn(() => true), openChat: vi.fn(() => true), newTab: vi.fn(async () => undefined), toggleSidebar: vi.fn() }))

vi.mock('naive-ui', async importOriginal => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/hermes/herdr', () => ({ useHerdrStore: () => herdr }))
vi.mock('@/api/coding-agents/herdr', () => ({
  fetchHerdrMachines: vi.fn(async () => ({ machines: [] })),
  focusHerdrMachineAgent: vi.fn(),
  focusHerdrPane: api.focusHerdrPane,
  openSessionInHerdr: api.open,
  reopenClosedHerdrChat: api.reopen,
  studioFocusRequest: { at: 0, paneId: '' },
}))
const terminals: string[] = []
vi.mock('@/components/coding-agents/herdr/HerdrTerminal.vue', () => ({
  default: defineComponent({ name: 'HerdrTerminal', props: { mode: String, target: String }, setup: (props, { expose }) => { terminals.push(props.mode || ''); expose({ send: () => true, focus: () => undefined }); return () => h('div', { class: 'fake-terminal' }) } }),
}))
vi.mock('@/components/coding-agents/herdr/HerdrSpaceSidebar.vue', () => ({ default: defineComponent({ setup: (_, { expose }) => { expose({ step: () => true }); return () => h('aside') } }) }))
vi.mock('@/components/coding-agents/herdr/HerdrAppView.vue', () => ({
  default: defineComponent({
    name: 'HerdrAppView',
    props: { panel: String, dockTab: String, home: Array },
    emits: ['panel', 'new-chat', 'palette', 'open-chat', 'focus-pane', 'open-machine'],
    setup(props, { expose, slots }) {
      expose({ ...app, chatList: () => [{ id: 'chat-1', title: 'One', folder: 'Work' }], focusTerminal: () => undefined, focusedPaneId: 'w1:p2' })
      return () => h('div', { class: 'fake-app', 'data-panel': props.panel }, slots.panel?.())
    },
  }),
}))
vi.mock('@/components/coding-agents/herdr/HerdrChangesPanel.vue', () => ({ default: defineComponent({ props: { paneId: String }, setup: props => () => h('div', { class: 'fake-changes', 'data-pane': props.paneId }) }) }))
vi.mock('@/components/coding-agents/herdr/HerdrMissionDock.vue', () => ({ default: defineComponent({ props: { tab: String }, setup: props => () => h('div', { class: 'fake-dock', 'data-tab': props.tab }) }) }))
const commandCenter = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn(), unseen: { value: 0 } }))
vi.mock('@/mission/command-center/useCommandCenter', () => ({ useCommandCenter: () => commandCenter }))

import HerdrCenter from '@/components/coding-agents/herdr/HerdrCenter.vue'

beforeEach(() => {
  localStorage.clear()
  terminals.length = 0
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  for (const fn of [...Object.values(api), ...Object.values(app)]) fn.mockClear()
})

async function mountCenter() {
  const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-1', active: true }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

function key(init: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

describe('the herdr page in the Herdr App layout', () => {
  it('is the default look: no herdr terminal UI, panels hidden at first; a switch goes back to herdr\'s own UI', async () => {
    const wrapper = await mountCenter()
    expect(wrapper.find('.fake-app').exists()).toBe(true)
    expect(wrapper.find('.fake-app').attributes('data-panel')).toBe('')
    expect(terminals).toEqual([])
    await wrapper.find('[data-testid="herdr-center-view-toggle"]').trigger('click')
    expect(localStorage.getItem('studio_herdr_view')).toBe('tui')
    expect(wrapper.find('.fake-app').exists()).toBe(false)
    expect(terminals).toEqual(['client'])
    await wrapper.find('[data-testid="herdr-center-view-toggle"]').trigger('click')
    expect(wrapper.find('.fake-app').exists()).toBe(true)
    wrapper.unmount()
  })

  it('opens Files and Issues in Studio\'s tools, Changes in its own panel, and Tools from the header', async () => {
    const wrapper = await mountCenter()
    const view = wrapper.findComponent({ name: 'HerdrAppView' })
    view.vm.$emit('panel', 'files')
    await flushPromises()
    expect(wrapper.find('.fake-dock').attributes('data-tab')).toBe('files')
    view.vm.$emit('panel', 'issues')
    await flushPromises()
    expect(wrapper.find('.fake-dock').attributes('data-tab')).toBe('inbox')
    view.vm.$emit('panel', 'changes')
    await flushPromises()
    expect(wrapper.find('.fake-dock').exists()).toBe(false)
    expect(wrapper.find('.fake-changes').attributes('data-pane')).toBe('w1:p2')
    view.vm.$emit('panel', 'changes')
    await flushPromises()
    expect(wrapper.find('.fake-changes').exists()).toBe(false)
    await wrapper.find('[data-testid="herdr-center-dock-toggle"]').trigger('click')
    expect(wrapper.find('.fake-dock').exists()).toBe(true)
    wrapper.unmount()
  })

  it('Ctrl+Shift+P opens the command palette: spaces, chats and actions', async () => {
    const wrapper = await mountCenter()
    key({ key: 'P', ctrlKey: true, shiftKey: true })
    await flushPromises()
    const palette = wrapper.find('[data-testid="herdr-app-palette"]')
    expect(palette.exists()).toBe(true)
    const ids = palette.findAll('[role="option"]').map(item => item.attributes('data-testid'))
    expect(ids).toContain('herdr-app-palette-item-action:reopen')
    expect(ids).toContain('herdr-app-palette-item-space:w9')
    expect(ids).toContain('herdr-app-palette-item-chat:chat-1')
    // A chat's space is the chat, not listed twice.
    expect(ids).not.toContain('herdr-app-palette-item-space:w1')
    const input = wrapper.find('[data-testid="herdr-app-palette-input"]')
    await input.setValue('One')
    await input.trigger('keydown', { key: 'Enter' })
    expect(app.openChat).toHaveBeenCalledWith('chat-1')
    expect(wrapper.find('[data-testid="herdr-app-palette"]').exists()).toBe(false)
    key({ key: 'P', ctrlKey: true, shiftKey: true })
    await flushPromises()
    await wrapper.find('[data-testid="herdr-app-palette-item-action:reopen"]').trigger('click')
    expect(api.reopen).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('Alt+Up/Down go through the Spaces list as it shows; New Chat makes a Studio chat (it opens in herdr too)', async () => {
    const wrapper = await mountCenter()
    key({ key: 'ArrowDown', altKey: true })
    key({ key: 'ArrowUp', altKey: true })
    expect(app.step.mock.calls).toEqual([[1], [-1]])
    await wrapper.find('[data-testid="herdr-center-new-chat"]').trigger('click')
    expect(wrapper.emitted('new-chat')).toHaveLength(1)
    wrapper.unmount()
  })

  it('never elevates the open chat by itself; "Elevate this chat" does', async () => {
    const saved = { bridge: herdr.bridge, elevated: herdr.elevatedChats }
    herdr.bridge = { ...saved.bridge, panes: saved.bridge.panes.filter((pane: any) => !pane.studioSessionId) }
    herdr.elevatedChats = new Set(['chat-1'])
    try {
      const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-2', active: true }, attachTo: document.body })
      await flushPromises()
      expect(api.open).not.toHaveBeenCalled()
      const button = wrapper.find('[data-testid="herdr-center-open"]')
      expect(button.text()).toBe('herdr.elevateThis')
      await button.trigger('click')
      await flushPromises()
      expect(api.open).toHaveBeenCalledWith('chat-2')
      wrapper.unmount()
    } finally { herdr.bridge = saved.bridge; herdr.elevatedChats = saved.elevated }
  })

  it('with nothing in herdr, explains how chats get there and offers "Elevate this chat"', async () => {
    const saved = { bridge: herdr.bridge, elevated: herdr.elevatedChats }
    herdr.bridge = { ...saved.bridge, workspaces: [], panes: [], elevatedChats: [] }
    herdr.elevatedChats = new Set()
    try {
      const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-2', active: true }, attachTo: document.body })
      await flushPromises()
      const nothing = wrapper.find('[data-testid="herdr-center-nothing"]')
      expect(nothing.exists()).toBe(true)
      expect(nothing.attributes('role')).toBe('status')
      expect(nothing.text()).toContain('herdr.nothingTitle')
      expect(wrapper.find('.fake-app').exists()).toBe(false)
      await wrapper.find('[data-testid="herdr-center-elevate"]').trigger('click')
      await flushPromises()
      expect(api.open).toHaveBeenCalledWith('chat-2')
      await wrapper.find('[data-testid="herdr-center-back"]').trigger('click')
      expect(wrapper.emitted('back')).toHaveLength(1)
      wrapper.unmount()
      // No chat open (a fresh install): still the explanation, no elevate button.
      const empty = mount(HerdrCenter, { props: { sessionId: '', active: true }, attachTo: document.body })
      await flushPromises()
      expect(empty.find('[data-testid="herdr-center-nothing"]').exists()).toBe(true)
      expect(empty.find('[data-testid="herdr-center-elevate"]').exists()).toBe(false)
      empty.unmount()
    } finally { herdr.bridge = saved.bridge; herdr.elevatedChats = saved.elevated }
  })
})
