import { describe, expect, it } from 'vitest'
import { ChatMessenger, MAX_HOPS, PAIR_SENDS_PER_HOUR, type ChatRow, type ChatMessengerDeps } from '../../packages/server/src/modules/studio/services/chat-messages/service'

const me = { id: 7, role: 'user' }

/** Fake chats: each turn's answer comes from `answer`, and every run is recorded. */
function setup(answer: (sessionId: string, input: string, messenger: ChatMessenger) => Promise<string> | string = (id) => `answer from ${id}`) {
  const rows: Record<string, ChatRow> = {
    a: { id: 'a', title: 'Argos fixes', profile: 'default', studio_user_id: '7' },
    b: { id: 'b', title: 'Docs', profile: 'writer', studio_user_id: '7' },
    c: { id: 'c', title: 'Third', profile: 'default', studio_user_id: '7' },
    d: { id: 'd', title: 'D', profile: 'default', studio_user_id: '7' },
    e: { id: 'e', title: 'E', profile: 'default', studio_user_id: '7' },
    f: { id: 'f', title: 'F', profile: 'default', studio_user_id: '7' },
    x: { id: 'x', title: 'Someone else', profile: 'default', studio_user_id: '9' },
  }
  const runs: Array<{ sessionId: string; profile: string; input: string; display: string }> = []
  const busy = new Set<string>()
  let clock = 1_000_000
  const deps: ChatMessengerDeps = {
    getSession: id => rows[id] ?? null,
    list: () => Object.values(rows),
    busy: id => busy.has(id),
    now: () => clock,
    sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)) },
    run: async input => {
      runs.push(input)
      return { ok: true, output: await answer(input.sessionId, input.input, messenger) }
    },
  }
  const messenger = new ChatMessenger(deps)
  return { messenger, runs, busy, rows, tick: (ms: number) => { clock += ms } }
}

describe('chat messages', () => {
  it('TestChats_askRunsTheOtherChatAndReturnsItsAnswer', async () => {
    const { messenger, runs } = setup()
    const out = await messenger.ask({ from: 'a', to: 'b', text: 'Which port?' }, me)
    expect(out).toEqual({ chat: 'b', title: 'Docs', ok: true, reply: 'answer from b' })
    expect(runs).toHaveLength(1)
    expect(runs[0].sessionId).toBe('b')
    expect(runs[0].profile).toBe('writer')
    expect(runs[0].input).toContain('<studio_chat_message from_chat="Argos fixes" from_id="a" hop="1">')
    expect(runs[0].input).toContain('not from your person')
    expect(runs[0].display).toBe('💬 From “Argos fixes”: Which port?')
  })

  it('TestChats_sendDeliversTheAnswerBackAsATurn', async () => {
    const { messenger, runs } = setup()
    expect(messenger.send({ from: 'a', to: 'b', text: 'Write the docs' }, me)).toEqual({ chat: 'b', title: 'Docs', queued: true })
    await messenger.idle()
    expect(runs.map(run => run.sessionId)).toEqual(['b', 'a'])
    expect(runs[1].input).toContain('<studio_chat_reply from_chat="Docs" from_id="b">')
    expect(runs[1].input).toContain('answer from b')
    expect(runs[1].input).toContain('<studio_chat_sent to_chat="Docs">\nWrite the docs\n</studio_chat_sent>')
    expect(runs[1].display).toBe('↩ Reply from “Docs”: answer from b')
  })

  it('TestChats_busyChatGetsTheMessageAfterItsTurn', async () => {
    const { messenger, runs, busy } = setup()
    busy.add('b')
    const pending = messenger.ask({ from: 'a', to: 'b', text: 'hi' }, me)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runs).toHaveLength(0)
    busy.delete('b')
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(runs).toHaveLength(1)
  })

  it('TestChats_refusesSelfOtherPeopleAndEmptyText', async () => {
    const { messenger } = setup()
    await expect(messenger.ask({ from: 'a', to: 'a', text: 'hi' }, me)).rejects.toMatchObject({ status: 400 })
    await expect(messenger.ask({ from: 'a', to: 'x', text: 'hi' }, me)).rejects.toMatchObject({ status: 403 })
    await expect(messenger.ask({ from: 'a', to: 'b', text: '  ' }, me)).rejects.toMatchObject({ status: 400 })
    await expect(messenger.ask({ from: 'a', to: 'nope', text: 'hi' }, me)).rejects.toMatchObject({ status: 404 })
    // A super admin may connect any chats.
    await expect(messenger.ask({ from: 'a', to: 'x', text: 'hi' }, { id: 1, role: 'super_admin' })).resolves.toMatchObject({ ok: true })
  })

  it('TestChats_listShowsOnlyThisPersonsOtherChats', () => {
    const { messenger } = setup()
    expect(messenger.list({ from: 'a' }, me).chats.map(chat => chat.id)).toEqual(['b', 'c', 'd', 'e', 'f'])
    expect(messenger.list({ from: 'a' }, { id: 1, role: 'super_admin' }).chats.map(chat => chat.id)).toEqual(['b', 'c', 'd', 'e', 'f', 'x'])
  })

  it('TestChats_chainsStopAtTheHopLimit', async () => {
    // Each chat asks the next one while answering: a → b → c → d → e → f.
    const order = ['a', 'b', 'c', 'd', 'e', 'f']
    const errors: string[] = []
    const { messenger, runs } = setup(async (id, _input, m) => {
      const next = order[order.indexOf(id) + 1]
      if (!next) return 'end'
      try { return (await m.ask({ from: id, to: next, text: 'pass it on' }, me)).reply } catch (error) { errors.push((error as Error).message); return 'stopped' }
    })
    await messenger.ask({ from: 'a', to: 'b', text: 'start' }, me)
    expect(runs.map(run => run.sessionId)).toEqual(['b', 'c', 'd', 'e'])
    expect(errors).toEqual([expect.stringContaining(`chains stop at ${MAX_HOPS}`)])
  })

  it('TestChats_aLoopOfAsksIsRefusedInsteadOfDeadlocking', async () => {
    // a asks b, b asks c, c asks a: a is still waiting on b, so c is refused.
    const order = ['a', 'b', 'c']
    const errors: string[] = []
    const { messenger } = setup(async (id, _input, m) => {
      const next = order[(order.indexOf(id) + 1) % order.length]
      try { return (await m.ask({ from: id, to: next, text: 'pass it on' }, me)).reply } catch (error) { errors.push((error as Error).message); return 'stopped' }
    })
    await expect(messenger.ask({ from: 'a', to: 'b', text: 'start' }, me)).resolves.toMatchObject({ ok: true, reply: 'stopped' })
    expect(errors).toEqual([expect.stringContaining('is waiting for your answer')])
  })

  it('TestChats_waitingChatCannotBeAskedBack', async () => {
    let refused = ''
    const { messenger } = setup(async (id, _input, m) => {
      if (id === 'b') { try { await m.ask({ from: 'b', to: 'a', text: 'and you?' }, me) } catch (error) { refused = (error as Error).message } }
      return 'done'
    })
    await messenger.ask({ from: 'a', to: 'b', text: 'hi' }, me)
    expect(refused).toContain('is waiting for your answer')
  })

  it('TestChats_eachPairIsRateLimited', async () => {
    const { messenger, tick } = setup()
    for (let i = 0; i < PAIR_SENDS_PER_HOUR; i++) await messenger.ask({ from: 'a', to: 'b', text: `m${i}` }, me)
    await expect(messenger.ask({ from: 'a', to: 'b', text: 'one more' }, me)).rejects.toMatchObject({ status: 429 })
    // Another pair is not limited, and the hour passes.
    await expect(messenger.ask({ from: 'a', to: 'c', text: 'hi' }, me)).resolves.toMatchObject({ ok: true })
    tick(61 * 60_000)
    await expect(messenger.ask({ from: 'a', to: 'b', text: 'later' }, me)).resolves.toMatchObject({ ok: true })
  })
})
