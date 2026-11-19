import { describe, expect, it } from 'vitest'
import { GenerationClock, generationSeconds, isOutputEvent } from '../../packages/server/src/modules/studio/public/generation-time'

describe('model speed is measured from the first streamed output', () => {
  it('counts only output events', () => {
    for (const type of ['response.output_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta', 'response.output_item.added']) {
      expect(isOutputEvent(type)).toBe(true)
    }
    for (const type of ['response.created', 'response.in_progress', 'response.completed', undefined]) {
      expect(isOutputEvent(type)).toBe(false)
    }
  })

  it('leaves prompt processing and queueing out (llama.cpp-style generation speed)', () => {
    // 20 s of prompt processing, then 44 s generating 2,133 tokens: ~48 t/s, not ~33 t/s.
    const clock = new GenerationClock(0)
    clock.note('response.created', 100)
    clock.note('response.output_text.delta', 20_000)
    clock.note('response.output_text.delta', 30_000)
    expect(clock.seconds(64_000)).toBe(44)
    expect(Math.round(2133 / clock.seconds(64_000))).toBe(48)
  })

  it('keeps the whole request when nothing streamed or output was too short to time', () => {
    expect(new GenerationClock(0).seconds(5_000)).toBe(5)
    expect(generationSeconds(0, 4_900, 5_000)).toBe(5)
    expect(generationSeconds(0, 4_700, 5_000)).toBeCloseTo(0.3)
    expect(generationSeconds(1_000, 500, 5_000)).toBe(4)
  })

  it('noteOutput starts the clock once', () => {
    const clock = new GenerationClock(0)
    clock.noteOutput(1_000)
    clock.noteOutput(3_000)
    expect(clock.seconds(5_000)).toBe(4)
  })
})
