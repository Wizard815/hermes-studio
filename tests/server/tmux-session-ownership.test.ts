import { describe, expect, it } from 'vitest'
import { isSessionForChat, tmuxSessionName } from '../../packages/server/src/modules/hermes/services/terminal/tmux-sessions'

describe('tmux session ownership', () => {
  it('matches only the exact chat id plus a numeric terminal index', () => {
    expect(isSessionForChat(tmuxSessionName('a', 0), 'a')).toBe(true)
    expect(isSessionForChat(tmuxSessionName('a_b', 1), 'a')).toBe(false)
    expect(isSessionForChat(tmuxSessionName('a', 12), 'a_b')).toBe(false)
  })
})
