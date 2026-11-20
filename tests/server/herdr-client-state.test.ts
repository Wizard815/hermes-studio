import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientBridgeState, clientPane, createStateFeed } from '../../packages/server/src/modules/coding-agents/services/herdr/client-state'
import type { HerdrBridgeState, HerdrPaneView } from '../../packages/server/src/modules/coding-agents/services/herdr/bridge'

function pane(i: number, extra: Partial<HerdrPaneView> = {}): HerdrPaneView {
  return {
    pane_id: `w${i}:p2`,
    terminal_id: `term_${i}abcdef0123`,
    workspace_id: `w${i}`,
    tab_id: `w${i}:t2`,
    focused: false,
    cwd: `/home/me/code/project-${i}`,
    foreground_cwd: `/home/me/code/project-${i}`,
    label: `Old chat ${i}`,
    agent: 'claude',
    agent_status: 'idle',
    scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 50 },
    revision: 0,
    studioAgent: 'claude-code',
    studioSessionId: `chat-${i}`,
    nativeSessionId: null,
    ...extra,
  } as HerdrPaneView
}

function state(count: number, focused = 'w1:p2'): HerdrBridgeState {
  return {
    connected: true,
    error: '',
    version: '0.9.5',
    focusedPaneId: focused,
    workspaces: Array.from({ length: count }, (_, i) => ({ workspace_id: `w${i}`, number: i + 1, label: `Old chat ${i}`, focused: false, pane_count: 1, tab_count: 1, active_tab_id: `w${i}:t2`, agent_status: 'idle' } as any)),
    panes: Array.from({ length: count }, (_, i) => pane(i)),
    chatSpaces: Array.from({ length: count }, (_, i) => `chat-${i}`),
  }
}

afterEach(() => { vi.useRealTimers() })

describe('herdr state for Studio pages', () => {
  it('keeps the fields pages read and drops the rest', () => {
    const slim = clientPane(pane(3, { foreground_cwd: '/home/me/code/project-3/sub', terminal_title_stripped: 'claude' }))
    expect(slim).toEqual({
      pane_id: 'w3:p2', workspace_id: 'w3', tab_id: 'w3:t2', agent: 'claude', agent_status: 'idle',
      cwd: '/home/me/code/project-3', foreground_cwd: '/home/me/code/project-3/sub', label: 'Old chat 3',
      terminal_title_stripped: 'claude', studioAgent: 'claude-code', studioSessionId: 'chat-3', nativeSessionId: null,
    })
    // The same folder twice is sent once (pages read foreground_cwd || cwd).
    expect(clientPane(pane(1))).not.toHaveProperty('foreground_cwd')
    expect(clientPane(pane(1, { focused: true })).focused).toBe(true)
    expect(clientBridgeState(null)).toBeNull()
  })

  it('makes the state for 360 chats small enough for a slow link', () => {
    const full = JSON.stringify(state(360))
    const slim = clientBridgeState(state(360))!
    expect(slim.panes).toHaveLength(360)
    expect(slim.chatSpaces).toHaveLength(360)
    expect(slim.workspaces[5]).toEqual({ workspace_id: 'w5', label: 'Old chat 5', agent_status: 'idle', pane_count: 1 })
    expect(JSON.stringify(slim).length).toBeLessThan(full.length * 0.7)
  })

  it('gzips once per state, and the zipped state reads back the same', () => {
    let current = state(50)
    const sent: Array<{ json: string; gzip: Buffer }> = []
    const feed = createStateFeed(() => current, encoded => sent.push(encoded))
    const first = feed.current()
    expect(feed.current()).toBe(first)
    expect(JSON.parse(gunzipSync(first.gzip).toString('utf8'))).toEqual(first.state)
    // The page's state, plus when each pane's agent took its status (the Agents list's time in state).
    const { panes: timed, ...rest } = first.state!
    expect(timed.every(pane => typeof pane.status_since === 'number')).toBe(true)
    expect({ ...rest, panes: timed.map(({ status_since: _since, ...pane }) => pane) }).toEqual(clientBridgeState(current))
    expect(first.gzip.length).toBeLessThan(first.json.length / 4)
    current = state(50, 'w2:p2')
    expect(feed.current()).not.toBe(first)
  })

  it('sends the first change at once, coalesces bursts and drops repeats', () => {
    vi.useFakeTimers()
    let current = state(3)
    const sent: string[] = []
    const feed = createStateFeed(() => current, encoded => sent.push(encoded.state!.focusedPaneId!), 150)
    feed.changed()
    expect(sent).toEqual(['w1:p2'])
    current = state(3, 'w2:p2')
    feed.changed()
    current = state(3, 'w0:p2')
    feed.changed()
    expect(sent).toEqual(['w1:p2'])
    vi.advanceTimersByTime(150)
    expect(sent).toEqual(['w1:p2', 'w0:p2'])
    // Nothing new: nothing sent.
    vi.advanceTimersByTime(1000)
    feed.changed()
    vi.advanceTimersByTime(1000)
    expect(sent).toEqual(['w1:p2', 'w0:p2'])
    feed.stop()
  })
})
