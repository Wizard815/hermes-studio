import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RUN_LIMITS, type RunLimitHit } from '../../packages/shared/run-limits'
import { LoopDetector, detectLoopInCalls } from '../../packages/server/src/modules/studio/services/run-limits/loop-detector'
import { readGatewayTurn } from '../../packages/server/src/modules/studio/services/run-limits/gateway-history'
import { RunLimitSettingsStore } from '../../packages/server/src/modules/studio/services/run-limits/settings'
import { RunLimitService, describeHit } from '../../packages/server/src/modules/studio/services/run-limits/service'
import { priceGatewayRunUsage } from '../../packages/server/src/modules/studio/services/run-limits/pricing'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'run-limits-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function setup(now = { value: 1_000_000 }) {
  const store = new RunLimitSettingsStore(() => join(dir, 'run-limits.json'))
  const hits = new Map<string, RunLimitHit>()
  const notices: string[] = []
  const alerts: string[] = []
  const stopRun = vi.fn(async () => true)
  const service = new RunLimitService({
    store, stopRun,
    postNotice: (_id, text) => { notices.push(text) },
    setHit: (id, hit) => { if (hit) hits.set(id, hit); else hits.delete(id) },
    getHit: id => hits.get(id),
    alert: (_id, text) => { alerts.push(text) },
    priceGatewayUsage: ({ usage }) => (usage.inputTokens + usage.outputTokens) / 1000,
    now: () => now.value,
  })
  return { store, hits, notices, alerts, stopRun, service, now }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

describe('loop detector', () => {
  it('fires on the same call with the same arguments N times in a row, argument order aside', () => {
    const detector = new LoopDetector(() => 3)
    expect(detector.started('a', 'shell', { cmd: 'ls', cwd: '/' })).toBeNull()
    expect(detector.started('b', 'shell', '{"cwd":"/","cmd":"ls"}')).toBeNull()
    expect(detector.started('c', 'shell', { cwd: '/', cmd: 'ls' })).toMatchObject({ repeats: 3, failing: false })
  })

  it('starts over when another call comes in between', () => {
    const detector = new LoopDetector(() => 3)
    detector.started('a', 'read', { path: 'x' })
    detector.started('b', 'read', { path: 'x' })
    detector.started('c', 'read', { path: 'y' })
    expect(detector.started('d', 'read', { path: 'x' })).toBeNull()
  })

  it('fires on the same failing call repeated, even with other calls in between, until something works', () => {
    const detector = new LoopDetector(() => 3)
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      detector.started(id, 'shell', { cmd: 'npm test' })
      detector.started(`other${index}`, 'read', { path: String(index) })
      const verdict = detector.finished(id, true)
      if (index < 2) expect(verdict).toBeNull()
      else expect(verdict).toMatchObject({ repeats: 3, failing: true })
    }
    const fresh = new LoopDetector(() => 3)
    fresh.started('a', 'shell', { cmd: 'x' }); fresh.finished('a', true)
    fresh.started('b', 'shell', { cmd: 'x' }); fresh.finished('b', true)
    fresh.started('ok', 'read', { path: 'y' }); fresh.finished('ok', false)
    fresh.started('c', 'shell', { cmd: 'x' })
    expect(fresh.finished('c', true)).toBeNull()
  })

  it('is off when the limit is off', () => {
    const calls = Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: 'ls', args: {}, answered: true }))
    expect(detectLoopInCalls(calls, null)).toBeNull()
    expect(detectLoopInCalls(calls, 5)).toMatchObject({ repeats: 10 })
  })
})

describe('gateway history', () => {
  it('reads the current turn of a chat-completions request', () => {
    const call = (id: string) => ({ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] })
    const body = { messages: [
      { role: 'user', content: 'old' }, call('old1'), { role: 'tool', tool_call_id: 'old1', content: 'x' },
      { role: 'user', content: 'list files' }, call('a'), { role: 'tool', tool_call_id: 'a', content: 'x' }, call('b'),
    ] }
    const turn = readGatewayTurn('chat_completions', body)
    expect(turn.calls.map(c => [c.id, c.answered])).toEqual([['a', true], ['b', false]])
    expect(turn.turnKey).toMatch(/^2:/)
  })

  it('reads Anthropic tool results, errors included, and Responses function calls', () => {
    const anthropic = readGatewayTurn('anthropic_messages', { messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'fail' }] },
    ] })
    expect(anthropic.calls).toEqual([expect.objectContaining({ id: 't1', name: 'Bash', answered: true, failed: true })])
    const codex = readGatewayTurn('codex_responses', { input: [
      { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":["ls"]}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ] })
    expect(codex.calls).toEqual([expect.objectContaining({ id: 'c1', name: 'shell', answered: true })])
  })
})

describe('run limit settings', () => {
  it('defaults: cost, tokens and time off, loop detector on at 5', () => {
    const { store } = setup()
    expect(store.defaults()).toEqual(DEFAULT_RUN_LIMITS)
    expect(DEFAULT_RUN_LIMITS).toEqual({ costUsd: null, tokens: null, minutes: null, loopRepeats: 5 })
  })

  it('a chat override wins over Settings; null turns a limit off for the chat only', () => {
    const { store } = setup()
    store.saveDefaults({ costUsd: 1, tokens: 1000 })
    store.saveOverrides('chat', { costUsd: 3, loopRepeats: null })
    expect(store.effective('chat')).toEqual({ costUsd: 3, tokens: 1000, minutes: null, loopRepeats: null })
    expect(store.effective('other')).toEqual({ costUsd: 1, tokens: 1000, minutes: null, loopRepeats: 5 })
    store.saveOverrides('chat', {}, { clear: ['costUsd'] })
    expect(store.effective('chat').costUsd).toBe(1)
    const saved = JSON.parse(readFileSync(join(dir, 'run-limits.json'), 'utf8'))
    expect(saved.chats.chat).toEqual({ loopRepeats: null })
  })
})

describe('run limit service', () => {
  it('stops a Studio run at its cost limit, says why, alerts and waits for Continue', async () => {
    const { store, service, hits, notices, alerts, stopRun } = setup()
    store.saveDefaults({ costUsd: 0.5 })
    service.observeEvent('chat', 'run.started', { run_id: 'r1' })
    service.observeUsage({ sessionId: 'chat', tokens: 1000, costUsd: 0.3, late: false })
    expect(hits.size).toBe(0)
    service.observeUsage({ sessionId: 'chat', tokens: 1000, costUsd: 0.25, late: false })
    expect(hits.get('chat')).toMatchObject({ kind: 'cost', limit: 0.5, value: 0.55, via: 'run', suggested: 1 })
    await settle()
    expect(stopRun).toHaveBeenCalledWith('chat')
    expect(notices[0]).toContain('cost limit reached: this run used $0.55 of its $0.50 limit')
    expect(notices[0]).toContain('Continue with a higher limit ($1.00)')
    expect(alerts).toHaveLength(1)
    const result = service.continueWithHigherLimit('chat')
    expect(result.raised).toEqual({ kind: 'cost', value: 1 })
    expect(store.effective('chat').costUsd).toBe(1)
    expect(hits.size).toBe(0)
  })

  it('counts tokens of every call and fires the token limit', async () => {
    const { store, service, hits } = setup()
    store.saveDefaults({ tokens: 5000 })
    service.observeEvent('chat', 'run.started', { run_id: 'r1' })
    for (let i = 0; i < 4; i++) service.observeUsage({ sessionId: 'chat', tokens: 1500, late: false })
    expect(hits.get('chat')).toMatchObject({ kind: 'tokens', limit: 5000, value: 6000 })
  })

  it('fires the time limit from the clock and the loop detector from tool events', async () => {
    const { store, service, hits, now } = setup()
    store.saveDefaults({ minutes: 2 })
    service.observeEvent('chat', 'run.started', { run_id: 'r1' })
    now.value += 60_000
    service.tick()
    expect(hits.size).toBe(0)
    now.value += 61_000
    service.tick()
    expect(hits.get('chat')).toMatchObject({ kind: 'time', limit: 2 })

    service.observeEvent('loop', 'run.started', { run_id: 'r2' })
    for (let i = 0; i < 5; i++) service.observeEvent('loop', 'tool.started', { tool_call_id: `t${i}`, name: 'terminal', arguments: { command: 'ls' } })
    expect(hits.get('loop')).toMatchObject({ kind: 'loop', limit: 5, value: 5, detail: 'terminal({"command":"ls"})' })
  })

  it('a new message from the person clears a waiting limit, and runs that ended stop counting', async () => {
    const { store, service, hits } = setup()
    store.saveDefaults({ tokens: 10 })
    service.observeEvent('chat', 'run.started', { run_id: 'r1' })
    service.observeUsage({ sessionId: 'chat', tokens: 20, late: false })
    expect(hits.has('chat')).toBe(true)
    await settle()
    service.observeEvent('chat', 'abort.completed')
    service.observeUsage({ sessionId: 'chat', tokens: 20, late: false })
    service.observeEvent('chat', 'run.started', { run_id: 'r2' })
    expect(hits.has('chat')).toBe(false)
    expect(service.tracker.get('chat')?.tokens).toBe(0)
  })

  it('refuses a looping agent at the gateway, keeps refusing that turn, and lets a new prompt through', async () => {
    const { service, hits, stopRun } = setup()
    const call = (id: string) => ({ role: 'assistant', tool_calls: [{ id, function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] })
    const result = (id: string) => ({ role: 'tool', tool_call_id: id, content: 'same' })
    const messages: any[] = [{ role: 'user', content: 'go' }]
    for (let i = 0; i < 4; i++) {
      expect(service.checkGatewayRequest({ sessionId: 'pane', protocol: 'chat_completions', body: { messages } })).toBeNull()
      messages.push(call(`c${i}`), result(`c${i}`))
    }
    messages.push(call('c4'), result('c4'))
    const refusal = service.checkGatewayRequest({ sessionId: 'pane', protocol: 'chat_completions', body: { messages } })
    expect(refusal).toMatchObject({ status: 400, hit: { kind: 'loop', via: 'gateway', value: 5 } })
    expect(refusal!.message).toContain('loop detected')
    await settle()
    expect(stopRun).not.toHaveBeenCalled()
    expect(service.checkGatewayRequest({ sessionId: 'pane', protocol: 'chat_completions', body: { messages } })).not.toBeNull()
    expect(service.checkGatewayRequest({ sessionId: 'pane', protocol: 'chat_completions', body: { messages: [...messages, { role: 'user', content: 'try another way' }] } })).toBeNull()
    expect(hits.has('pane')).toBe(false)
  })

  it('counts gateway usage for agents outside Studio runs and refuses the next request past the cost limit', () => {
    const { store, service } = setup()
    store.saveDefaults({ costUsd: 1 })
    const body = { messages: [{ role: 'user', content: 'go' }] }
    expect(service.checkGatewayRequest({ sessionId: 'pane', protocol: 'chat_completions', body })).toBeNull()
    service.observeGatewayUsage({ sessionId: 'pane', model: 'm', usage: { inputTokens: 800, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 } })
    const refusal = service.checkGatewayRequest({ sessionId: 'pane', protocol: 'chat_completions', body })
    expect(refusal?.hit).toMatchObject({ kind: 'cost', value: 1.2 })
  })

  it('/limits shows and changes the chat limits', () => {
    const { service, store } = setup()
    expect(service.command('chat', '').message).toContain('Loop detector (same call): 5 in a row (Settings)')
    expect(service.command('chat', 'cost $2 tokens 500k time 1h').ok).toBe(true)
    expect(store.effective('chat')).toMatchObject({ costUsd: 2, tokens: 500000, minutes: 60 })
    service.command('chat', 'cost default loop off')
    expect(store.overrides('chat')).toEqual({ tokens: 500000, minutes: 60, loopRepeats: null })
    service.command('chat', 'off')
    expect(store.effective('chat')).toEqual({ costUsd: null, tokens: null, minutes: null, loopRepeats: null })
    service.command('chat', 'reset')
    expect(store.overrides('chat')).toEqual({})
    expect(service.command('chat', 'cost lots').ok).toBe(false)
  })

  it('describes a failing-call loop', () => {
    expect(describeHit({ kind: 'loop', limit: 5, value: 5, failing: true, detail: 'shell({"cmd":"npm test"})', via: 'run', at: 0, suggested: 10 }))
      .toContain('the same call failed 5 times in a row')
  })
})

describe('gateway run pricing', () => {
  const usage = { inputTokens: 40_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 }

  it('uses the manual price for the exact provider and model, like recorded usage', () => {
    const rates = [{ provider: 'custom:stub', model: 'stub-model', input: 3, output: 15 }]
    expect(priceGatewayRunUsage({ provider: 'custom:stub', model: 'stub-model', usage }, rates, undefined)).toBeCloseTo(0.15, 6)
  })

  it('has no price when neither a manual price nor the catalog knows the model', () => {
    const rates = [{ provider: 'custom:other', model: 'stub-model', input: 3, output: 15 }]
    expect(priceGatewayRunUsage({ provider: 'custom:stub', model: 'stub-model', usage }, rates, undefined)).toBeUndefined()
    expect(priceGatewayRunUsage({ provider: 'custom:stub', usage }, rates, undefined)).toBeUndefined()
  })
})
