import { describe, expect, it } from 'vitest'
import { shouldStopManagedGatewaysOnShutdown } from '../../packages/server/src/bootstrap/lifecycle'

describe('shouldStopManagedGatewaysOnShutdown', () => {
  it('leaves the gateway running for the next Studio by default', () => {
    expect(shouldStopManagedGatewaysOnShutdown({})).toBe(false)
  })
  it('stops it when the desktop app quits', () => {
    expect(shouldStopManagedGatewaysOnShutdown({ HERMES_DESKTOP: 'true' })).toBe(true)
  })
  it('follows an explicit setting', () => {
    expect(shouldStopManagedGatewaysOnShutdown({ HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: '1' })).toBe(true)
    expect(shouldStopManagedGatewaysOnShutdown({ HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: 'false', HERMES_DESKTOP: 'true' })).toBe(false)
  })
})
