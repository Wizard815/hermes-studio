import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addHerdrMachine, changeHerdrMachine, listHerdrMachines, machineAddArgs, machineId, parseRemoteAgents, remoteAttachArgs } from '../../packages/server/src/modules/coding-agents/services/herdr/machines'

describe('herdr remote machines', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })

  /** A stand-in herdr that records its arguments and answers `machine list/status`. */
  async function fakeHerdr(): Promise<{ binary: string; calls: () => Promise<string[][]> }> {
    dir = await mkdtemp(join(tmpdir(), 'herdr-machines-'))
    const log = join(dir, 'calls.jsonl')
    const binary = join(dir, 'herdr')
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (args[1] === 'list') console.log(JSON.stringify([{ id: 'ssh-1', label: 'build box', target: 'me@build', session: 'default', enabled: true, selected: false }, { id: 'ssh-2', label: 'old', target: 'old', session: 'default', enabled: false, selected: false }]))
else if (args[1] === 'status') console.log(JSON.stringify([{ id: 'ssh-1', label: 'build box', status: 'auth required', error: 'Permission denied (publickey)' }, { id: 'ssh-2', label: 'old', status: 'disabled' }]))
else if (args[1] === 'add') console.log('Saved SSH machine ssh-3. Remote server is ready.')
`)
    await chmod(binary, 0o755)
    return { binary, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
  }

  it('builds herdr machine add arguments and refuses option-like or odd input', () => {
    expect(machineAddArgs({ target: 'me@build.local' })).toEqual(['machine', 'add', 'me@build.local'])
    expect(machineAddArgs({ target: 'gpu', label: 'GPU box', session: 'work' })).toEqual(['machine', 'add', '--label', 'GPU box', '--remote-session', 'work', 'gpu'])
    expect(() => machineAddArgs({ target: '-oProxyCommand=evil' })).toThrow(/SSH target/)
    expect(() => machineAddArgs({ target: 'me@host; rm -rf /' })).toThrow(/SSH target/)
    expect(() => machineAddArgs({ target: 'host', label: '--remote-session' })).toThrow(/cannot start/)
    expect(() => machineAddArgs({ target: 'host', session: '../x' })).toThrow(/session/)
    expect(() => machineId('--all')).toThrow(/machine id/)
  })

  it('lists machines with their SSH status and runs herdr\'s own commands', async () => {
    const { binary, calls } = await fakeHerdr()
    const machines = await listHerdrMachines(binary, { withStatus: true })
    expect(machines).toEqual([
      { id: 'ssh-1', label: 'build box', target: 'me@build', session: 'default', enabled: true, selected: false, status: 'auth required', error: 'Permission denied (publickey)' },
      { id: 'ssh-2', label: 'old', target: 'old', session: 'default', enabled: false, selected: false, status: 'disabled' },
    ])
    expect(await addHerdrMachine(binary, { target: 'me@new', label: 'new' })).toBe('Saved SSH machine ssh-3. Remote server is ready.')
    await changeHerdrMachine(binary, 'ssh-2', { enabled: true })
    await changeHerdrMachine(binary, 'ssh-1', { label: 'builder' })
    await changeHerdrMachine(binary, 'ssh-1', { remove: true })
    expect((await calls()).slice(2)).toEqual([
      ['machine', 'add', '--label', 'new', 'me@new'],
      ['machine', 'enable', 'ssh-2'],
      ['machine', 'rename', '--label', 'builder', 'ssh-1'],
      ['machine', 'remove', 'ssh-1'],
    ])
  })

  it('attaches to a saved machine\'s full herdr with herdr --remote', async () => {
    const { binary } = await fakeHerdr()
    expect(await remoteAttachArgs(binary, 'ssh-1')).toEqual(['--remote', 'me@build'])
    await expect(remoteAttachArgs(binary, 'nope')).rejects.toThrow(/No such herdr machine/)
  })

  it('reads a machine\'s agents from herdr --machine agent list', () => {
    const output = JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents: [
      { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', agent: 'claude', agent_status: 'working', name: 'deploy', foreground_cwd: '/srv/app', focused: true, terminal_id: 't' },
      { workspace_id: 'w3' },
    ] } })
    expect(parseRemoteAgents(output)).toEqual([{ pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'working', label: 'deploy', cwd: '/srv/app', focused: true }])
    expect(parseRemoteAgents('not json')).toEqual([])
  })
})
