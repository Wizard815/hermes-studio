import { describe, expect, it } from 'vitest'
import { ChatCleanupService, oneLine, prLinksIn, type ChatCleanupDeps, type CleanupChat } from '../../packages/server/src/modules/studio/services/sessions/chat-cleanup'

const chat = (id: string, extra: Partial<CleanupChat> = {}): CleanupChat => ({ id, title: id, profile: 'default', provider: 'openrouter', model: 'm', apiMode: '', messageCount: 4, ...extra })

function deps(over: Partial<ChatCleanupDeps> = {}) {
  const calls: any[] = []
  const captured: any[] = []
  const messages: Record<string, any[]> = {
    a: [{ role: 'user', content: 'fix login' }, { role: 'assistant', content: 'Opened https://github.com/o/r/pull/7 and https://github.com/o/r/pull/8/files' }],
    b: [{ role: 'assistant', content: 'Draft at https://github.com/o/r/pull/9' }],
    c: [{ role: 'user', content: 'hello' }],
    empty: [],
  }
  const base: ChatCleanupDeps = {
    messages: id => messages[id] || [],
    defaultModel: async () => ({ provider: 'p', model: 'default-model' }),
    ask: async options => { calls.push(options); return options.purpose === 'chat-cleanup-summary' ? '"Summary: Fixed the login bug; PR merged."\nextra' : '- Login fix merged in PR 7' },
    prs: async links => Object.fromEntries(links.map(link => [link, link.endsWith('/9') ? { state: 'open', title: 'x' } : { state: 'merged', title: 'Fix' }])),
    wikiReady: async profile => profile === 'default',
    wikiCapture: async (profile, title, content) => { captured.push({ profile, title, content }); return 'ok' },
    ...over,
  }
  return { base, calls, captured }
}

describe('chat cleanup', () => {
  it('TestChatList_findsPullRequestLinksOncePerChat', () => {
    expect(prLinksIn([{ role: 'user', content: 'https://github.com/o/r/pull/1 and https://github.com/o/r/pull/2' }, { role: 'assistant', content: 'again https://github.com/o/r/pull/1' }]))
      .toEqual(['https://github.com/o/r/pull/2', 'https://github.com/o/r/pull/1'])
    expect(oneLine('"Summary: Done."\nmore')).toBe('Done.')
  })

  it('TestChatList_readsPullRequestStatesPerChat', async () => {
    const { base } = deps()
    const prs = await new ChatCleanupService(base).prs([chat('a'), chat('b'), chat('c')])
    expect(prs.a.map(pr => pr.state)).toEqual(['merged', 'merged'])
    expect(prs.b[0].state).toBe('open')
    expect(prs.c).toBeUndefined()
  })

  it('TestChatList_summarizesWithTheChatsModelAndCaches', async () => {
    const { base, calls } = deps()
    const service = new ChatCleanupService(base)
    expect(await service.summaries([chat('a'), chat('c', { provider: '', model: '' }), chat('empty')])).toEqual({ a: 'Fixed the login bug; PR merged.', c: 'Fixed the login bug; PR merged.' })
    expect(calls.map(call => call.model)).toEqual(['m', 'default-model'])
    await service.summaries([chat('a')])
    expect(calls).toHaveLength(2)
    await service.summaries([chat('a', { messageCount: 5 })])
    expect(calls).toHaveLength(3)
  })

  it('TestChatList_savesKeyFactsToTheProfilesWiki', async () => {
    const { base, captured } = deps()
    const out = await new ChatCleanupService(base).saveToWiki([chat('a'), chat('empty'), chat('c', { profile: 'nowiki' })])
    expect(out.saved).toEqual(['a'])
    expect(out.skipped).toEqual(['empty'])
    expect(out.errors.map(error => error.id)).toEqual(['c'])
    expect(captured[0]).toMatchObject({ profile: 'default', title: 'Chat: a' })
    expect(captured[0].content).toContain('- Login fix merged in PR 7')
  })

  it('TestChatList_wikiNothingWorthKeepingSavesNothing', async () => {
    const { base, captured } = deps({ ask: async () => 'NOTHING' })
    const out = await new ChatCleanupService(base).saveToWiki([chat('a')])
    expect(out).toEqual({ saved: [], skipped: ['a'], errors: [] })
    expect(captured).toHaveLength(0)
  })
})
