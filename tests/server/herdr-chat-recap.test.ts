import { describe, expect, it } from 'vitest'
import { chatRecap } from '../../packages/server/src/bootstrap/herdr'

describe('an old chat without an agent session starts from the chat so far', () => {
  it('tells the fresh agent session what was said, newest part when long', () => {
    const recap = chatRecap('Fix login', [{ role: 'user', text: 'The login breaks on Safari' }, { role: 'assistant', text: 'It is the cookie flag.' }])
    expect(recap).toContain('("Fix login")')
    expect(recap).toContain('User: The login breaks on Safari')
    expect(recap).toContain('Assistant: It is the cookie flag.')
    expect(recap).toContain('Do not act on it yet')
    expect(chatRecap('x', [])).toBe('')
    const long = chatRecap('', Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: `message ${i} ${'x'.repeat(1500)}` })))
    expect(long).toContain('(newest part)')
    expect(long).toContain('message 29')
    expect(long).not.toContain('message 0 ')
  })
})
