import { expect, it, vi } from 'vitest'

const endpoint = (id: string) => ({
  id, name: id, url: `http://127.0.0.1:9/${id}`, secret: 's', event_types: ['chat.run.completed'], profiles: [],
  enabled: true, include_content: true, include_user_content: false, allow_private_network: true, max_retries: 0, created_at: 0, updated_at: 0,
})
vi.mock('../../packages/server/src/modules/studio/public/chat-webhooks', () => ({
  listChatWebhookEndpoints: () => [endpoint('omi'), endpoint('everything')],
}))

const { ChatWebhookDispatcher, setChatWebhookEndpointFilter } = await import('../../packages/server/src/modules/studio/services/webhooks/dispatcher')

it("sends a filtered endpoint only the events its filter keeps (Omi's chats)", async () => {
  const posted: string[] = []
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    posted.push(`${new URL(url).pathname}:${JSON.parse(init.body).subject.session_id}`)
    return new Response('', { status: 200 })
  })
  const dispatcher = new ChatWebhookDispatcher({ fetchImpl: fetchImpl as any })
  setChatWebhookEndpointFilter('omi', event => event.subject.session_id === 'omi-chat')
  dispatcher.start()
  const event = (session: string) => ({
    id: `e-${session}`, type: 'chat.run.completed' as const, occurred_at: new Date(0).toISOString(), profile: 'default',
    source: 'chat' as const, subject: { session_id: session }, summary: { status: 'completed' as const }, content: 'Done',
  })
  dispatcher.enqueue(event('omi-chat'))
  dispatcher.enqueue(event('private-chat'))
  await vi.waitFor(() => expect(posted).toHaveLength(3))
  expect(posted.sort()).toEqual(['/everything:omi-chat', '/everything:private-chat', '/omi:omi-chat'])
  dispatcher.stop()
  setChatWebhookEndpointFilter('omi', null)
})
