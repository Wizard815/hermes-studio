import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  classifySpawnError, spawnFailureCode, spawnFailureMessage,
  NODE_ENVIRONMENT_MISSING_CODE, NODE_ENVIRONMENT_MISSING_MESSAGE,
} from '../../packages/server/src/modules/coding-agents/services/spawn-errors'

const run = promisify(execFile)
/** The error Node really gives for a program that is not there. */
async function spawnError(command: string, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  try { await run(command, ['--version'], { env }); return null } catch (error) { return error }
}

describe('a missing coding agent is not a missing Node', () => {
  it('the agent\'s own CLI not found: "<Agent> isn\'t installed", not Node/npm', async () => {
    const err = await spawnError('studio-test-no-such-agent-cli')
    expect(classifySpawnError(err)).toEqual({ kind: 'command_missing', command: 'studio-test-no-such-agent-cli' })
    expect(spawnFailureMessage(classifySpawnError(err), 'Qwen Code')).toBe("Qwen Code isn't installed. Install it from Agent Manager.")
    expect(spawnFailureCode(classifySpawnError(err), 'Qwen Code')).toBe('coding_agent_not_installed')
  })

  it('some other program not found names that program', async () => {
    const err = await spawnError('/opt/studio-test/xterm')
    expect(spawnFailureMessage(classifySpawnError(err))).toBe('xterm was not found. Check that it is installed and on PATH.')
    expect(spawnFailureCode(classifySpawnError(err))).toBeUndefined()
  })

  it('npm or node not found is still Node missing', () => {
    for (const path of ['npm', '/usr/local/bin/node', 'C:\\Program Files\\nodejs\\npm.cmd']) {
      const err = Object.assign(new Error(`spawn ${path} ENOENT`), { code: 'ENOENT', path, syscall: `spawn ${path}` })
      expect(classifySpawnError(err)).toEqual({ kind: 'node_missing' })
      expect(spawnFailureMessage(classifySpawnError(err), 'Claude Code')).toBe(NODE_ENVIRONMENT_MISSING_MESSAGE)
      expect(spawnFailureCode(classifySpawnError(err), 'Claude Code')).toBe(NODE_ENVIRONMENT_MISSING_CODE)
    }
    expect(classifySpawnError({ message: 'bash: npm: command not found' })).toEqual({ kind: 'node_missing' })
    expect(classifySpawnError({ code: NODE_ENVIRONMENT_MISSING_CODE, message: 'x' })).toEqual({ kind: 'node_missing' })
  })

  it('an npm-installed agent whose node is missing (#!/usr/bin/env node) is Node missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-spawn-errors-'))
    try {
      const cli = join(dir, 'qwen')
      await writeFile(cli, '#!/usr/bin/env node\nconsole.log("1.0.0")\n')
      await chmod(cli, 0o755)
      const err = await spawnError(cli, { PATH: dir })
      expect(err).toBeTruthy()
      expect(classifySpawnError(err)).toEqual({ kind: 'node_missing' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('Agent Manager\'s status for an agent whose CLI is missing says it is not installed', async () => {
    const { getCodingAgentDefinition, getCodingAgentStatus } = await import('../../packages/server/src/modules/coding-agents/services')
    const qwen = getCodingAgentDefinition('qwen')!
    const status = await getCodingAgentStatus({ ...qwen, command: 'studio-test-no-such-qwen' })
    expect(status.installed).toBe(false)
    expect(status.error).toBe(`${qwen.name} isn't installed. Install it from Agent Manager.`)
  }, 30_000)

  it('other failures keep their own message', () => {
    const err = Object.assign(new Error('Command failed'), { code: 1, stderr: 'EACCES: permission denied' })
    expect(classifySpawnError(err)).toEqual({ kind: 'other' })
    expect(spawnFailureMessage(classifySpawnError(err), 'Codex')).toBe('')
  })
})
