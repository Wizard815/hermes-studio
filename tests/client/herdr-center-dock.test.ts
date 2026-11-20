// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, reactive } from 'vue'

const herdr = reactive<any>({
  status: { settings: { enabled: true }, keys: {} },
  enabled: true,
  connected: true,
  error: '',
  bridge: {
    connected: true,
    focusedPaneId: 'w2:p2',
    panes: [
      { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', label: 'One', cwd: '/code/one', studioSessionId: 'chat-1', studioAgent: 'claude-code', nativeSessionId: null },
      { pane_id: 'w2:p2', workspace_id: 'w2', agent: 'codex', agent_status: 'working', label: 'Two', cwd: '/code/two', studioSessionId: 'chat-2', studioAgent: 'codex', nativeSessionId: null },
    ],
    chatSpaces: ['chat-1', 'chat-2'],
  },
  acquire: vi.fn(),
  release: vi.fn(),
  refresh: vi.fn(async () => undefined),
})
const api = vi.hoisted(() => ({ focusHerdrPane: vi.fn(async () => undefined) }))

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
  openSessionInHerdr: vi.fn(async () => ({ link: { paneId: 'w1:p2' } })),
  reopenClosedHerdrChat: vi.fn(async () => ({ reopened: [], remaining: 0 })),
  studioFocusRequest: { at: 0, paneId: '' },
}))
vi.mock('@/components/coding-agents/herdr/HerdrTerminal.vue', () => ({
  default: defineComponent({ name: 'HerdrTerminal', setup: (_, { expose }) => { expose({ send: () => true, focus: () => undefined }); return () => h('div', { class: 'fake-terminal' }) } }),
}))
// Studio's Spaces sidebar has its own tests (herdr-space-folders, e2e herdr-center).
vi.mock('@/components/coding-agents/herdr/HerdrSpaceSidebar.vue', () => ({ default: defineComponent({ name: 'HerdrSpaceSidebar', setup: (_, { expose }) => { expose({ step: () => true }); return () => h('aside', { class: 'fake-spaces' }) } }) }))
// The dock's tools have their own tests; here they are placeholders that pick a pane.
vi.mock('@/mission/sources/SourceChats.vue', () => ({ default: defineComponent({ emits: ['select-pane'], setup: (_, { emit }) => () => h('button', { class: 'fake-chats', onClick: () => emit('select-pane', 'w1:p2') }) }) }))
vi.mock('@/mission/sources/SourceTasks.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/sources/SourceProjects.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/sources/SourceIdeas.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/sources/SourceUpkeep.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/sources/ControlPanel.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/sources/OrbNotConnected.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/useMission', () => ({ useOrbConnection: () => ({ state: { checked: true, configured: false } }) }))
// Command Center (the dock's first row) has its own tests; here: its shared state and placeholders.
const commandCenter = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn(), unseen: { value: 0 } }))
vi.mock('@/mission/command-center/useCommandCenter', () => ({ useCommandCenter: () => commandCenter }))
vi.mock('@/mission/command-center/CommandInbox.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/command-center/CommandAgents.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/command-center/CommandFiles.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/command-center/CommandBoard.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/command-center/CommandSkills.vue', () => ({ default: { render: () => null } }))
vi.mock('@/mission/command-center/CommandUsage.vue', () => ({ default: { render: () => null } }))

import HerdrCenter from '@/components/coding-agents/herdr/HerdrCenter.vue'

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

// These are herdr's own terminal UI (the Herdr App layout has its own tests: herdr-app-view).
beforeEach(() => { localStorage.clear(); localStorage.setItem('studio_herdr_view', 'tui'); api.focusHerdrPane.mockClear() })
afterEach(() => setWidth(1024))

describe('the herdr page: herdr with Mission docked', () => {
  it('docks Mission beside herdr on a wide screen and remembers the tab', async () => {
    setWidth(1440)
    const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-2', active: true } })
    await flushPromises()
    expect(wrapper.find('.fake-terminal').exists()).toBe(true)
    const dock = wrapper.find('[data-testid="herdr-dock"]')
    expect(dock.exists()).toBe(true)
    expect(dock.classes()).not.toContain('is-drawer')
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual([
      'commandCenter.tabs.inbox', 'commandCenter.tabs.agents', 'commandCenter.tabs.files', 'commandCenter.tabs.board', 'commandCenter.tabs.skills',
      'mission.sources.chats', 'mission.sources.tasks', 'mission.sources.projects', 'mission.sources.ideas', 'mission.sources.upkeep', 'mission.sources.control'])
    expect(commandCenter.acquire).toHaveBeenCalled()
    // Arrow keys move along the tabs (Chats → its left neighbour, Skills).
    await wrapper.find('[data-testid="herdr-dock-tab-chats"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.find('[data-testid="herdr-dock-tab-skills"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-testid="herdr-dock-tab-skills"]').attributes('tabindex')).toBe('0')
    await wrapper.find('[data-testid="herdr-dock-tab-control"]').trigger('click')
    expect(JSON.parse(localStorage.getItem('studio_herdr_dock')!)).toEqual({ open: true, tab: 'control' })
    await wrapper.find('[data-testid="herdr-center-dock-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="herdr-dock"]').exists()).toBe(false)
    expect(JSON.parse(localStorage.getItem('studio_herdr_dock')!).open).toBe(false)
  })

  it('badges the Tools button and the Inbox tab with what is new', async () => {
    setWidth(1440)
    commandCenter.unseen.value = 3
    const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-2', active: true } })
    await flushPromises()
    expect(wrapper.find('[data-testid="herdr-center-inbox-badge"]').text()).toBe('3')
    expect(wrapper.find('[data-testid="herdr-dock-inbox-badge"]').text()).toBe('3')
    wrapper.unmount()
    expect(commandCenter.release).toHaveBeenCalled()
    commandCenter.unseen.value = 0
  })

  it('has Open in Studio for the pane herdr shows, New chat and Reopen (no second Back to chat)', async () => {
    setWidth(1440)
    const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-2', active: true } })
    await flushPromises()
    expect(wrapper.find('[data-testid="herdr-center-back"]').exists()).toBe(false)
    await wrapper.find('[data-testid="herdr-center-open-studio"]').trigger('click')
    expect(wrapper.emitted('open-studio-chat')?.[0]).toEqual(['chat-2'])
    expect(wrapper.find('[data-testid="herdr-center-reopen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="herdr-center-new-chat"]').exists()).toBe(true)
  })

  it('puts its bar in the chat page header row, and only while herdr is shown', async () => {
    setWidth(1440)
    const header = document.createElement('div')
    document.body.appendChild(header)
    const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-2', active: true, headerTarget: header }, attachTo: document.body })
    await flushPromises()
    const bar = header.querySelector('[data-testid="herdr-center-bar"]') as HTMLElement
    expect(bar).not.toBeNull()
    expect(bar.classList.contains('in-header')).toBe(true)
    expect(wrapper.find('section [data-testid="herdr-center-bar"]').exists()).toBe(false)
    // The chat title is in the header already: the chip shows the agent and pane only.
    expect(bar.querySelector('[data-testid="herdr-center-agent"]')?.textContent).toContain('codex')
    expect(bar.querySelector('[data-testid="herdr-center-agent"]')?.textContent).not.toContain('Two')
    for (const id of ['herdr-center-open-studio', 'herdr-center-new-chat', 'herdr-center-reopen', 'herdr-center-dock-toggle']) {
      expect(bar.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
    }
    await wrapper.setProps({ active: false })
    expect(bar.style.display).toBe('none')
    wrapper.unmount()
    header.remove()
  })

  it('is a drawer on a phone: closed at first, closes after a pick and on the backdrop', async () => {
    setWidth(390)
    const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-2', active: true } })
    await flushPromises()
    expect(wrapper.find('[data-testid="herdr-dock"]').exists()).toBe(false)
    await wrapper.find('[data-testid="herdr-center-dock-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="herdr-dock"]').classes()).toContain('is-drawer')
    await wrapper.find('.fake-chats').trigger('click')
    expect(api.focusHerdrPane).toHaveBeenCalledWith('w1:p2')
    expect(wrapper.find('[data-testid="herdr-dock"]').exists()).toBe(false)
    await wrapper.find('[data-testid="herdr-center-dock-toggle"]').trigger('click')
    await wrapper.find('[data-testid="herdr-dock-backdrop"]').trigger('click')
    expect(wrapper.find('[data-testid="herdr-dock"]').exists()).toBe(false)
  })
})

describe('the herdr page on a phone, with the chat header\'s own menu', () => {
  it('has no More button of its own and hands its actions to the page menu', async () => {
    setWidth(390)
    const header = document.createElement('div')
    document.body.appendChild(header)
    const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-2', active: true, headerTarget: header, hostMenu: true }, attachTo: document.body })
    await flushPromises()
    const bar = header.querySelector('[data-testid="herdr-center-bar"]') as HTMLElement
    expect(bar.querySelector('[data-testid="herdr-center-more"]')).toBeNull()
    expect(bar.querySelector('[data-testid="herdr-center-reopen"]')).toBeNull()
    expect(bar.querySelector('[data-testid="herdr-center-dock-toggle"]')).not.toBeNull()
    const vm = wrapper.vm as any
    expect(vm.menuItems.map((item: any) => item.key).slice(0, 4)).toEqual(['view-mode', 'sidebar-mode', 'open-studio', 'new-chat'])
    expect(vm.menuItems.map((item: any) => item.key)).toContain('key:search')
    vm.runMenuItem('open-studio')
    expect(wrapper.emitted('open-studio-chat')?.[0]).toEqual(['chat-2'])
    wrapper.unmount()
    header.remove()
  })

  it('keeps its actions in its bar on wide screens (nothing for the page menu)', async () => {
    setWidth(1440)
    const header = document.createElement('div')
    document.body.appendChild(header)
    const wrapper = mount(HerdrCenter, { props: { sessionId: 'chat-2', active: true, headerTarget: header, hostMenu: true }, attachTo: document.body })
    await flushPromises()
    expect((wrapper.vm as any).menuItems).toEqual([])
    expect(header.querySelector('[data-testid="herdr-center-reopen"]')).not.toBeNull()
    wrapper.unmount()
    header.remove()
  })
})
