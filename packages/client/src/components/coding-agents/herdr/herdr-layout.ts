import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/**
 * The combined herdr page: herdr's own UI (its spaces sidebar and the focused
 * pane) with Mission's tools docked on the right. This is the dock's state.
 */

/** Command Center's tabs (first row), then Mission's (second row). */
export const COMMAND_TABS = ['inbox', 'agents', 'files', 'board', 'skills'] as const
export const MISSION_TABS = ['chats', 'tasks', 'projects', 'ideas', 'upkeep', 'control'] as const
export const DOCK_TABS = [...COMMAND_TABS, ...MISSION_TABS] as const
export type DockTab = typeof DOCK_TABS[number]

export function isCommandTab(tab: DockTab): boolean {
  return (COMMAND_TABS as readonly string[]).includes(tab)
}

/** The tab's label key: Command Center's own, or Mission's source names. */
export function dockTabLabelKey(tab: DockTab): string {
  return isCommandTab(tab) ? `commandCenter.tabs.${tab}` : `mission.sources.${tab}`
}

/** Tabs that need Pondering Orb (Chats and Control work without it). */
export const ORB_TABS: ReadonlySet<DockTab> = new Set<DockTab>(['tasks', 'projects', 'ideas', 'upkeep'])

/** At or below this width the dock (and herdr's sidebar, in herdr's own phone layout) slide over the terminal. */
export const PHONE_MAX_WIDTH = 640

export const DOCK_STORAGE_KEY = 'studio_herdr_dock'
/** Mission's own keys, read once so a viewer's last Mission tab carries over. */
const MISSION_SOURCE_KEY = 'herdr_mission_source'

export interface DockPrefs {
  /** Open beside the terminal (wide screens; phones always start closed). */
  open: boolean
  tab: DockTab
}

export const DEFAULT_DOCK: DockPrefs = { open: true, tab: 'chats' }

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function storage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function isDockTab(value: unknown): value is DockTab {
  return typeof value === 'string' && (DOCK_TABS as readonly string[]).includes(value)
}

/**
 * Arrow keys in the tab list (one list over both rows): Left/Right move one
 * tab and wrap, Home/End go to the ends. Other keys: null.
 */
export function nextDockTab(current: DockTab, key: string): DockTab | null {
  const index = DOCK_TABS.indexOf(current)
  const last = DOCK_TABS.length - 1
  if (key === 'ArrowRight' || key === 'ArrowDown') return DOCK_TABS[index >= last ? 0 : index + 1]
  if (key === 'ArrowLeft' || key === 'ArrowUp') return DOCK_TABS[index <= 0 ? last : index - 1]
  if (key === 'Home') return DOCK_TABS[0]
  if (key === 'End') return DOCK_TABS[last]
  return null
}

/** This viewer's dock, from browser storage (any failure: the defaults). */
export function readDockPrefs(store: StorageLike | null = storage()): DockPrefs {
  try {
    const raw = store?.getItem(DOCK_STORAGE_KEY)
    if (raw) {
      const value = JSON.parse(raw) as Partial<DockPrefs>
      return {
        open: typeof value.open === 'boolean' ? value.open : DEFAULT_DOCK.open,
        tab: isDockTab(value.tab) ? value.tab : DEFAULT_DOCK.tab,
      }
    }
    const missionTab = store?.getItem(MISSION_SOURCE_KEY)
    return { ...DEFAULT_DOCK, tab: isDockTab(missionTab) ? missionTab : DEFAULT_DOCK.tab }
  } catch {
    return { ...DEFAULT_DOCK }
  }
}

export function writeDockPrefs(prefs: DockPrefs, store: StorageLike | null = storage()): void {
  try { store?.setItem(DOCK_STORAGE_KEY, JSON.stringify({ open: prefs.open, tab: prefs.tab })) } catch { /* private mode */ }
}

export function isPhoneWidth(width: number): boolean {
  return width > 0 && width <= PHONE_MAX_WIDTH
}

/**
 * Dock state for one view. On wide screens the dock sits beside the terminal
 * and its open/closed state is remembered; on phones it is a drawer that
 * starts closed (opening it there does not change the wide-screen choice).
 */
export function useHerdrDock(options: { width?: Ref<number>; store?: StorageLike | null } = {}) {
  const store = options.store === undefined ? storage() : options.store
  const saved = readDockPrefs(store)
  const width = options.width ?? useWindowWidth()
  const phone = computed(() => isPhoneWidth(width.value))
  const wideOpen = ref(saved.open)
  const drawerOpen = ref(false)
  const tab = ref<DockTab>(saved.tab)

  const open = computed(() => (phone.value ? drawerOpen.value : wideOpen.value))
  function setOpen(value: boolean) {
    if (phone.value) drawerOpen.value = value
    else wideOpen.value = value
  }
  function toggle() { setOpen(!open.value) }
  function show(next: DockTab) {
    tab.value = next
    setOpen(true)
  }
  /** After picking something in the drawer, the terminal comes back (phones). */
  function picked() {
    if (phone.value) drawerOpen.value = false
  }
  // Leaving the phone layout closes the drawer.
  watch(phone, value => { if (!value) drawerOpen.value = false })
  watch([wideOpen, tab], () => writeDockPrefs({ open: wideOpen.value, tab: tab.value }, store))

  return { phone, open, tab, setOpen, toggle, show, picked }
}

function useWindowWidth(): Ref<number> {
  const width = ref(typeof window === 'undefined' ? 1024 : window.innerWidth)
  const update = () => { width.value = window.innerWidth }
  onMounted(() => { update(); window.addEventListener('resize', update) })
  onBeforeUnmount(() => window.removeEventListener('resize', update))
  return width
}
