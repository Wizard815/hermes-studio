import { describe, expect, it } from 'vitest'
import { chatAgentLabel, chatSpaceLabel, chatSpaceOrder, planChatSpaces, type ChatSpaceChat } from '../../packages/server/src/modules/coding-agents/services/herdr/chat-spaces'

const chat = (id: string, title: string, folderPath: string[] = [], lastActive = 1, extra: Partial<ChatSpaceChat> = {}): ChatSpaceChat =>
  ({ id, title, folderPath, agent: 'claude-code', hostable: true, workspace: null, lastActive, ...extra })

describe('every Studio chat is a herdr space', () => {
  it('names a space after its chat only', () => {
    expect(chatSpaceLabel(chat('a', 'Build the pricing page', ['Clients', 'site']))).toBe('Build the pricing page')
    expect(chatSpaceLabel(chat('b', '  Loose   idea '))).toBe('Loose idea')
    expect(chatSpaceLabel(chat('c', ''))).toBe('Chat')
    const long = chatSpaceLabel(chat('d', 'x'.repeat(100)))
    expect(long).toHaveLength(72)
    expect(long.endsWith('…')).toBe(true)
  })

  it('orders spaces like Studio\'s folder tree: folders (subfolders first), then loose chats, newest first', () => {
    const ordered = chatSpaceOrder([
      chat('loose-old', 'Loose old', [], 1), chat('loose-new', 'Loose new', [], 9),
      chat('site', 'Site chat', ['Clients', 'site'], 2), chat('clients', 'Clients chat', ['Clients'], 5),
      chat('api', 'API chat', ['Clients', 'api'], 3), chat('home', 'Home chat', ['Home'], 4),
    ])
    expect(ordered.map(c => c.id)).toEqual(['api', 'site', 'clients', 'home', 'loose-new', 'loose-old'])
  })

  it('creates spaces for chats without one, renames moved or renamed chats, closes spaces of deleted chats', () => {
    const plan = planChatSpaces({
      chats: [chat('kept', 'Renamed chat', ['Clients']), chat('new', 'Brand new'), chat('live', 'Started in herdr', ['Home'])],
      records: {
        kept: { workspaceId: 'w1', stubPaneId: 'w1:p1', label: 'Old title', hostable: true },
        deleted: { workspaceId: 'w2', stubPaneId: 'w2:p1', label: 'Deleted', hostable: true },
        gone: { workspaceId: 'w9', stubPaneId: 'w9:p1', label: 'herdr restarted', hostable: true },
        runningDeleted: { workspaceId: 'w3', stubPaneId: 'w3:p1', label: 'Still running', hostable: true },
      },
      workspaces: new Set(['w1', 'w2', 'w3', 'w4']),
      live: new Map([['live', 'w4'], ['runningDeleted', 'w3']]),
    })
    expect(plan.create.map(c => c.id)).toEqual(['new'])
    expect(plan.rename).toEqual([{ workspaceId: 'w1', label: 'Renamed chat' }, { workspaceId: 'w4', label: 'Started in herdr' }])
    expect(plan.close).toEqual([{ sessionId: 'deleted', workspaceId: 'w2' }])
    // A deleted chat whose agent is still running keeps its space; a space herdr lost is forgotten.
    expect(plan.forget.sort()).toEqual(['gone', 'runningDeleted'])
    expect(plan.order).toEqual(['w1', 'w4'])
  })

  it('leaves everything alone when herdr already matches Studio', () => {
    const plan = planChatSpaces({
      chats: [chat('a', 'Pricing', ['Clients'])],
      records: { a: { workspaceId: 'w1', stubPaneId: 'w1:p1', label: 'Pricing', hostable: true } },
      workspaces: new Set(['w1']),
      live: new Map(),
    })
    expect(plan).toEqual({ create: [], rename: [], close: [], forget: [], order: ['w1'] })
  })

  it('lists chats herdr cannot run itself under an agent name herdr knows', () => {
    expect(chatAgentLabel('ekko-agent')).toBe('hermes')
    expect(chatAgentLabel('hermes')).toBe('hermes')
    expect(chatAgentLabel('')).toBe('hermes')
  })

  it('makes a waiting pane again when its chat changes how it runs (the hermes CLI came or went)', () => {
    const plan = planChatSpaces({
      chats: [chat('h', 'Notes', [], 1, { agent: 'hermes', hostable: false })],
      records: { h: { workspaceId: 'w1', stubPaneId: 'w1:p1', label: 'Notes', hostable: true } },
      workspaces: new Set(['w1']),
      live: new Map(),
    })
    expect(plan.close).toEqual([{ sessionId: 'h', workspaceId: 'w1' }])
    expect(plan.create.map(item => item.id)).toEqual(['h'])
  })

  it('does not take a new herdr\'s spaces for old chats when herdr started over and reuses ids', () => {
    const plan = planChatSpaces({
      chats: [chat('a', 'Pricing')],
      records: { a: { workspaceId: 'w1', stubPaneId: 'w1:p2', label: 'Pricing', hostable: true } },
      workspaces: new Set(['w1']),
      panes: new Map([['w1:p1', 'w1']]),
      live: new Map(),
    })
    expect(plan.forget).toEqual(['a'])
    expect(plan.create.map(item => item.id)).toEqual(['a'])
  })
})
