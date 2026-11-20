import { gzipSync } from 'node:zlib'
import type { HerdrBridgeState, HerdrPaneView } from './bridge'

/**
 * herdr's state as Studio's pages get it. With hundreds of chats (every chat
 * is a herdr space) the bridge state is a few hundred kB, and Studio sent all
 * of it, uncompressed, on every herdr change and to every new herdr view, on
 * the same socket as the herdr terminal. On a tunnel that held back the
 * terminal's first screen for seconds. Pages get only the fields they read,
 * changes are coalesced, and pages that can unzip get it gzipped.
 */

/** The pane fields Studio's pages read (see the client's HerdrPaneView). */
export function clientPane(pane: HerdrPaneView): HerdrPaneView {
  const out: HerdrPaneView = {
    pane_id: pane.pane_id,
    workspace_id: pane.workspace_id,
    studioAgent: pane.studioAgent ?? null,
    studioSessionId: pane.studioSessionId ?? null,
    nativeSessionId: pane.nativeSessionId ?? null,
  }
  if (pane.tab_id) out.tab_id = pane.tab_id
  if (pane.agent) out.agent = pane.agent
  if (pane.agent_status) out.agent_status = pane.agent_status
  if (pane.cwd) out.cwd = pane.cwd
  if (pane.foreground_cwd && pane.foreground_cwd !== pane.cwd) out.foreground_cwd = pane.foreground_cwd
  if (pane.focused) out.focused = true
  if (pane.label) out.label = pane.label
  if (pane.terminal_title_stripped && pane.terminal_title_stripped !== pane.label) out.terminal_title_stripped = pane.terminal_title_stripped
  if (pane.status_since) out.status_since = pane.status_since
  return out
}

/**
 * When each pane's agent took its status, for the Agents list's "time in
 * state" (8m, 1h). herdr does not say, so Studio notes when it first sees a
 * status; panes that are gone are forgotten.
 */
export function createStatusClock(now: () => number = Date.now) {
  const seen = new Map<string, { status: string; since: number }>()
  return (panes: HerdrPaneView[]): HerdrPaneView[] => {
    const live = new Set<string>()
    const out = panes.map(pane => {
      live.add(pane.pane_id)
      const status = pane.agent_status || 'unknown'
      let entry = seen.get(pane.pane_id)
      if (!entry || entry.status !== status) {
        entry = { status, since: now() }
        seen.set(pane.pane_id, entry)
      }
      return { ...pane, status_since: entry.since }
    })
    for (const id of seen.keys()) if (!live.has(id)) seen.delete(id)
    return out
  }
}

/** The bridge state with only what Studio's pages read (with `clock`, each pane's time in state). */
export function clientBridgeState(state: HerdrBridgeState | null, clock?: (panes: HerdrPaneView[]) => HerdrPaneView[]): HerdrBridgeState | null {
  if (!state) return null
  return {
    connected: state.connected,
    error: state.error,
    version: state.version,
    focusedPaneId: state.focusedPaneId,
    workspaces: state.workspaces.map(item => ({
      workspace_id: item.workspace_id,
      ...(item.label ? { label: item.label } : {}),
      ...(item.agent_status ? { agent_status: item.agent_status } : {}),
      ...(item.focused ? { focused: true } : {}),
      ...(item.pane_count != null ? { pane_count: item.pane_count } : {}),
    })),
    panes: (clock ? clock(state.panes) : state.panes).map(clientPane),
    chatSpaces: state.chatSpaces,
  }
}

export interface EncodedState {
  state: HerdrBridgeState | null
  json: string
  gzip: Buffer
}

/**
 * Coalesces bridge changes: the first change goes out at once, later ones at
 * most every `intervalMs`, and a state equal to the last one sent is dropped.
 * `send` gets the encoded state (encoded once for every viewer).
 */
export function createStateFeed(read: () => HerdrBridgeState | null, send: (state: EncodedState) => void, intervalMs = 150) {
  let last = ''
  let lastAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let current: EncodedState | null = null
  const clock = createStatusClock()

  function encoded(): EncodedState {
    const state = clientBridgeState(read(), clock)
    const json = JSON.stringify(state)
    if (!current || current.json !== json) current = { state, json, gzip: gzipSync(json, { level: 6 }) }
    return current
  }

  function flush() {
    timer = null
    const next = encoded()
    lastAt = Date.now()
    if (next.json === last) return
    last = next.json
    send(next)
  }

  return {
    /** The state now, for a viewer that just connected. */
    current: encoded,
    changed() {
      if (timer) return
      const wait = Math.max(0, lastAt + intervalMs - Date.now())
      if (wait === 0) flush()
      else timer = setTimeout(flush, wait)
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
