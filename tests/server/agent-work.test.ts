import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AgentWorkStore } from '../../packages/server/src/modules/studio/services/agent-work/store'
import { AgentWorkService, type SettingsPort } from '../../packages/server/src/modules/studio/services/agent-work/service'
import { normalizeAgentWorkSettings, type AgentWorkSettings } from '../../packages/server/src/modules/studio/services/agent-work/settings'
import type { MattermostPort } from '../../packages/server/src/modules/studio/services/agent-work/mattermost'
import { composeStatusMessage, decisionFromReactions } from '../../packages/server/src/modules/studio/services/agent-work/mattermost'
import { buildDigest, setSection, ObsidianWiki } from '../../packages/server/src/modules/studio/services/agent-work/wiki'
import { AllGlanceMcp, parseMcpBody } from '../../packages/server/src/modules/studio/services/agent-work/allglance'

/** A Mattermost that records posts and knows a few channels and users. */
class FakeMattermost implements MattermostPort {
  posts: Array<{ id: string; channelId: string; message: string; props?: any }> = []
  patches: Array<{ id: string; message: string; props?: any }> = []
  reactionsByPost = new Map<string, Array<{ user_id: string; emoji_name: string }>>()
  channels: Record<string, string> = { hermes: 'ch-hermes', 'agent-work': 'ch-agent-work' }
  users: Record<string, string> = { wizard: 'u-wizard', robin: 'u-robin', other: 'u-other' }
  async botUserId() { return 'u-bot' }
  async createPost(channelId: string, message: string, props?: Record<string, unknown>) {
    const id = `post-${this.posts.length + 1}`
    this.posts.push({ id, channelId, message, props })
    return { id }
  }
  async patchPost(id: string, message: string, props?: Record<string, unknown>) { this.patches.push({ id, message, props }) }
  async reactions(id: string) { return this.reactionsByPost.get(id) || [] }
  async findChannel(name: string, teamId?: string) { return this.channels[name] ? { id: this.channels[name], teamId: teamId || 'team-1', name } : null }
  async userIds(names: string[]) { return Object.fromEntries(names.filter(n => this.users[n]).map(n => [n, this.users[n]])) }
}

class MemorySettings implements SettingsPort {
  value: AgentWorkSettings
  constructor(raw: any = {}) { this.value = normalizeAgentWorkSettings(raw) }
  async load() { return structuredClone(this.value) }
  async save(next: AgentWorkSettings) {
    const merged = normalizeAgentWorkSettings(next)
    if (!merged.allglance.token) merged.allglance.token = this.value.allglance.token
    if (!merged.wiki.token) merged.wiki.token = this.value.wiki.token
    this.value = merged
    return this.publicSettings()
  }
  async publicSettings() {
    const s = this.value
    return { shareToOrb: s.shareToOrb, mattermost: s.mattermost, allglance: { url: s.allglance.url, hasToken: !!s.allglance.token, fromEnv: false }, wiki: { url: s.wiki.url, hasToken: !!s.wiki.token, folder: s.wiki.folder, section: s.wiki.section } }
  }
}

function setup(settings: any = {}) {
  const mm = new FakeMattermost()
  const store = new AgentWorkStore(new DatabaseSync(':memory:'))
  const orb = { connected: vi.fn(async () => true), activity: vi.fn(async () => undefined), approval: vi.fn(async () => undefined) }
  const allglance = { configured: vi.fn(async () => true), completeTask: vi.fn(async (_id: string) => undefined) }
  const wiki = { configured: vi.fn(async () => true), writeSection: vi.fn(async (day: string) => ({ path: `daily/${day}.md` })) }
  const memory = new MemorySettings({
    mattermost: { channel: 'hermes', channelId: 'ch-hermes', teamId: 'team-1', mention: ['wizard'], actionUrl: 'http://studio:8648' },
    ...settings,
  })
  const service = new AgentWorkService({
    store, settings: memory, mattermost: mm, orb, allglance, wiki,
    setupRecord: () => ({ teamId: 'team-1', userId: 'u-wizard' }),
  })
  return { service, store, mm, orb, allglance, wiki, memory }
}

async function awaiting(service: AgentWorkService, vikunjaTaskId = '42') {
  const work = await service.create({ title: 'Rotate the backup keys', vikunjaTaskId, agent: 'hermes' }, 'hermes')
  await service.setStatus(work.id, { status: 'awaiting_approval', summary: 'Keys rotated; please check.' }, 'hermes')
  return work
}

describe('agent work: Mattermost posts', () => {
  it('#blocked posts @mention the saved usernames; #done posts mention nobody', async () => {
    const { service, mm } = setup({ mattermost: { channel: 'hermes', channelId: 'ch-hermes', mention: ['wizard', 'robin'] } })
    const work = await service.create({ title: 'Fix the NAS share', vikunjaTaskId: '7', agent: 'claude-code' })
    await service.setStatus(work.id, { status: 'blocked', summary: 'Need the admin password' })
    await service.setStatus(work.id, { status: 'done' })
    const blocked = mm.posts.find(p => p.message.includes('#blocked'))!
    const done = mm.posts.find(p => p.message.includes('#done'))!
    expect(blocked.channelId).toBe('ch-hermes')
    expect(blocked.message).toContain('@wizard @robin')
    expect(blocked.message).toContain('#agentwork')
    expect(done.message).not.toContain('@')
  })

  it('an empty mention list means #blocked has no @ at all', async () => {
    const { service, mm } = setup({ mattermost: { channel: 'hermes', channelId: 'ch-hermes', mention: [] } })
    const work = await service.create({ title: 'Fix the NAS share' })
    await service.setStatus(work.id, { status: 'blocked', summary: 'Need help' })
    const blocked = mm.posts.find(p => p.message.includes('#blocked'))!
    expect(blocked.message).not.toContain('@')
  })

  it('no channel saved means nothing is posted (nothing is hardcoded)', async () => {
    const { service, mm } = setup({ mattermost: { channel: '', mention: ['wizard'] } })
    const work = await service.create({ title: 'Quiet work' })
    await service.setStatus(work.id, { status: 'blocked' })
    expect(mm.posts).toHaveLength(0)
  })

  it('a run limit alert is a #agentlimit #blocked post with the mentions, and nothing without a channel', async () => {
    const { service, mm } = setup()
    expect(await service.alertBlocked('Fix the flaky login test', 'Run stopped by Studio: loop detected.\n`Read({})`')).toBe(true)
    expect(mm.posts).toHaveLength(1)
    expect(mm.posts[0].channelId).toBe('ch-hermes')
    expect(mm.posts[0].message).toContain('#agentlimit #blocked @wizard **Fix the flaky login test**')
    expect(mm.posts[0].message).toContain('> `Read({})`')
    const quiet = setup({ mattermost: { channel: '', mention: ['wizard'] } })
    expect(await quiet.service.alertBlocked('Quiet chat', 'Run stopped')).toBe(false)
    expect(quiet.mm.posts).toHaveLength(0)
  })

  it('a changed channel is checked in Mattermost and the next post goes there', async () => {
    const { service, mm } = setup()
    const work = await service.create({ title: 'Move the logs' })
    expect(mm.posts.at(-1)!.channelId).toBe('ch-hermes')
    await expect(service.saveSettings({ mattermost: { channel: 'no-such-channel' } })).rejects.toThrow(/no channel called ~no-such-channel/)
    await service.saveSettings({ mattermost: { channel: '~agent-work' } })
    await service.setStatus(work.id, { status: 'working' })
    expect(mm.posts.at(-1)!.channelId).toBe('ch-agent-work')
  })

  it('mention usernames are checked and can be cleared', async () => {
    const { service, memory } = setup()
    await expect(service.saveSettings({ mattermost: { mention: '@ghost' } })).rejects.toThrow(/no user @ghost/)
    await service.saveSettings({ mattermost: { mention: '@robin, other' } })
    expect(memory.value.mattermost.mention).toEqual(['robin', 'other'])
    await service.saveSettings({ mattermost: { mention: '' } })
    expect(memory.value.mattermost.mention).toEqual([])
  })

  it('composes approval requests with buttons only when Studio has an address for Mattermost', async () => {
    const { service, mm } = setup()
    await awaiting(service)
    const post = mm.posts.find(p => p.message.includes('#approval'))!
    expect(post.message).toContain('@wizard')
    expect(post.props.attachments[0].actions.map((a: any) => a.id)).toEqual(['approve', 'reject'])
    expect(post.props.attachments[0].actions[0].integration.url).toBe('http://studio:8648/api/studio/agent-work/mattermost/action')
  })
})

describe('agent work: approvals in Studio, Mattermost and Orb', () => {
  it('approving in Mattermost marks it approved everywhere, clears the alerts and closes the Vikunja task', async () => {
    const { service, store, mm, orb, allglance } = setup({ shareToOrb: true })
    const work = await awaiting(service)
    const button = mm.posts.find(p => p.message.includes('#approval'))!.props.attachments[0].actions[0]
    const answer = await service.mattermostAction({ user_id: 'u-wizard', user_name: 'wizard', context: button.integration.context })
    expect(answer.update?.message).toMatch(/approved in Mattermost by wizard/)
    const after = store.get(work.id)!
    expect(after).toMatchObject({ status: 'done', decision: 'approved', decidedVia: 'mattermost', decidedBy: 'wizard' })
    // Mattermost's approval post stops alerting (no buttons).
    expect(mm.patches).toHaveLength(1)
    expect(mm.patches[0].props).toEqual({ attachments: [] })
    // Orb's alert is cleared.
    expect(orb.approval.mock.calls.at(-1)![0]).toMatchObject({ id: work.id, decision: 'approved' })
    // Vikunja task done through ALLGlance.
    expect(allglance.completeTask).toHaveBeenCalledTimes(1)
    expect(allglance.completeTask).toHaveBeenCalledWith('42')
    expect(after.vikunjaDoneAt).toBeGreaterThan(0)
  })

  it('a second approval from Orb or Studio is a no-op, not an error', async () => {
    const { service, mm, orb, allglance } = setup({ shareToOrb: true })
    const work = await awaiting(service)
    const first = await service.decide(work.id, 'approve', 'orb', 'wizard')
    expect(first.changed).toBe(true)
    const orbCalls = orb.approval.mock.calls.length
    const fromStudio = await service.decide(work.id, 'approve', 'studio', 'admin')
    const fromOrbAgain = await service.decide(work.id, 'approve', 'orb', 'wizard')
    const rejectLate = await service.decide(work.id, 'reject', 'studio', 'admin')
    for (const r of [fromStudio, fromOrbAgain, rejectLate]) {
      expect(r.changed).toBe(false)
      expect(r.message).toMatch(/Already approved in Pondering Orb/)
      expect(r.work.decision).toBe('approved')
    }
    expect(allglance.completeTask).toHaveBeenCalledTimes(1)
    expect(mm.patches).toHaveLength(1)
    expect(orb.approval.mock.calls.length).toBe(orbCalls)
  })

  it('approvals racing from all three places decide once', async () => {
    const { service, allglance } = setup()
    const work = await awaiting(service)
    const results = await Promise.all([
      service.decide(work.id, 'approve', 'studio', 'a'),
      service.decide(work.id, 'approve', 'mattermost', 'b'),
      service.decide(work.id, 'approve', 'orb', 'c'),
    ])
    expect(results.filter(r => r.changed)).toHaveLength(1)
    expect(allglance.completeTask).toHaveBeenCalledTimes(1)
  })

  it('rejecting leaves the Vikunja task open', async () => {
    const { service, store, allglance, mm } = setup()
    const work = await awaiting(service)
    const r = await service.decide(work.id, 'reject', 'studio', 'admin')
    expect(r.changed).toBe(true)
    expect(store.get(work.id)!.status).toBe('rejected')
    expect(allglance.completeTask).not.toHaveBeenCalled()
    expect(mm.patches[0].message).toMatch(/rejected in Studio/)
  })

  it('a ✅ reaction from the right person approves; the bot and strangers are ignored', async () => {
    const { service, store, mm } = setup()
    const work = await awaiting(service)
    const post = mm.posts.find(p => p.message.includes('#approval'))!
    mm.reactionsByPost.set(post.id, [{ user_id: 'u-bot', emoji_name: 'white_check_mark' }, { user_id: 'u-other', emoji_name: 'white_check_mark' }])
    expect(await service.pollMattermostReactions()).toBe(0)
    mm.reactionsByPost.set(post.id, [{ user_id: 'u-wizard', emoji_name: 'white_check_mark' }])
    expect(await service.pollMattermostReactions()).toBe(1)
    expect(store.get(work.id)).toMatchObject({ decision: 'approved', decidedVia: 'mattermost' })
    expect(await service.pollMattermostReactions()).toBe(0)
  })

  it('refuses a button whose secret does not match', async () => {
    const { service } = setup()
    const work = await awaiting(service)
    await expect(service.mattermostAction({ user_id: 'u-wizard', context: { work_id: work.id, token: 'x'.repeat(48), decision: 'approve' } })).rejects.toThrow(/not valid/)
  })

  it('cannot approve work that is not awaiting approval', async () => {
    const { service } = setup()
    const work = await service.create({ title: 'Still going', status: 'working' })
    await expect(service.decide(work.id, 'approve', 'studio')).rejects.toThrow(/not awaiting approval/)
  })

  it('keeps trying to close the Vikunja task when ALLGlance was down', async () => {
    const { service, store, allglance } = setup()
    allglance.completeTask.mockRejectedValueOnce(new Error('ALLGlance is unreachable'))
    const work = await awaiting(service)
    await service.decide(work.id, 'approve', 'studio', 'admin')
    expect(store.get(work.id)!.vikunjaDoneAt).toBe(0)
    expect(store.activity({ workId: work.id }).some(a => a.kind === 'vikunja_failed')).toBe(true)
    expect(await service.retryVikunja()).toBe(1)
    expect(store.get(work.id)!.vikunjaDoneAt).toBeGreaterThan(0)
    expect(allglance.completeTask).toHaveBeenCalledTimes(2)
  })
})

describe('agent work: sharing with Pondering Orb', () => {
  it('shares nothing with Orb while the switch is off', async () => {
    const { service, orb } = setup({ shareToOrb: false })
    const work = await awaiting(service)
    await service.setStatus((await service.create({ title: 'B' })).id, { status: 'blocked' })
    await service.decide(work.id, 'approve', 'studio', 'admin')
    expect(orb.connected).not.toHaveBeenCalled()
    expect(orb.activity).not.toHaveBeenCalled()
    expect(orb.approval).not.toHaveBeenCalled()
  })

  it('shares activity and opens then clears the approval alert when the switch is on', async () => {
    const { service, orb } = setup({ shareToOrb: true })
    const work = await awaiting(service)
    expect(orb.activity).toHaveBeenCalled()
    expect(orb.approval.mock.calls[0][0]).toMatchObject({ id: work.id, status: 'awaiting_approval' })
    await service.decide(work.id, 'approve', 'studio', 'admin')
    expect(orb.approval.mock.calls.at(-1)![0]).toMatchObject({ id: work.id, decision: 'approved', decidedVia: 'studio' })
  })
})

describe('agent work: daily digest', () => {
  it('lists done, awaiting approval and blocked work', async () => {
    const { service } = setup()
    const a = await awaiting(service, '1')
    await service.decide(a.id, 'approve', 'mattermost', 'wizard')
    await awaiting(service, '2')
    const b = await service.create({ title: 'Upgrade Postgres' })
    await service.setStatus(b.id, { status: 'blocked', summary: 'Needs downtime' })
    const md = service.digest()
    expect(md).toMatch(/### Done\n\n- Rotate the backup keys \(Vikunja #1\) · hermes, approved in Mattermost/)
    expect(md).toMatch(/### Awaiting approval\n\n- Rotate the backup keys \(Vikunja #2\)/)
    expect(md).toMatch(/### Blocked\n\n- Upgrade Postgres: Needs downtime/)
    const written = await service.writeDigest()
    expect(written.written).toBe(true)
  })

  it('rewrites only its own section of the daily note', () => {
    const note = '# 2026-11-17\n\n## Worked on\n\n- a thing (pondering-orb)\n\n## Hermes Studio\n\n- old\n\n## Journal\n\ntext\n'
    const next = setSection(note, 'Hermes Studio', '### Done\n\n- new')
    expect(next).toContain('- a thing (pondering-orb)')
    expect(next).toContain('### Done\n\n- new')
    expect(next).not.toContain('- old')
    expect(next).toContain('## Journal\n\ntext')
    expect(buildDigest('2026-11-17', [], [])).toBe('- No agent work today.')
  })

  it('writes the section through the wiki REST API, creating the note from the DAILY template', async () => {
    const files = new Map<string, string>([['schema/templates/DAILY.md', '# {{date}}\n\n## Worked on\n\n- \n']])
    const fetcher = vi.fn(async (url: string, init: any = {}) => {
      const path = decodeURIComponent(new URL(url).pathname.replace(/^\/vault\//, ''))
      if ((init.method || 'GET') === 'PUT') { files.set(path, String(init.body)); return new Response(null, { status: 204 }) }
      return files.has(path) ? new Response(files.get(path)!, { status: 200 }) : new Response('', { status: 404 })
    })
    const wiki = new ObsidianWiki(async () => ({ url: 'http://wiki:27123', token: 't', folder: 'daily', section: 'Hermes Studio' }), fetcher as any)
    await wiki.writeSection('2026-11-17', '- one')
    await wiki.writeSection('2026-11-17', '- two')
    expect(files.get('daily/2026-11-17.md')).toBe('# 2026-11-17\n\n## Worked on\n\n- \n\n## Hermes Studio\n\n- two\n')
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer t')
  })
})

describe('agent work: ALLGlance', () => {
  it('marks a Vikunja task done with allglance_update_task', async () => {
    const fetcher = vi.fn(async (_url: string, _init: any) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"updated":{"id":"42","done":true}}' }] } })}\n\n`, { status: 200 }))
    const client = new AllGlanceMcp(async () => ({ url: 'http://allglance:8090', token: 'gw' }), fetcher as any)
    await client.completeTask('42')
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('http://allglance:8090/mcp')
    expect(init.headers.Authorization).toBe('Bearer gw')
    expect(JSON.parse(init.body).params).toEqual({ name: 'allglance_update_task', arguments: { source: 'vikunja', id: '42', done: true } })
  })

  it('turns a tool error into a failure', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Vikunja refused' }] } }), { status: 200 }))
    const client = new AllGlanceMcp(async () => ({ url: 'http://allglance:8090', token: '' }), fetcher as any)
    await expect(client.completeTask('1')).rejects.toThrow('Vikunja refused')
    expect(parseMcpBody('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('agent work: pure helpers', () => {
  it('reaction decisions and message text', () => {
    expect(decisionFromReactions([{ user_id: 'u1', emoji_name: 'x' }], 'bot', null)).toEqual({ decision: 'reject', userId: 'u1' })
    const settings = normalizeAgentWorkSettings({ mattermost: { mention: ['wizard'], mentionOnApproval: false } }).mattermost
    const work: any = { id: '1', title: 'T', summary: '', agent: '', vikunjaTaskId: '' }
    expect(composeStatusMessage(work, 'awaiting_approval', settings)).not.toContain('@')
    expect(composeStatusMessage(work, 'blocked', settings)).toContain('@wizard')
  })
})
