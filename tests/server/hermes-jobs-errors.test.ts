import { describe, expect, it } from 'vitest'
import { cronFailureMessage } from '../../packages/server/src/modules/hermes/controllers/jobs'

describe('hermes cron failures', () => {
  it("shows Hermes's reason, not its install warning", () => {
    const stderr = "⚠ install out of sync (pnpm: not installed or outdated) — this docker-managed install must rebuild the artifact to fix\nFailed to create job: Invalid duration: 'banana'. Use format like '30m'."
    expect(cronFailureMessage(stderr, '')).toBe("Failed to create job: Invalid duration: 'banana'. Use format like '30m'.")
    expect(cronFailureMessage('⚠ install out of sync', 'Error: unknown job')).toBe('Error: unknown job')
  })
  it('keeps any other output when no line says it failed', () => {
    expect(cronFailureMessage('something odd', '')).toBe('something odd')
    expect(cronFailureMessage('', '')).toBe('')
  })
})
