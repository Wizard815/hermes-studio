/**
 * Model speed is measured from the first output the model streams (text,
 * reasoning or tool-call arguments) to the end of the request, so prompt
 * processing and queueing don't count: it matches what a server like
 * llama.cpp reports as generation speed. A reply that streams nothing, or
 * whose output arrives within MIN_GENERATION_SECONDS, keeps the whole request
 * time (a couple of tokens over a few milliseconds would read as an absurd speed).
 */
export const MIN_GENERATION_SECONDS = 0.25

/** Streamed Responses events that carry model output. */
export function isOutputEvent(type: string | undefined): boolean {
  return !!type && (type.endsWith('.delta') || type === 'response.output_item.added')
}

export function generationSeconds(startedAt: number, firstOutputAt: number | undefined, now = performance.now()): number {
  if (firstOutputAt != null && firstOutputAt >= startedAt) {
    const generating = (now - firstOutputAt) / 1000
    if (generating >= MIN_GENERATION_SECONDS) return generating
  }
  return (now - startedAt) / 1000
}

/** Per-request clock: note output as it streams, read the duration at the end. */
export class GenerationClock {
  private firstOutputAt: number | undefined
  constructor(readonly startedAt = performance.now()) {}
  note(eventType: string | undefined, now = performance.now()) {
    if (this.firstOutputAt == null && isOutputEvent(eventType)) this.firstOutputAt = now
  }
  noteOutput(now = performance.now()) {
    if (this.firstOutputAt == null) this.firstOutputAt = now
  }
  seconds(now = performance.now()): number {
    return generationSeconds(this.startedAt, this.firstOutputAt, now)
  }
}
