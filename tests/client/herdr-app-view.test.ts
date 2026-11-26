// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import {
  agentPanes,
  agentSections,
  isPaletteKey,
  paletteMatches,
  paneBox,
  paneHeader,
  phonePane,
  readViewMode,
  shortDuration,
  tildePath,
} from '@/components/coding-agents/herdr/herdr-app-layout'

const api = vi.hoisted(() => ({
  fetchHerdrSpaceView: vi.fn(),
  focusHerdrPane: vi.fn(async () => undefined),
  focusHerdrTab: vi.fn(async () => ({ ok: true })),
  closeHerdrTab: vi.fn(async () => ({ ok: true })),
  createHerdrTab: vi.fn(async () => ({ tabId: 'w1:t3', paneId: 'w1:p9' })),
}))
vi.mock('@/api/coding-agents/herdr', () => api)
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, value?: any) => (typeof value === 'number' ? `${key}:${value}` : key) }) }))
// Each pane's terminal and the Spaces list have their own tests; here they are placeholders.
const terminals: Array<{ target: string; mode: string; bare: boolean }> = []
vi.mock('@/components/coding-agents/herdr/HerdrTerminal.vue', () => ({
  default: defineComponent({
    name: 'HerdrTerminal',
    props: { mode: String, target: String, takeover: Boolean, bare: Boolean },
    emits: ['focused'],
    setup(props, { expose }) {
      terminals.push({ target: props.target, mode: props.mode, bare: props.bare })
      expose({ focus: () => undefined })
      return () => h('div', { class: 'fake-term', 'data-target': props.target })
    },
  }),
}))
vi.mock('@/components/coding-agents/herdr/HerdrSpaceSidebar.vue', () => ({
  default: defineComponent({ name: 'HerdrSpaceSidebar', props: ['variant', 'searchOpen'], setup: (props, { expose }) => { expose({ step: () => true, chatList: [{ id: 'chat-1', title: 'One', folder: 'Work' }], openChat: () => true }); return () => h('aside', { class: 'fake-spaces', 'data-variant': props.variant, 'data-search': String(props.searchOpen) }) } }),
}))

import HerdrAppView from '@/components/coding-agents/herdr/HerdrAppView.vue'

const PANES = [
  { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/home/me/code/x', studioAgent: null, studioSessionId: null, nativeSessionId: null },
  { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude', agent_status: 'working', label: 'auth', cwd: '/home/me/code/x', studioAgent: 'claude-code', studioSessionId: 'chat-1', nativeSessionId: null, status_since: 1000 },
  { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', agent: 'codex', agent_status: 'idle', label: 'docs', studioAgent: 'codex', studioSessionId: null, nativeSessionId: null, status_since: 500 },
] as any[]
const VIEW = {
  workspaceId: 'w1',
  tabs: [{ tab_id: 'w1:t1', label: '1', number: 1, focused: true, agent_status: 'working', pane_count: 2 }, { tab_id: 'w1:t2', label: 'logs', number: 2, focused: false, agent_status: 'idle', pane_count: 1 }],
  activeTabId: 'w1:t1',
  focusedPaneId: 'w1:p2',
  zoomed: false,
  panes: [
    { pane_id: 'w1:p1', focused: false, rect: { x: 0, y: 0, width: 0.5, height: 1 }, process: 'bash' },
    { pane_id: 'w1:p2', focused: true, rect: { x: 0.5, y: 0, width: 0.5, height: 1 }, process: 'claude' },
  ],
}

/** The sidebar shows (v-show). */
function shown(wrapper: ReturnType<typeof mountView>) {
  return !(wrapper.find('[data-testid="herdr-app-sidebar"]').attributes('style') || '').includes('display: none')
}

function mountView(props: Record<string, unknown> = {}) {
  return mount(HerdrAppView, {
    props: { panes: PANES, workspaces: [{ workspace_id: 'w1', label: 'api' }, { workspace_id: 'w2', label: 'site' }], focusedPane: 'w1:p2', elevated: null, activeChat: 'chat-1', machines: [], phone: false, home: ['/home/me'], panel: '', dockTab: 'chats', connected: true, ...props },
  })
}

beforeEach(() => {
  terminals.length = 0
  localStorage.clear()
  for (const fn of Object.values(api)) fn.mockClear()
  api.fetchHerdrSpaceView.mockImplementation(async () => structuredClone(VIEW))
})

describe('Herdr App layout logic', () => {
  it('places split panes with the gap between them and none at the outer edges', () => {
    expect(paneBox({ x: 0, y: 0, width: 0.5, height: 1 }, 8)).toEqual({ left: 'calc(0% + 0px)', top: 'calc(0% + 0px)', width: 'calc(50% - 4px)', height: 'calc(100% - 0px)' })
    expect(paneBox({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 8)).toEqual({ left: 'calc(50% + 4px)', top: 'calc(50% + 4px)', width: 'calc(50% - 4px)', height: 'calc(50% - 4px)' })
  })

  it('heads a pane "bash ~/path", or with the agent and its chat', () => {
    expect(tildePath('/home/me/code', '/home/me')).toBe('~/code')
    expect(tildePath('/real/me/code', ['/home/me', '/real/me'])).toBe('~/code')
    expect(tildePath('/srv', '/home/me')).toBe('/srv')
    expect(paneHeader(PANES[0], 'bash', '/home/me')).toEqual({ title: 'bash', detail: '~/code/x', agent: false })
    expect(paneHeader(PANES[1], 'node', '/home/me')).toEqual({ title: 'claude', detail: 'auth · ~/code/x', agent: true })
    expect(paneHeader({ ...PANES[1], cwd: '', foreground_cwd: '' } as any, 'node', '/home/me')).toEqual({ title: 'claude', detail: 'auth', agent: true })
  })

  it('groups agents Working, Blocked, Done, Idle (newest first), or by space', () => {
    const name = (id: string) => ({ w1: 'api', w2: 'site' } as any)[id]
    const sections = agentSections(PANES, { sort: 'priority', spaceName: name, chatTitle: id => (id === 'chat-1' ? 'Auth chat' : '') })
    expect(sections.map(section => [section.status, section.rows.map(row => row.name)])).toEqual([['working', ['Auth chat']], ['idle', ['docs']]])
    expect(agentSections(PANES, { sort: 'space', spaceName: name }).map(section => section.label)).toEqual(['api', 'site'])
    // A chat's waiting pane reports itself as the chat's idle agent; it is not one.
    expect(agentSections(PANES, { sort: 'priority', spaceName: name, waiting: new Set([PANES[2].pane_id]) }).map(section => section.status)).toEqual(['working'])
    expect(agentPanes(PANES, new Set([PANES[2].pane_id])).map(pane => pane.pane_id)).toEqual([PANES[1].pane_id])
    expect(shortDuration(3000)).toBe('now')
    expect(shortDuration(8 * 60_000)).toBe('8m')
    expect(shortDuration(90 * 60_000)).toBe('1h')
  })

  it('steps through a tab\'s panes one at a time on a phone', () => {
    expect(phonePane(['a', 'b', 'c'], 'b')).toBe('b')
    expect(phonePane(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(phonePane(['a', 'b'], 'gone')).toBe('a')
    expect(phonePane([], 'a')).toBe('')
  })

  it('finds palette items by every word, labels that start with it first', () => {
    const items = [
      { id: 'chat:1', kind: 'chat' as const, label: 'new landing page' },
      { id: 'action:new-chat', kind: 'action' as const, label: 'New chat' },
      { id: 'space:w1', kind: 'space' as const, label: 'api', detail: 'new things' },
    ]
    expect(paletteMatches(items, 'new').map(item => item.id)).toEqual(['action:new-chat', 'chat:1', 'space:w1'])
    expect(paletteMatches(items, 'land pa').map(item => item.id)).toEqual(['chat:1'])
    expect(isPaletteKey({ key: 'P', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(true)
    expect(isPaletteKey({ key: 'p', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false)
  })

  it('shows the Herdr App layout unless the viewer switched to herdr\'s own UI', () => {
    expect(readViewMode({ getItem: () => null, setItem: () => undefined })).toBe('app')
    expect(readViewMode({ getItem: () => 'tui', setItem: () => undefined })).toBe('tui')
  })
})

describe('the herdr page in the Herdr App layout', () => {
  it('draws the sidebar, the space\'s tabs and each pane as its own terminal, laid out as herdr has them', async () => {
    const wrapper = mountView()
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(api.fetchHerdrSpaceView).toHaveBeenCalledWith('w1')
    expect(wrapper.find('.fake-spaces').attributes('data-variant')).toBe('app')
    expect(wrapper.find('[data-testid="herdr-app-agents"]').text()).toContain('herdrApp.groups.working')
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['1×', 'logs×'])
    // One control stream per pane (not herdr's whole UI), drawn bare inside the pane's frame.
    expect(terminals.map(term => [term.target, term.mode, term.bare])).toEqual([['w1:p1', 'control', true], ['w1:p2', 'control', true]])
    const panes = wrapper.findAll('.hap-pane')
    expect(panes[0].attributes('style')).toContain('width: calc(50% - 4px)')
    expect(panes[1].classes()).toContain('focused')
    expect(panes[0].find('.hap-pane-head').text()).toBe('bash~/code/x')
    expect(wrapper.find('[data-testid="herdr-app-status"]').text()).toContain('herdrApp.agentCount:2')
  })

  it('focuses a pane in herdr when clicked, and switches, closes and opens tabs through herdr', async () => {
    const wrapper = mountView()
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    await wrapper.findAll('.hap-pane')[0].trigger('mousedown')
    expect(api.focusHerdrPane).toHaveBeenCalledWith('w1:p1')
    await wrapper.find('[data-testid="herdr-app-tab-w1:t2"]').trigger('click')
    expect(api.focusHerdrTab).toHaveBeenCalledWith('w1:t2')
    await wrapper.find('[data-testid="herdr-app-tab-close-w1:t2"]').trigger('click')
    expect(api.closeHerdrTab).toHaveBeenCalledWith('w1:t2')
    await wrapper.find('[data-testid="herdr-app-new-tab"]').trigger('click')
    await flushPromises()
    expect(api.createHerdrTab).toHaveBeenCalledWith('w1')
    expect(api.focusHerdrPane).toHaveBeenCalledWith('w1:p9')
  })

  it('maps Files, Changes and Issues to Studio\'s panels, and opens the palette from the status bar', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-testid="herdr-app-files"]').trigger('click')
    await wrapper.find('[data-testid="herdr-app-changes-button"]').trigger('click')
    await wrapper.find('[data-testid="herdr-app-issues"]').trigger('click')
    await wrapper.find('[data-testid="herdr-app-palette-button"]').trigger('click')
    expect(wrapper.emitted('panel')).toEqual([['files'], ['changes'], ['issues']])
    expect(wrapper.emitted('palette')).toHaveLength(1)
  })

  it('hides the sidebar from its brand row and brings it back from the tab bar', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-testid="herdr-app-collapse"]').trigger('click')
    expect(shown(wrapper)).toBe(false)
    expect(localStorage.getItem('studio_herdr_app_sidebar')).toBe('hidden')
    await wrapper.find('[data-testid="herdr-app-expand"]').trigger('click')
    expect(shown(wrapper)).toBe(true)
  })

  it('on a phone: the sidebar is a drawer and one pane shows at a time', async () => {
    const wrapper = mountView({ phone: true })
    await new Promise(resolve => setTimeout(resolve, 120))
    await flushPromises()
    expect(shown(wrapper)).toBe(false)
    expect(wrapper.findAll('.hap-pane').map(pane => pane.attributes('data-testid'))).toEqual(['herdr-app-pane-w1:p2'])
    await wrapper.find('[data-testid="herdr-app-pane-next"]').trigger('click')
    expect(wrapper.findAll('.hap-pane').map(pane => pane.attributes('data-testid'))).toEqual(['herdr-app-pane-w1:p1'])
    expect(wrapper.find('[data-testid="herdr-app-files"]').exists()).toBe(false)
    await wrapper.find('[data-testid="herdr-app-expand"]').trigger('click')
    expect(shown(wrapper)).toBe(true)
    await wrapper.find('[data-testid="herdr-app-backdrop"]').trigger('click')
    expect(shown(wrapper)).toBe(false)
  })
})
