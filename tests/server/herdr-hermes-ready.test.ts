import { describe, expect, it } from 'vitest'
import { hermesInputReady } from '../../packages/server/src/modules/coding-agents/services/herdr/bridge'

describe("Hermes's terminal UI in a herdr pane", () => {
  it('is not ready while the pane still shows the start-up lines', () => {
    expect(hermesInputReady("  Starting the chat's agent…\n⚠ install out of sync (pnpm: not installed)\n")).toBe(false)
    expect(hermesInputReady('Say exactly: right away\n')).toBe(false)
  })
  it('is ready once its input line and status bar are drawn', () => {
    const screen = 'Welcome to Hermes Agent!\n──── pong ─\n❯ \n────\n ☤ fake-model · ctx -- · 3s · ~/.hermes/workspace   / commands\n'
    expect(hermesInputReady(screen)).toBe(true)
  })
})
