import { describe, expect, it } from 'vitest'
import { stripTerminalQueries } from '../../packages/server/src/modules/hermes/services/terminal/replay-scrub'

// Replayed scrollback must not contain terminal queries: xterm.js answers them
// on every reopen, and the stale replies get typed into the shell prompt as
// "1;2c0;276;0c". Everything that paints — text, colors, cursor moves — must
// survive untouched.
describe('stripTerminalQueries', () => {
  it('strips the DA1/DA2 attach handshake tmux sends, keeping surrounding text', () => {
    const replay = 'before\x1b[c\x1b[>c\x1b[0c\x1b[>0cafter'
    expect(stripTerminalQueries(replay)).toBe('beforeafter')
  })

  it('strips status reports, XTVERSION, kitty and DECRQM probes', () => {
    const replay = 'a\x1b[5n b\x1b[6n c\x1b[?6n d\x1b[>q e\x1b[?u f\x1b[?2026$p g'
    expect(stripTerminalQueries(replay)).toBe('a b c d e f g')
  })

  it('strips XTGETTCAP and DECRQSS string queries through their terminator', () => {
    const replay = 'x\x1bP+q544e;436f\x1b\\y\x1bP$qm\x07z'
    expect(stripTerminalQueries(replay)).toBe('xyz')
  })

  it('strips OSC color probes but keeps ordinary OSC output like titles', () => {
    const replay = '\x1b]0;my title\x07ls\x1b]10;?\x07\x1b]11;?\x1b\\done'
    expect(stripTerminalQueries(replay)).toBe('\x1b]0;my title\x07lsdone')
  })

  it('leaves painting sequences alone: colors, cursor moves, clears', () => {
    const replay = '\x1b[1;32muser@host\x1b[00m:\x1b[5C$ \x1b[2J\x1b[Hprompt'
    expect(stripTerminalQueries(replay)).toBe(replay)
  })

  it('passes plain text through unchanged', () => {
    expect(stripTerminalQueries('just some output\r\n')).toBe('just some output\r\n')
    expect(stripTerminalQueries('')).toBe('')
  })
})
