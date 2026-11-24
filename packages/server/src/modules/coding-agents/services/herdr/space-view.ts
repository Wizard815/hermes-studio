/**
 * One herdr space as Studio's Herdr App layout draws it: the space's tabs
 * (herdr's tab bar), the active tab's panes with where herdr lays them out
 * (splits), and what runs in each pane (its header: "bash ~/path"). Studio
 * draws each pane as its own terminal (`herdr terminal session control`), so
 * this is what Herdr App's `tabs` and `pane` mods show, read from herdr's
 * socket API (`tab.list`, `pane.layout`, `pane.process_info`).
 */

export interface SpaceViewTab {
  tab_id: string
  label: string
  number: number
  focused: boolean
  agent_status: string
  pane_count: number
}

export interface SpaceViewRect { x: number; y: number; width: number; height: number }

export interface SpaceViewPane {
  pane_id: string
  focused: boolean
  /** Where herdr puts the pane, as fractions (0..1) of the tab's area. */
  rect: SpaceViewRect
  /** The pane's foreground program ("bash", "claude"), if herdr said. */
  process: string
}

export interface SpaceView {
  workspaceId: string
  tabs: SpaceViewTab[]
  activeTabId: string
  focusedPaneId: string
  zoomed: boolean
  panes: SpaceViewPane[]
}

type Call = <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>

const num = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** herdr's `tab.list` result, in herdr's order. */
export function normalizeTabs(raw: any): SpaceViewTab[] {
  const list = Array.isArray(raw?.tabs) ? raw.tabs : []
  return list
    .filter((tab: any) => typeof tab?.tab_id === 'string')
    .map((tab: any) => ({
      tab_id: tab.tab_id,
      label: typeof tab.label === 'string' && tab.label ? tab.label : String(num(tab.number, 1)),
      number: num(tab.number, 1),
      focused: tab.focused === true,
      agent_status: typeof tab.agent_status === 'string' ? tab.agent_status : 'unknown',
      pane_count: num(tab.pane_count, 1),
    }))
}

/**
 * herdr's `pane.layout` result: pane rects in cells, made fractions of the
 * tab's area so the page can lay them out at any size. A zoomed tab shows
 * only its focused pane, full size (as herdr does).
 */
export function normalizeLayout(raw: any): { panes: Array<Omit<SpaceViewPane, 'process'>>; focusedPaneId: string; zoomed: boolean; tabId: string } {
  const layout = raw?.layout ?? raw ?? {}
  const area = layout.area ?? {}
  const width = Math.max(1, num(area.width, 1))
  const height = Math.max(1, num(area.height, 1))
  const ax = num(area.x)
  const ay = num(area.y)
  const zoomed = layout.zoomed === true
  const focusedPaneId = typeof layout.focused_pane_id === 'string' ? layout.focused_pane_id : ''
  let panes = (Array.isArray(layout.panes) ? layout.panes : [])
    .filter((pane: any) => typeof pane?.pane_id === 'string')
    .map((pane: any) => {
      const rect = pane.rect ?? {}
      const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000
      return {
        pane_id: pane.pane_id as string,
        focused: pane.focused === true || pane.pane_id === focusedPaneId,
        rect: {
          x: round((num(rect.x) - ax) / width),
          y: round((num(rect.y) - ay) / height),
          width: round(num(rect.width, width) / width),
          height: round(num(rect.height, height) / height),
        },
      }
    })
  if (zoomed && focusedPaneId) {
    panes = panes.filter((pane: { pane_id: string }) => pane.pane_id === focusedPaneId)
      .map((pane: any) => ({ ...pane, rect: { x: 0, y: 0, width: 1, height: 1 } }))
  }
  return { panes, focusedPaneId, zoomed, tabId: typeof layout.tab_id === 'string' ? layout.tab_id : '' }
}

/** The foreground program's name from `pane.process_info` ('' if unknown). */
export function processName(raw: any): string {
  const info = raw?.process_info ?? raw ?? {}
  const list = Array.isArray(info.foreground_processes) ? info.foreground_processes : []
  const first = list.find((item: any) => typeof item?.name === 'string' && item.name) ?? null
  return first ? String(first.name).slice(0, 40) : ''
}

/**
 * The space's tabs, and its active tab's panes. `paneOf(tabId)` names a pane
 * in a tab (from Studio's herdr state) for `pane.layout`, which takes a pane.
 */
export async function readSpaceView(call: Call, workspaceId: string, paneOf: (tabId: string) => string): Promise<SpaceView> {
  const tabs = normalizeTabs(await call('tab.list', { workspace_id: workspaceId }))
  const active = tabs.find(tab => tab.focused) ?? tabs[0]
  const view: SpaceView = { workspaceId, tabs, activeTabId: active?.tab_id || '', focusedPaneId: '', zoomed: false, panes: [] }
  if (!active) return view
  let anchor = paneOf(active.tab_id)
  if (!anchor) {
    const listed = await call<any>('pane.list', { workspace_id: workspaceId }).catch(() => null)
    const panes = Array.isArray(listed?.panes) ? listed.panes : []
    anchor = String(panes.find((pane: any) => pane?.tab_id === active.tab_id)?.pane_id || '')
  }
  if (!anchor) return view
  const layout = normalizeLayout(await call('pane.layout', { pane_id: anchor }))
  view.focusedPaneId = layout.focusedPaneId
  view.zoomed = layout.zoomed
  view.panes = await Promise.all(layout.panes.map(async pane => ({
    ...pane,
    process: processName(await call('pane.process_info', { pane_id: pane.pane_id }).catch(() => null)),
  })))
  return view
}
