import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STUDIO_TURN_CONTEXT_ENV, STUDIO_TURN_CONTEXT_HOOK_COMMAND, paneTurnContextFile, paneTurnContextLaunch, setPaneTurnContext, withStudioTurnContextHook,
} from '../../packages/server/src/modules/coding-agents/services/claude-code/turn-context'
import { beginHerdrPaneTurn, type HerdrPaneTurnDeps } from '../../packages/server/src/bootstrap/herdr'

// A message typed from Studio's chat box into an elevated chat's pane gets Studio's
// turn context like a Studio run (docs/harness/herdr.md, "Studio's context blocks").
const dirs: string[] = []
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'pane-ctx-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe("a chat's Claude Code pane carries Studio's context file", () => {
  it('global mode: the launch gets the inline hook and the file, which starts empty', () => {
    const file = paneTurnContextFile(join(dir(), 'turn-context'), 'chat/1')
    expect(file.endsWith('pane-chat_1.md')).toBe(true)
    const pane = paneTurnContextLaunch({ args: ['--resume', 'abc'] }, file, { platform: 'linux' })!
    expect(pane.args[0]).toBe('--settings')
    expect(JSON.parse(pane.args[1]).hooks.UserPromptSubmit[0].hooks[0].command).toBe(STUDIO_TURN_CONTEXT_HOOK_COMMAND)
    expect(pane.env).toEqual({ [STUDIO_TURN_CONTEXT_ENV]: file })
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  it("scoped mode uses its settings file's hook; an old settings file, Windows or a clean room get no file", () => {
    const d = dir()
    const withHook = join(d, 'settings.json')
    writeFileSync(withHook, JSON.stringify(withStudioTurnContextHook({})))
    const file = join(d, 'pane.md')
    expect(paneTurnContextLaunch({ args: ['--settings', withHook] }, file, { platform: 'linux' })).toEqual({ args: [], env: { [STUDIO_TURN_CONTEXT_ENV]: file } })
    const old = join(d, 'old.json')
    writeFileSync(old, '{}')
    const other = join(d, 'other.md')
    expect(paneTurnContextLaunch({ args: ['--settings', old] }, other, { platform: 'linux' })).toBeNull()
    expect(paneTurnContextLaunch({ args: [] }, other, { platform: 'win32' })).toBeNull()
    expect(paneTurnContextLaunch({ args: [] }, other, { platform: 'linux', cleanRoom: true })).toBeNull()
    expect(existsSync(other)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('the hook prints the file while a Studio turn runs and nothing after', () => {
    const file = join(dir(), 'pane.md')
    expect(setPaneTurnContext(file, 'x')).toBe(false) // not launched with it
    writeFileSync(file, '')
    const hook = () => execFileSync('sh', ['-c', STUDIO_TURN_CONTEXT_HOOK_COMMAND], { env: { PATH: process.env.PATH, [STUDIO_TURN_CONTEXT_ENV]: file } }).toString()
    expect(hook()).toBe('')
    expect(setPaneTurnContext(file, '<studio_task_plan_context>ctx</studio_task_plan_context>')).toBe(true)
    expect(hook()).toBe('<studio_task_plan_context>ctx</studio_task_plan_context>\n')
    setPaneTurnContext(file, '')
    expect(hook()).toBe('')
  })
})

describe('Studio begins a pane turn context', () => {
  function deps(agent: string, file: string, interaction = true) {
    const plans: Array<{ sessionId: string; profile: string; isCurrent: () => boolean; finished: string[] }> = []
    const value: HerdrPaneTurnDeps = {
      getSession: id => (id === 'chat-1' ? { agent, profile: 'work' } : null),
      hasInteraction: () => interaction,
      beginPlan: (sessionId, profile, isCurrent) => {
        const plan = { sessionId, profile, isCurrent, finished: [] as string[] }
        plans.push(plan)
        return { contextId: `ctx-${plans.length}`, finish: state => { plan.finished.push(state) } }
      },
      contextFile: () => file,
    }
    return { value, plans }
  }

  it('Claude Code pane launched by Studio: the context goes in its file, not after the message, and is emptied when the turn ends', async () => {
    const file = join(dir(), 'pane.md')
    writeFileSync(file, '')
    const { value, plans } = deps('claude-code', file)
    const isCurrent = () => true
    const turn = (await beginHerdrPaneTurn('chat-1', isCurrent, value))!
    expect(turn.append).toBeUndefined()
    expect(plans[0]).toMatchObject({ sessionId: 'chat-1', profile: 'work' })
    expect(plans[0].isCurrent).toBe(isCurrent)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('<studio_task_plan_context>')
    expect(text).toContain('Current turn context_id="ctx-1"')
    expect(text).toContain('<studio_session_tasks_context>')
    turn.end('ended')
    expect(readFileSync(file, 'utf8')).toBe('')
    expect(plans[0].finished).toEqual(['ended'])
  })

  it('other agents, and a Claude Code pane without the file, get the blocks after the message', async () => {
    const missing = join(dir(), 'none.md')
    for (const agent of ['codex', 'claude-code']) {
      const { value, plans } = deps(agent, missing)
      const turn = (await beginHerdrPaneTurn('chat-1', () => true, value))!
      expect(turn.append).toContain('Current turn context_id="ctx-1"')
      turn.end('interrupted')
      expect(plans[0].finished).toEqual(['interrupted'])
    }
    expect(existsSync(missing)).toBe(false)
  })

  it('nothing for chats without the task-card tools, non-coding-agent chats or unknown chats', async () => {
    const file = join(dir(), 'pane.md')
    expect(await beginHerdrPaneTurn('chat-1', () => true, deps('claude-code', file, false).value)).toBeNull()
    expect(await beginHerdrPaneTurn('chat-1', () => true, deps('hermes', file).value)).toBeNull()
    expect(await beginHerdrPaneTurn('chat-2', () => true, deps('claude-code', file).value)).toBeNull()
  })
})
