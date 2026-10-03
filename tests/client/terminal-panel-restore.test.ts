import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = () => readFileSync('packages/client/src/components/hermes/chat/TerminalPanel.vue', 'utf8')

describe('TerminalPanel reconnect handling', () => {
  it('keeps the session the user is viewing and only falls back when it is gone', () => {
    const src = source()
    const restored = src.slice(src.indexOf('case "restored"'), src.indexOf('case "error"'))

    // The keep-selection logic must prefer the locally active session, then the
    // server's suggestion, and only then the first tab.
    expect(restored).toContain('activeSessionId.value && sessions.value.some')
    expect(restored).toContain('msg.activeSessionId && sessions.value.some')
    expect(restored).toContain('sessions.value[0]?.id')
    // Switching unconditionally is what snapped the user back to bash #1.
    expect(restored).not.toMatch(/switchSession\(msg\.activeSessionId\)/)
  })

  it('does not tear down xterm instances when the session set is unchanged', () => {
    const src = source()
    const restored = src.slice(src.indexOf('case "restored"'), src.indexOf('case "error"'))

    // Disposing on every reconnect was the black-flash/blank-repaint bug.
    expect(restored).toContain('const sameSet')
    expect(restored).toMatch(/if \(!sameSet\) \{[\s\S]*entry\.term\.dispose\(\)/)
    // The dispose loop must sit inside the guard, not at the top level.
    const beforeGuard = restored.slice(0, restored.indexOf('if (!sameSet)'))
    expect(beforeGuard).not.toContain('.term.dispose()')
  })

  it('handles the server heartbeat frame without treating it as terminal output', () => {
    const src = source()
    expect(src).toMatch(/case "ping":/)
  })
})
