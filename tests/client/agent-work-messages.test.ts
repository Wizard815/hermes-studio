import { describe, expect, it } from 'vitest'
import { baseCompile } from '@intlify/message-compiler'
import { agentWorkMessages } from '../../packages/client/src/i18n/agent-work-messages'

/** Every Agent work message must compile: a bare "@" (linked-message syntax) broke the whole panel once. */
function strings(value: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof value === 'string') return [[path.join('.'), value]]
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => strings(v, [...path, k]))
}

describe('Agent work messages', () => {
  it('all compile with vue-i18n', () => {
    const bad: string[] = []
    for (const [key, message] of strings(agentWorkMessages.en)) {
      baseCompile(message, { onError: () => bad.push(key) })
    }
    expect(bad).toEqual([])
  })
})
