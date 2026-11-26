import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeTurnContext } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import {
  STUDIO_TURN_CONTEXT_ENV, STUDIO_TURN_CONTEXT_HOOK_COMMAND, inlineTurnContextSettings, withStudioTurnContextHook,
} from '../../packages/server/src/modules/coding-agents/services/claude-code/turn-context'
import { parseTranscriptLine } from '../../packages/server/src/modules/coding-agents/services/herdr/transcript'
import { stripStudioContextBlocks } from '../../packages/shared/studio-context'

const CONTEXT = '<studio_task_plan_context>\nUse the task card. Current turn context_id="ctx-1".\n</studio_task_plan_context>'

// Studio's context blocks stay out of what the user sees in a herdr pane (docs/harness/herdr.md).
describe("Studio's per-turn context for Claude Code", () => {
  const dirs: string[] = []
  const dir = () => { const d = mkdtempSync(join(tmpdir(), 'turn-ctx-')); dirs.push(d); return d }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('global mode: the context goes in a file the inline hook prints, and the input stays what the user typed', () => {
    const d = dir()
    const turn = claudeTurnContext({ id: 'car_1', launch: { command: 'claude', args: ['--append-system-prompt-file', join(d, 'p.md')], promptFile: join(d, 'p.md') } as any }, 'Fix the login test', CONTEXT, 'linux')
    expect(turn.input).toBe('Fix the login test')
    expect(turn.args[0]).toBe('--settings')
    expect(JSON.parse(turn.args[1]).hooks.UserPromptSubmit[0].hooks[0].command).toBe(STUDIO_TURN_CONTEXT_HOOK_COMMAND)
    const file = turn.env[STUDIO_TURN_CONTEXT_ENV]
    expect(file.startsWith(d)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(`${CONTEXT}\n`)
  })

  it('scoped mode uses its settings file when it has the hook, and falls back to the input when it does not', () => {
    const d = dir()
    const withHook = join(d, 'settings.json')
    writeFileSync(withHook, JSON.stringify(withStudioTurnContextHook({ model: 'x' })))
    const launch = (settings: string) => ({ command: 'claude', args: ['--settings', settings], promptFile: join(d, 'p.md') }) as any
    const scoped = claudeTurnContext({ id: 'car_2', launch: launch(withHook) }, 'hi', CONTEXT, 'linux')
    expect(scoped.args).toEqual([])
    expect(scoped.input).toBe('hi')
    const old = join(d, 'old.json')
    writeFileSync(old, '{"model":"x"}')
    const fallback = claudeTurnContext({ id: 'car_3', launch: launch(old) }, 'hi', CONTEXT, 'linux')
    expect(fallback.input).toBe(`hi\n\n${CONTEXT}`)
    expect(fallback.env).toEqual({ [STUDIO_TURN_CONTEXT_ENV]: '' })
  })

  it('Windows and clean rooms keep the old way; a turn without context clears the variable', () => {
    const launch = { command: 'claude', args: [] } as any
    expect(claudeTurnContext({ id: 'a', launch }, 'hi', CONTEXT, 'win32').input).toBe(`hi\n\n${CONTEXT}`)
    expect(claudeTurnContext({ id: 'a', launch }, 'hi', '', 'linux')).toEqual({ input: 'hi', args: [], env: { [STUDIO_TURN_CONTEXT_ENV]: '' } })
  })

  it("keeps the user's own UserPromptSubmit hooks and adds Studio's once", () => {
    const own = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [] } }
    const once = withStudioTurnContextHook(own)
    expect(once.hooks.UserPromptSubmit).toHaveLength(2)
    expect(once.hooks.Stop).toEqual([])
    expect(withStudioTurnContextHook(once)).toBe(once)
    expect(inlineTurnContextSettings()).toContain(STUDIO_TURN_CONTEXT_ENV)
  })

  it.runIf(process.platform !== 'win32')('the hook prints the file, and nothing when the variable is unset (a turn typed in the herdr pane)', () => {
    const d = dir()
    const file = join(d, 'ctx.md')
    writeFileSync(file, CONTEXT)
    expect(execFileSync('sh', ['-c', STUDIO_TURN_CONTEXT_HOOK_COMMAND], { env: { PATH: process.env.PATH, [STUDIO_TURN_CONTEXT_ENV]: file } }).toString()).toBe(CONTEXT)
    expect(execFileSync('sh', ['-c', STUDIO_TURN_CONTEXT_HOOK_COMMAND], { env: { PATH: process.env.PATH } }).toString()).toBe('')
  })

  it('the herdr transcript mirror strips context blocks still inside a user message (other agents, older sessions)', () => {
    expect(stripStudioContextBlocks(`Fix it\n\n${CONTEXT}\n\n<studio_interaction_context>\nask\n</studio_interaction_context>`)).toBe('Fix it')
    expect(stripStudioContextBlocks('plain <studio_ text')).toBe('plain <studio_ text')
    const codex = JSON.stringify({ type: 'response_item', timestamp: '2026-11-25T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Fix it\n\n${CONTEXT}` }] } })
    expect(parseTranscriptLine(codex)?.content).toBe('Fix it')
    const onlyContext = JSON.stringify({ type: 'user', message: { role: 'user', content: CONTEXT } })
    expect(parseTranscriptLine(onlyContext)).toBeNull()
  })
})
