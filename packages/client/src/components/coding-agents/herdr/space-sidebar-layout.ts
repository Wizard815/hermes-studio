import { computed, ref, watch, type Ref } from 'vue'

/**
 * The herdr page's left column: Studio's Spaces sidebar (space folders) or
 * herdr's own sidebar, per viewer. On wide screens Studio's sidebar sits
 * beside the terminal and can be hidden; on phones it is a drawer that slides
 * over (closed until opened).
 */
export type SidebarMode = 'studio' | 'herdr'

export const SIDEBAR_STORAGE_KEY = 'studio_herdr_spaces'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function storage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export interface SidebarPrefs { mode: SidebarMode; open: boolean }
export const DEFAULT_SIDEBAR: SidebarPrefs = { mode: 'studio', open: true }

export function readSidebarPrefs(store: StorageLike | null = storage()): SidebarPrefs {
  try {
    const raw = store?.getItem(SIDEBAR_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SIDEBAR }
    const value = JSON.parse(raw) as Partial<SidebarPrefs>
    return {
      mode: value.mode === 'herdr' ? 'herdr' : 'studio',
      open: typeof value.open === 'boolean' ? value.open : DEFAULT_SIDEBAR.open,
    }
  } catch {
    return { ...DEFAULT_SIDEBAR }
  }
}

export function writeSidebarPrefs(prefs: SidebarPrefs, store: StorageLike | null = storage()): void {
  try { store?.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(prefs)) } catch { /* private mode */ }
}

export function useSpaceSidebar(phone: Ref<boolean>, store: StorageLike | null = storage()) {
  const saved = readSidebarPrefs(store)
  const mode = ref<SidebarMode>(saved.mode)
  const wideOpen = ref(saved.open)
  const drawerOpen = ref(false)
  /** Studio's sidebar shows (beside the terminal, or as the open drawer). */
  const open = computed(() => mode.value === 'studio' && (phone.value ? drawerOpen.value : wideOpen.value))
  function setOpen(value: boolean) {
    if (phone.value) drawerOpen.value = value
    else wideOpen.value = value
  }
  function toggle() {
    if (mode.value !== 'studio') { mode.value = 'studio'; setOpen(true); return }
    setOpen(!open.value)
  }
  function setMode(next: SidebarMode) {
    mode.value = next
    if (next === 'studio') setOpen(!phone.value || drawerOpen.value)
    else drawerOpen.value = false
  }
  /** After picking a chat in the drawer, the terminal comes back (phones). */
  function picked() { if (phone.value) drawerOpen.value = false }
  watch(phone, value => { if (!value) drawerOpen.value = false })
  watch([mode, wideOpen], () => writeSidebarPrefs({ mode: mode.value, open: wideOpen.value }, store))
  return { mode, open, setOpen, toggle, setMode, picked }
}
