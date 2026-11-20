// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import {
  DEFAULT_DOCK,
  DOCK_STORAGE_KEY,
  isPhoneWidth,
  readDockPrefs,
  useHerdrDock,
  writeDockPrefs,
} from '@/components/coding-agents/herdr/herdr-layout'
import { herdrPageHash, missionRedirect } from '@/utils/herdr-page-url'

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

const throwing = {
  getItem: () => { throw new Error('blocked') },
  setItem: () => { throw new Error('blocked') },
}

describe('herdr page dock preferences', () => {
  it('defaults to an open dock on Chats', () => {
    expect(readDockPrefs(memoryStore())).toEqual(DEFAULT_DOCK)
    expect(DEFAULT_DOCK).toEqual({ open: true, tab: 'chats' })
  })

  it('reads and writes the open state and last tab', () => {
    const store = memoryStore()
    writeDockPrefs({ open: false, tab: 'upkeep' }, store)
    expect(JSON.parse(store.data.get(DOCK_STORAGE_KEY)!)).toEqual({ open: false, tab: 'upkeep' })
    expect(readDockPrefs(store)).toEqual({ open: false, tab: 'upkeep' })
  })

  it('ignores broken or unknown values', () => {
    expect(readDockPrefs(memoryStore({ [DOCK_STORAGE_KEY]: '{not json' }))).toEqual(DEFAULT_DOCK)
    expect(readDockPrefs(memoryStore({ [DOCK_STORAGE_KEY]: JSON.stringify({ open: 'yes', tab: 'nope' }) }))).toEqual(DEFAULT_DOCK)
  })

  it('carries over the last Mission tab once', () => {
    expect(readDockPrefs(memoryStore({ herdr_mission_source: 'ideas' }))).toEqual({ open: true, tab: 'ideas' })
    expect(readDockPrefs(memoryStore({ herdr_mission_source: 'ideas', [DOCK_STORAGE_KEY]: JSON.stringify({ open: true, tab: 'tasks' }) })).tab).toBe('tasks')
  })

  it('works when browser storage throws (private mode)', () => {
    expect(readDockPrefs(throwing)).toEqual(DEFAULT_DOCK)
    expect(() => writeDockPrefs({ open: false, tab: 'chats' }, throwing)).not.toThrow()
    expect(readDockPrefs(null)).toEqual(DEFAULT_DOCK)
  })
})

describe('herdr page layout', () => {
  it('is the phone layout at 640px and below', () => {
    expect(isPhoneWidth(390)).toBe(true)
    expect(isPhoneWidth(640)).toBe(true)
    expect(isPhoneWidth(641)).toBe(false)
    expect(isPhoneWidth(1440)).toBe(false)
    expect(isPhoneWidth(0)).toBe(false)
  })

  it('keeps the dock beside the terminal on wide screens and remembers it', async () => {
    const store = memoryStore()
    const width = ref(1440)
    const dock = useHerdrDock({ width, store })
    expect(dock.phone.value).toBe(false)
    expect(dock.open.value).toBe(true)
    dock.toggle()
    dock.show('projects')
    await nextTick()
    expect(dock.open.value).toBe(true)
    expect(dock.tab.value).toBe('projects')
    dock.setOpen(false)
    await nextTick()
    expect(JSON.parse(store.data.get(DOCK_STORAGE_KEY)!)).toEqual({ open: false, tab: 'projects' })
    // Picking something keeps the dock beside the terminal.
    dock.setOpen(true)
    dock.picked()
    expect(dock.open.value).toBe(true)
  })

  it('makes the dock a drawer on phones that starts closed and closes after a pick', async () => {
    const store = memoryStore({ [DOCK_STORAGE_KEY]: JSON.stringify({ open: true, tab: 'tasks' }) })
    const width = ref(390)
    const dock = useHerdrDock({ width, store })
    expect(dock.phone.value).toBe(true)
    expect(dock.open.value).toBe(false)
    expect(dock.tab.value).toBe('tasks')
    dock.toggle()
    expect(dock.open.value).toBe(true)
    dock.picked()
    expect(dock.open.value).toBe(false)
    // The drawer does not change the wide-screen choice.
    dock.setOpen(true)
    await nextTick()
    expect(JSON.parse(store.data.get(DOCK_STORAGE_KEY)!).open).toBe(true)
  })

  it('closes the drawer when the screen widens, and the wide dock comes back', async () => {
    const store = memoryStore({ [DOCK_STORAGE_KEY]: JSON.stringify({ open: false, tab: 'chats' }) })
    const width = ref(390)
    const dock = useHerdrDock({ width, store })
    dock.setOpen(true)
    width.value = 1200
    await nextTick()
    expect(dock.phone.value).toBe(false)
    expect(dock.open.value).toBe(false)
    width.value = 390
    await nextTick()
    expect(dock.open.value).toBe(false)
  })
})

describe('herdr page links', () => {
  it('opens Studio in herdr mode on a pane', () => {
    expect(herdrPageHash()).toBe('#/hermes/chat?center=herdr')
    expect(herdrPageHash({ pane: 'w1:p2' })).toBe('#/hermes/chat?center=herdr&pane=w1%3Ap2')
    expect(herdrPageHash({ pane: 'w1:p2', session: 'chat 1' })).toBe('#/hermes/session/chat%201?center=herdr&pane=w1%3Ap2')
  })

  it('sends old Mission links to the herdr page on the same pane', () => {
    expect(missionRedirect('?pane=w4:p1')).toBe('/index.html#/hermes/chat?center=herdr&pane=w4%3Ap1')
    expect(missionRedirect('')).toBe('/index.html#/hermes/chat?center=herdr')
    expect(missionRedirect('?pane=w4:p1', '/studio')).toBe('/studio/index.html#/hermes/chat?center=herdr&pane=w4%3Ap1')
  })
})
