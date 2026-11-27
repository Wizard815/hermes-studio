import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const appHome = vi.hoisted(() => require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'mcp-directory-app-')) as string)
vi.mock('../../packages/server/src/modules/studio/public/config', async (orig) => {
  const real = await orig<any>()
  return { ...real, config: { ...real.config, appHome } }
})

import {
  MCP_RECOMMENDED, configFromInstall, forgetMcpDirectory, loadMcpDirectory, mcpDirectoryCategories, parseMcpDirectory, searchMcpDirectory,
} from '../../packages/server/src/modules/hermes/services/mcp/directory'

const SAMPLE = readFileSync(resolve(__dirname, '../fixtures/awesome-mcp-sample.md'), 'utf8')

afterAll(() => rmSync(appHome, { recursive: true, force: true }))

describe('parsing awesome-mcp-servers', () => {
  const entries = parseMcpDirectory(SAMPLE)

  it('reads only Server Implementations, with category, marks and description', () => {
    expect(entries.map(entry => entry.name)).toEqual(['tevonsb/homeassistant-mcp', 'zerostack-rf/zerostack-mcp', '77777R7/Octocrawl', 'x/setup-only', 'x/piped'])
    expect(entries[0]).toMatchObject({ category: 'Home Automation', languages: ['TypeScript'], scopes: ['local'], official: false, description: 'Access Home Assistant data and control devices such as lights.' })
    expect(entries[1]).toMatchObject({ official: true, languages: ['Python'], scopes: ['local', 'embedded'], os: ['macOS', 'Windows', 'Linux'] })
    expect(entries[3].scopes).toEqual(['cloud'])
  })

  it('turns a plain npx line into a stdio config, and leaves setup steps and shell pipes as hints', () => {
    expect(entries[2]).toMatchObject({ install: 'npx -y @octocrawl/mcp', config: { command: 'npx', args: ['-y', '@octocrawl/mcp'] } })
    expect(entries[3].install).toBe('npx -y setup-only setup')
    expect(entries[3].config).toBeUndefined()
    expect(entries[4].config).toBeUndefined()
    expect(configFromInstall('npx some-pkg')).toEqual({ command: 'npx', args: ['-y', 'some-pkg'] })
    expect(configFromInstall('docker run x')).toBeUndefined()
  })

  it('searches by words, category, scope, official and ready-to-add', () => {
    expect(searchMcpDirectory(entries, { q: 'home assistant' }).entries.map(entry => entry.name)).toEqual(['tevonsb/homeassistant-mcp'])
    expect(searchMcpDirectory(entries, { category: 'Browser Automation', scope: 'local' }).total).toBe(2)
    expect(searchMcpDirectory(entries, { official: true }).total).toBe(2)
    expect(searchMcpDirectory(entries, { ready: true }).entries.map(entry => entry.name)).toEqual(['77777R7/Octocrawl'])
    expect(searchMcpDirectory(entries, { limit: 2, offset: 4 })).toMatchObject({ total: 5, entries: [{ name: 'x/piped' }] })
    expect(mcpDirectoryCategories(entries)).toEqual([{ name: 'Home Automation', count: 2 }, { name: 'Browser Automation', count: 3 }])
  })

  it('pins every recommended server', () => {
    expect(MCP_RECOMMENDED.map(entry => entry.name)).toEqual(['tokensave', 'markitdown', 'repomix'])
    for (const entry of MCP_RECOMMENDED.filter(entry => entry.config.command !== 'tokensave')) {
      expect(entry.config.args.join(' '), entry.name).toMatch(/[@=]\d+\.\d+/)
    }
  })
})

describe('loading the list', () => {
  beforeEach(() => forgetMcpDirectory())

  it('downloads once a day and falls back to the cached copy when GitHub is down', async () => {
    let now = Date.now()
    const fetcher = vi.fn(async () => SAMPLE)
    const first = await loadMcpDirectory({ fetcher, now: () => now })
    expect(first.entries).toHaveLength(5)
    forgetMcpDirectory()
    await loadMcpDirectory({ fetcher, now: () => now })
    expect(fetcher).toHaveBeenCalledTimes(1)
    forgetMcpDirectory()
    now += 25 * 3600 * 1000
    const down = vi.fn(async () => { throw new Error('offline') })
    const stale = await loadMcpDirectory({ fetcher: down, now: () => now })
    expect(down).toHaveBeenCalledTimes(1)
    expect(stale.entries).toHaveLength(5)
  })

  it('says what failed when there is no cache yet', async () => {
    rmSync(join(appHome, 'mcp-directory'), { recursive: true, force: true })
    await expect(loadMcpDirectory({ fetcher: async () => { throw new Error('offline') } })).rejects.toThrow(/Could not download the MCP list from GitHub: offline/)
  })
})
