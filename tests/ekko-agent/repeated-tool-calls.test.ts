import { describe, expect, it } from 'vitest'
import { AgentRuntime } from '../../packages/ekko-agent/src/index'

type Guard = (runId: string, call: { id: string; name: string; arguments: Record<string, unknown> }) => string | null

function guard(): Guard {
  const host = { repeatedToolCalls: new Map() }
  return (runId, call) => (AgentRuntime.prototype as any).noteRepeatedToolCall.call(host, runId, call)
}

const read = (offset: number, extra: Record<string, unknown> = {}) =>
  ({ id: `c${offset}`, name: 'read_file', arguments: { path: 'a.py', limit: 100, offset, ...extra } })

describe('repeated paged tool calls', () => {
  it('stops a read_file loop that only advances offset', () => {
    const check = guard()
    let blockedAt = 0
    for (let i = 0; i < 40 && !blockedAt; i++) if (check('run', read(i * 100))) blockedAt = i + 1
    expect(blockedAt).toBe(13)
  })

  it('does not count calls that differ in more than the offset, or other tools between them', () => {
    const check = guard()
    for (let i = 0; i < 30; i++) {
      expect(check('run', read(i * 100, { path: `f${i}.py` }))).toBeNull()
    }
    for (let i = 0; i < 30; i++) {
      expect(check('run', read(i * 100))).toBeNull() // interleaved with another tool
      expect(check('run', { id: 'x', name: 'search_files', arguments: { pattern: 'x' } })).toBeNull()
    }
  })

  it('ignores polling tools without an offset argument', () => {
    const check = guard()
    for (let i = 0; i < 50; i++) expect(check('run', { id: `p${i}`, name: 'terminal_read', arguments: { id: 't1' } })).toBeNull()
  })
})
