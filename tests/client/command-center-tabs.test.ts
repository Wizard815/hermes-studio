// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'

const herdr = reactive<any>({
  bridge: {
    connected: true,
    focusedPaneId: 'w1:p1',
    panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', studioAgent: 'claude-code', studioSessionId: 'c1', nativeSessionId: null, foreground_cwd: '/code/app' }],
  },
})
const sessionStates = reactive<any>({
  connected: true,
  sessions: new Map([['c1', {}], ['c2', {}]]),
  start: vi.fn(),
  onListChanged: vi.fn(() => () => undefined),
  statusOf: (id: string) => (id === 'c1' ? 'blocked' : 'done'),
  herdrLink: (id: string) => (id === 'c1' ? { paneId: 'w1:p1' } : undefined),
})
const api = vi.hoisted(() => ({
  fetchAgentWork: vi.fn(async () => ({ work: [{ id: 'w1', title: 'Ship it', status: 'awaiting_approval', agent: 'codex', sessionId: '', summary: 'ready to ship', updatedAt: 10 }] })),
  decideAgentWork: vi.fn(async () => ({ changed: true })),
  listJobs: vi.fn(async () => []),
  fetchSessions: vi.fn(async () => [{ id: 'c1', title: 'Fix login', agent: 'claude-code', source: 'coding_agent' }, { id: 'c2', title: 'Docs', agent: 'codex', source: 'coding_agent' }]),
  fetchGithubInbox: vi.fn(async () => ({ enabled: true, available: true, signedIn: false, repos: [], items: [], checkedAt: 0, error: 'not logged in' })),
  fetchPlanLimits: vi.fn(async () => ({ limits: [] })),
  fetchSkillshare: vi.fn(),
  syncSkillshare: vi.fn(async () => ({ ok: true, message: 'Synced every target' })),
  fetchSkills: vi.fn(async () => ({ categories: [{ name: 'x', description: '', skills: [{ name: 'a', description: '' }, { name: 'b', description: '', enabled: false }] }], archived: [] })),
}))
const dialog = vi.hoisted(() => ({ warning: vi.fn() }))

vi.mock('naive-ui', async importOriginal => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
  useDialog: () => dialog,
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }) }))
vi.mock('@/stores/hermes/herdr', () => ({ useHerdrStore: () => herdr }))
vi.mock('@/stores/hermes/session-state', () => ({ useSessionStateStore: () => sessionStates }))
vi.mock('@/api/studio/agent-work', () => ({ fetchAgentWork: api.fetchAgentWork, decideAgentWork: api.decideAgentWork }))
vi.mock('@/api/hermes/jobs', () => ({ listJobs: api.listJobs }))
vi.mock('@/api/studio/sessions', () => ({ fetchSessions: api.fetchSessions }))
vi.mock('@/api/hermes/skills', () => ({ fetchSkills: api.fetchSkills }))
vi.mock('@/api/studio/command-center', () => ({
  fetchGithubInbox: api.fetchGithubInbox,
  fetchPlanLimits: api.fetchPlanLimits,
  fetchSkillshare: api.fetchSkillshare,
  syncSkillshare: api.syncSkillshare,
  checkSkillshare: vi.fn(),
  updateSkillshare: vi.fn(),
  installSkillshare: vi.fn(),
  fetchCommandCenterSettings: vi.fn(),
  saveCommandCenterSettings: vi.fn(),
}))

import CommandInbox from '@/mission/command-center/CommandInbox.vue'
import CommandSkills from '@/mission/command-center/CommandSkills.vue'
import { resetCommandCenter, useCommandCenter } from '@/mission/command-center/useCommandCenter'

beforeEach(() => {
  localStorage.clear()
  resetCommandCenter()
  vi.clearAllMocks()
})

describe('Command Center Inbox tab', () => {
  it('shows what needs the user, approves inline, jumps to a pane and marks things seen', async () => {
    const cc = useCommandCenter()
    cc.acquire()
    const wrapper = mount(CommandInbox)
    await flushPromises()
    expect(wrapper.findAll('[data-testid^="cc-inbox-item-"]').map(item => item.attributes('data-testid'))).toEqual([
      'cc-inbox-item-approval', 'cc-inbox-item-blocked', 'cc-inbox-item-done',
    ])
    expect(cc.unseen.value).toBe(3)
    expect(wrapper.find('[data-testid="cc-inbox-github"]').text()).toBe('commandCenter.inbox.githubSignedOut')

    await wrapper.find('[data-testid="cc-inbox-approve"]').trigger('click')
    await flushPromises()
    expect(api.decideAgentWork).toHaveBeenCalledWith('w1', 'approve')

    await wrapper.find('[data-testid="cc-inbox-item-blocked"] .cc-title').trigger('click')
    expect(wrapper.emitted('select-pane')?.[0]).toEqual(['w1:p1'])

    await wrapper.find('[data-testid="cc-inbox-seen-all"]').trigger('click')
    expect(cc.unseen.value).toBe(0)
    expect(wrapper.find('[data-testid="cc-inbox-empty"]').exists()).toBe(true)
    expect(JSON.parse(localStorage.getItem('studio_herdr_inbox_seen_v1')!)).toHaveProperty('blocked:chat:c1')
    await wrapper.find('[data-testid="cc-inbox-show-seen"]').trigger('click')
    expect(wrapper.findAll('[data-testid^="cc-inbox-item-"]').length).toBe(3)
    cc.release()
  })
})

describe('Command Center Skills tab', () => {
  it('explains how to install skillshare when the server has none', async () => {
    api.fetchSkillshare.mockResolvedValueOnce({ installed: false, targets: [], kinds: [], items: [], checked: false, checkedAt: 0 })
    const wrapper = mount(CommandSkills)
    await flushPromises()
    expect(wrapper.find('[data-testid="cc-skills-missing"]').text()).toContain('install.sh')
    expect(wrapper.text()).toContain('commandCenter.skills.hermes {"n":2,"enabled":1}')
  })

  it('shows the overview and syncs only after the confirmation', async () => {
    api.fetchSkillshare.mockResolvedValue({
      installed: true, version: '1.0.0', source: '/s',
      targets: [{ name: 'claude', path: '/c', waiting: 1 }, { name: 'codex', path: '/x', waiting: 0 }],
      kinds: [{ kind: 'skills', total: 2, needsSync: 1, updates: 0 }],
      items: [{ key: 'skills:a', kind: 'skills', name: 'a', state: 'missing', source: 'local', targets: ['claude'] }, { key: 'skills:b', kind: 'skills', name: 'b', state: 'ok', source: 'local', targets: [] }],
      checked: false, checkedAt: 0,
    })
    const wrapper = mount(CommandSkills)
    await flushPromises()
    expect(wrapper.find('[data-testid="cc-skills-headline"]').text()).toContain('commandCenter.skills.targetsWaiting {"n":1}')
    await wrapper.find('[data-testid="cc-skills-sync"]').trigger('click')
    expect(api.syncSkillshare).not.toHaveBeenCalled()
    expect(dialog.warning).toHaveBeenCalledTimes(1)
    await dialog.warning.mock.calls[0][0].onPositiveClick()
    expect(api.syncSkillshare).toHaveBeenCalledTimes(1)
  })
})
