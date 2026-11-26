import { afterEach, describe, expect, it } from 'vitest'
import { herdrManager } from '../../packages/server/src/modules/coding-agents/services/herdr/manager'

describe('Studio address for links from other apps', () => {
  const saved = process.env.HERMES_WEB_UI_PUBLIC_URL
  afterEach(() => { if (saved === undefined) delete process.env.HERMES_WEB_UI_PUBLIC_URL; else process.env.HERMES_WEB_UI_PUBLIC_URL = saved })

  it('prefers a public https address a browser used, then the latest one, then the setting', () => {
    delete process.env.HERMES_WEB_UI_PUBLIC_URL
    herdrManager.noteBrowserOrigin('http://192.168.1.20:8648')
    expect(herdrManager.publicUrl()).toBe('http://192.168.1.20:8648')
    herdrManager.noteBrowserOrigin('https://studio.example.com')
    herdrManager.noteBrowserOrigin('http://localhost:8648')
    expect(herdrManager.publicUrl()).toBe('https://studio.example.com')
    herdrManager.noteBrowserOrigin('')
    expect(herdrManager.publicUrl()).toBe('https://studio.example.com')
    process.env.HERMES_WEB_UI_PUBLIC_URL = 'https://set.example.com/'
    expect(herdrManager.publicUrl()).toBe('https://set.example.com')
  })
})
