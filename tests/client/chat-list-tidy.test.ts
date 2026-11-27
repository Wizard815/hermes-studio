import { describe, expect, it } from 'vitest'
import { nestChats, suggestCleanup } from '../../packages/client/src/utils/chat-list-tidy'

const DAY = 86_400_000
const now = 100 * DAY

describe('chat list tidy', () => {
  it('TestChatList_nestedChatsSitUnderTheirParent', () => {
    const list = [
      { id: 'a' },
      { id: 'b', nestedUnder: 'c' },
      { id: 'c' },
      { id: 'd', nestedUnder: 'gone' },
    ]
    expect(nestChats(list).map(row => `${row.nested ? '  ' : ''}${row.chat.id}`)).toEqual(['a', 'c', '  b', 'd'])
  })

  it('TestChatList_cleanupSuggestsEmptyDuplicateAndStaleChats', () => {
    const chats = [
      { id: 'empty', title: 'New chat', messageCount: 1, lastActiveAt: now - 2 * DAY },
      { id: 'fresh-empty', title: 'Hi', messageCount: 0, lastActiveAt: now - 1000 },
      { id: 'old-dup', title: 'Fix login', messageCount: 12, lastActiveAt: now - 10 * DAY },
      { id: 'new-dup', title: 'fix  login', messageCount: 30, lastActiveAt: now - DAY },
      { id: 'stale', title: 'Trip', messageCount: 40, lastActiveAt: now - 40 * DAY },
      { id: 'pinned', title: 'Keep', messageCount: 1, lastActiveAt: now - 90 * DAY, isPinned: true },
      { id: 'project', title: 'Coordinator', messageCount: 1, lastActiveAt: now - 90 * DAY },
      { id: 'busy', title: 'Busy', messageCount: 1, lastActiveAt: now - 90 * DAY },
      { id: 'parent', title: 'Parent', messageCount: 50, lastActiveAt: now - 90 * DAY },
      { id: 'child', title: 'Child', messageCount: 50, lastActiveAt: now - 5 * DAY, nestedUnder: 'parent' },
    ]
    const out = suggestCleanup(chats, { now, keep: new Set(['project']), busy: id => id === 'busy' })
    expect(out.map(item => `${item.reason}:${item.chat.id}`)).toEqual(['empty:empty', 'duplicate:old-dup', 'stale:stale'])
    expect(out[1].keep?.id).toBe('new-dup')
  })

  it('TestChatList_cleanupNeverSuggestsBothCopiesOfADuplicate', () => {
    const chats = [
      { id: 'old', title: 'Fix login', messageCount: 8, lastActiveAt: now - 12 * DAY },
      { id: 'new', title: 'Fix login', messageCount: 1, lastActiveAt: now - 2 * DAY },
    ]
    expect(suggestCleanup(chats, { now }).map(item => `${item.reason}:${item.chat.id}`)).toEqual(['empty:new'])
  })
})
