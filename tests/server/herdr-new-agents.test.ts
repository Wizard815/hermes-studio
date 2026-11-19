import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  nativeInteractiveApprovalArgs,
  nativeInteractiveMcpArgs,
  nativeResumeArgs,
  prepareCodingAgentInteractiveLaunch,
} from '../../packages/server/src/modules/coding-agents/services'
import { writeAgentApprovalSettings } from '../../packages/server/src/modules/coding-agents/services/approvals'
import {
  HERDR_STUDIO_CLIENT_AGENTS,
  herdrDetectsKind,
  herdrKindForStudioAgent,
  studioAgentForHerdrAgent,
} from '../../packages/server/src/modules/coding-agents/services/herdr/protocol'
import { herdrHostableAgentId } from '../../packages/server/src/bootstrap/herdr'
import { integrationKindsFor } from '../../packages/server/src/modules/coding-agents/services/herdr/manager'
import { withProviderAccount } from '../../packages/server/src/modules/studio/services/providers/account-store'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'

describe('CodeBuddy, ZCode and DSH in herdr', () => {
  it('runs CodeBuddy and ZCode as their own CLI in herdr, under their own names', () => {
    expect(herdrKindForStudioAgent('codebuddy')).toBe('codebuddy')
    expect(herdrKindForStudioAgent('zcode')).toBe('zcode')
    expect(studioAgentForHerdrAgent('codebuddy')).toBe('codebuddy')
    expect(studioAgentForHerdrAgent('ZCode')).toBe('zcode')
    expect(herdrHostableAgentId('codebuddy')).toBe('codebuddy')
    expect(herdrHostableAgentId('zcode')).toBe('zcode')
  })

  it('knows herdr cannot detect CodeBuddy or ZCode (Studio links and reports their panes)', () => {
    expect(herdrDetectsKind('codebuddy')).toBe(false)
    expect(herdrDetectsKind('zcode')).toBe(false)
    for (const kind of ['claude', 'codex', 'agy', 'qodercli', 'hermes']) expect(herdrDetectsKind(kind)).toBe(true)
    expect(herdrDetectsKind('')).toBe(false)
    // herdr has no session-reporting integration for them either.
    expect(integrationKindsFor(['codebuddy', 'zcode', 'claude-code'])).toEqual(['claude'])
  })

  it('shows DSH (ACP-only in Studio) through Studio\'s chat client, like Ekko', () => {
    expect(herdrKindForStudioAgent('dsh')).toBeNull()
    expect(herdrHostableAgentId('dsh')).toBeNull()
    expect(HERDR_STUDIO_CLIENT_AGENTS.has('dsh')).toBe(true)
    expect(HERDR_STUDIO_CLIENT_AGENTS.has('ekko-agent')).toBe(true)
  })

  it('resumes the chat\'s native session', () => {
    expect(nativeResumeArgs('codebuddy', 'sess-1')).toEqual({ prefix: [], suffix: ['--resume', 'sess-1'] })
    expect(nativeResumeArgs('zcode', 'sess-2')).toEqual({ prefix: [], suffix: ['--resume', 'sess-2'] })
    expect(nativeResumeArgs('codebuddy', '')).toEqual({ prefix: [], suffix: [] })
  })

  it('asks in the terminal unless Studio lets the agent act without asking', () => {
    expect(nativeInteractiveApprovalArgs('codebuddy', true)).toEqual([])
    expect(nativeInteractiveApprovalArgs('zcode', true)).toEqual([])
    expect(nativeInteractiveApprovalArgs('codebuddy', false)).toEqual(['--dangerously-skip-permissions'])
    expect(nativeInteractiveApprovalArgs('zcode', false)).toEqual(['--mode', 'yolo'])
    expect(nativeInteractiveApprovalArgs('qwen', false)).toEqual([])
  })

  it('hands CodeBuddy Studio\'s MCP servers with --mcp-config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cb-mcp-'))
    try {
      const args = await nativeInteractiveMcpArgs('codebuddy', { rootDir: root, nativeMcpServers: { studio: { command: 'node', args: ['x.mjs'] } } })
      expect(args).toEqual(['--mcp-config', join(root, 'herdr-mcp.json')])
      expect(JSON.parse(readFileSync(args[1], 'utf8'))).toEqual({ mcpServers: { studio: { command: 'node', args: ['x.mjs'] } } })
      expect(await nativeInteractiveMcpArgs('codebuddy', { rootDir: root, nativeMcpServers: {} })).toEqual([])
      expect(await nativeInteractiveMcpArgs('zcode', { rootDir: root, nativeMcpServers: { studio: {} } })).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('herdr launches for CodeBuddy and ZCode (stand-in CLIs)', () => {
  let bin = ''
  let workspace = ''
  const path = process.env.PATH
  beforeAll(() => {
    initAllHermesTables()
    bin = mkdtempSync(join(tmpdir(), 'herdr-agents-bin-'))
    workspace = mkdtempSync(join(tmpdir(), 'herdr-agents-ws-'))
    for (const name of ['codebuddy', 'zcode']) {
      writeFileSync(join(bin, name), '#!/bin/sh\necho "$0 $*"\n')
      chmodSync(join(bin, name), 0o755)
    }
    mkdirSync(join(workspace, 'w'), { recursive: true })
    process.env.PATH = `${bin}:${path}`
  })
  afterAll(() => {
    process.env.PATH = path
    writeAgentApprovalSettings({ agents: { codebuddy: 'ask', zcode: 'ask' } })
    rmSync(bin, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  for (const agent of ['codebuddy', 'zcode'] as const) {
    it(`${agent}: its own CLI, resuming the chat's session, asking before acting`, async () => {
      writeAgentApprovalSettings({ agents: { [agent]: 'ask' } })
      const launch = await withProviderAccount(1, () => prepareCodingAgentInteractiveLaunch(agent, { profile: 'default', mode: 'global', workspace: join(workspace, 'w'), model: '', resumeNativeSessionId: 'native-123' } as any))
      expect(launch.agentId).toBe(agent)
      expect(launch.command).toBe(join(bin, agent))
      expect(launch.args.slice(-2)).toEqual(['--resume', 'native-123'])
      expect(launch.args).not.toContain('--dangerously-skip-permissions')
      expect(launch.args).not.toContain('yolo')
    }, 30000)

    it(`${agent}: acts without asking when Studio says so`, async () => {
      writeAgentApprovalSettings({ agents: { [agent]: 'auto' } })
      const launch = await withProviderAccount(1, () => prepareCodingAgentInteractiveLaunch(agent, { profile: 'default', mode: 'global', workspace: join(workspace, 'w'), model: '' } as any))
      expect(launch.args).toEqual(expect.arrayContaining(agent === 'codebuddy' ? ['--dangerously-skip-permissions'] : ['--mode', 'yolo']))
      expect(launch.args).not.toContain('--resume')
    }, 30000)
  }
})
