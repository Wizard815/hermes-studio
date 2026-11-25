import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HERMES_TURN_CONTEXT_PLUGIN, hermesPaneTurnFile, hermesTurnContextPluginFiles, hermesTurnContextReady, hermesTurnContextReadyForProfile, installHermesTurnContextPlugin,
  setHermesPaneTurn, withTurnContextPluginEnabled,
} from '../../packages/server/src/modules/hermes/services/herdr-turn-context'
import { beginHerdrPaneTurn, chatRunFields, type HerdrPaneTurnDeps } from '../../packages/server/src/bootstrap/herdr'

// A message Studio's chat box types into an elevated Hermes chat's `hermes chat` pane gets
// Studio's context through Hermes's own pre_llm_call plugin hook (docs/harness/herdr.md).
const dirs: string[] = []
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'hermes-ctx-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const python = (() => { try { execFileSync('python3', ['--version']); return true } catch { return false } })()

describe("Studio's turn-context plugin for Hermes", () => {
  it('declares a pre_llm_call hook and reads pending turns from Studio\'s folder', () => {
    const files = hermesTurnContextPluginFiles('/data/herdr/turn-context')
    expect(files['plugin.yaml']).toContain(`name: ${HERMES_TURN_CONTEXT_PLUGIN}`)
    expect(files['plugin.yaml']).toContain('  - pre_llm_call')
    expect(files['__init__.py']).toContain('CONTEXT_DIR = "/data/herdr/turn-context"')
    expect(files['__init__.py']).toContain('ctx.register_hook("pre_llm_call", studio_turn_context)')
  })

  it('is enabled in the profile unless the user disabled it', () => {
    expect(withTurnContextPluginEnabled({ model: { default: 'x' } })).toEqual({
      config: { model: { default: 'x' }, plugins: { enabled: [HERMES_TURN_CONTEXT_PLUGIN] } }, enabled: true, changed: true,
    })
    const already = { plugins: { enabled: ['other', HERMES_TURN_CONTEXT_PLUGIN] } }
    expect(withTurnContextPluginEnabled(already)).toEqual({ config: already, enabled: true, changed: false })
    const off = { plugins: { enabled: ['other'], disabled: [HERMES_TURN_CONTEXT_PLUGIN] } }
    expect(withTurnContextPluginEnabled(off)).toEqual({ config: off, enabled: false, changed: false })
  })

  it('installs into the profile\'s plugins folder and its config', async () => {
    const home = dir()
    const contextDir = join(dir(), 'turn-context')
    let config: Record<string, any> = { plugins: { enabled: ['disk-cleanup'] } }
    const deps = {
      profileHome: () => home,
      updateConfig: (async (_profile: string, updater: any) => {
        const out = await updater(config)
        if (out.write !== false) config = out.data
        return out.result
      }) as any,
    }
    expect(await installHermesTurnContextPlugin('work', contextDir, deps)).toBe(true)
    expect(config.plugins.enabled).toEqual(['disk-cleanup', HERMES_TURN_CONTEXT_PLUGIN])
    expect(readFileSync(join(home, 'plugins', HERMES_TURN_CONTEXT_PLUGIN, '__init__.py'), 'utf8')).toContain(JSON.stringify(contextDir))
    expect(existsSync(contextDir)).toBe(true)
    expect(hermesTurnContextReady('work', config, deps)).toBe(true)
    expect(hermesTurnContextReady('work', { plugins: { enabled: [] } }, deps)).toBe(false)
    expect(hermesTurnContextReady('work', config, { profileHome: () => dir() })).toBe(false)
  })

  it("is ready when the profile's own Hermes config enables it, the file the installer writes", async () => {
    const home = dir()
    let config: Record<string, any> = {}
    const read: string[] = []
    const deps = {
      profileHome: () => home,
      updateConfig: (async (_profile: string, updater: any) => {
        const out = await updater(config)
        if (out.write !== false) config = out.data
        return out.result
      }) as any,
      readConfig: async (profile: string) => { read.push(profile); return config },
    }
    expect(await hermesTurnContextReadyForProfile('work', deps)).toBe(false)
    await installHermesTurnContextPlugin('work', join(dir(), 'turn-context'), deps)
    expect(await hermesTurnContextReadyForProfile('work', deps)).toBe(true)
    expect(await hermesTurnContextReadyForProfile('', deps)).toBe(true)
    expect(read).toEqual(['work', 'work', 'default'])
  })

  it.runIf(python)("gives the context only to the turn Studio typed, in that chat's session, while the file exists", () => {
    const pluginDir = join(dir(), HERMES_TURN_CONTEXT_PLUGIN)
    const contextDir = join(dir(), 'turn-context')
    mkdirSync(pluginDir, { recursive: true })
    for (const [name, content] of Object.entries(hermesTurnContextPluginFiles(contextDir))) writeFileSync(join(pluginDir, name), content)
    const file = hermesPaneTurnFile(contextDir, 'chat/1')
    expect(file.endsWith('hermes-chat_1.json')).toBe(true)
    const hook = (args: Record<string, unknown>) => {
      const script = [
        'import importlib.util, json, sys',
        `spec = importlib.util.spec_from_file_location("studio_turn_context", ${JSON.stringify(join(pluginDir, '__init__.py'))})`,
        'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
        'hooks = []',
        'class Ctx:',
        '    def register_hook(self, name, fn): hooks.append((name, fn))',
        'mod.register(Ctx())',
        'assert hooks[0][0] == "pre_llm_call"',
        'print(json.dumps(hooks[0][1](**json.loads(sys.argv[1]))))',
      ].join('\n')
      return JSON.parse(execFileSync('python3', ['-I', '-c', script, JSON.stringify(args)], { encoding: 'utf8' }).trim())
    }
    const base = { session_id: 'hermes-1', user_message: 'plan the release', conversation_history: [], is_first_turn: false, model: 'm', platform: 'cli' }
    expect(hook(base)).toBeNull()
    setHermesPaneTurn(file, { sessionIds: ['hermes-1', 'chat/1'], text: 'plan the release', context: '<studio_task_plan_context>ctx-1</studio_task_plan_context>' })
    expect(hook(base)).toEqual({ context: '<studio_task_plan_context>ctx-1</studio_task_plan_context>' })
    // Whitespace differences from typing into the terminal do not matter.
    expect(hook({ ...base, user_message: ' plan  the\nrelease ' })).toEqual({ context: '<studio_task_plan_context>ctx-1</studio_task_plan_context>' })
    // A turn typed by hand (other text) gets nothing.
    expect(hook({ ...base, user_message: 'something else' })).toBeNull()
    // Another chat's session with the same text: only when no session matches and the text is unique.
    setHermesPaneTurn(hermesPaneTurnFile(contextDir, 'chat-2'), { sessionIds: ['hermes-2'], text: 'plan the release', context: 'other' })
    expect(hook(base)).toEqual({ context: '<studio_task_plan_context>ctx-1</studio_task_plan_context>' })
    expect(hook({ ...base, session_id: 'hermes-9' })).toBeNull()
    // Ended: the file is gone.
    setHermesPaneTurn(file, null)
    setHermesPaneTurn(hermesPaneTurnFile(contextDir, 'chat-2'), null)
    expect(existsSync(file)).toBe(false)
    expect(hook(base)).toBeNull()
  })
})

describe('Studio begins a Hermes pane turn', () => {
  function deps(turnFile: string, options: { interaction?: boolean; ready?: boolean } = {}) {
    const plans: Array<{ finished: string[] }> = []
    const value: HerdrPaneTurnDeps = {
      getSession: id => (id === 'chat-1' ? { id, agent: 'hermes', profile: 'work', agent_native_session_id: 'hermes-native' } : null),
      hasInteraction: () => { throw new Error('coding agents only') },
      beginPlan: () => {
        const plan = { finished: [] as string[] }
        plans.push(plan)
        return { contextId: `ctx-${plans.length}`, finish: state => { plan.finished.push(state) } }
      },
      contextFile: () => '',
      hermesInteraction: async () => options.interaction ?? true,
      hermesPluginReady: async () => options.ready ?? true,
      hermesTurnFile: () => turnFile,
    }
    return { value, plans }
  }

  it('with the plugin: the context goes in the pending file with the typed text, not after the message, and goes when the turn ends', async () => {
    const file = join(dir(), 'hermes-chat-1.json')
    const { value, plans } = deps(file)
    const turn = (await beginHerdrPaneTurn('chat-1', () => true, value, 'plan the release'))!
    expect(turn.append).toBeUndefined()
    const pending = JSON.parse(readFileSync(file, 'utf8'))
    expect(pending).toMatchObject({ sessionIds: ['hermes-native', 'chat-1'], text: 'plan the release' })
    expect(pending.context).toContain('Current turn context_id="ctx-1"')
    expect(pending.context).toContain('<studio_session_tasks_context>')
    turn.end('ended')
    expect(existsSync(file)).toBe(false)
    expect(plans[0].finished).toEqual(['ended'])
  })

  it('without the plugin: the blocks go after the typed text', async () => {
    const file = join(dir(), 'hermes-chat-1.json')
    const turn = (await beginHerdrPaneTurn('chat-1', () => true, deps(file, { ready: false }).value, 'plan'))!
    expect(turn.append).toContain('<studio_task_plan_context>')
    expect(existsSync(file)).toBe(false)
  })

  it('nothing for a Hermes profile without the task-card tools', async () => {
    expect(await beginHerdrPaneTurn('chat-1', () => true, deps(join(dir(), 'x.json'), { interaction: false }).value, 'plan')).toBeNull()
  })
})

describe("Ekko (and Hermes without its CLI): the pane is Studio's chat client", () => {
  it("each line it sends is an ordinary Studio run of the chat, which builds Studio's context itself", () => {
    const row = { id: 'chat-e', agent: 'ekko-agent', agent_mode: null, model: 'm', provider: 'p', workspace: '/w' } as any
    expect(chatRunFields(row)).toEqual({ session_id: 'chat-e', workspace: '/w', model: 'm', provider: 'p', source: 'coding_agent', coding_agent_id: 'ekko-agent' })
    // A Hermes chat runs through Studio's Hermes bridge (no coding agent id).
    expect(chatRunFields({ ...row, id: 'chat-h', agent: 'hermes' })).toEqual({ session_id: 'chat-h', workspace: '/w', model: 'm', provider: 'p' })
  })
})
