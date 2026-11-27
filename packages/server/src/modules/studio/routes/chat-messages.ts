import Router from '@koa/router'
import * as ctrl from '../controllers/chat-messages'

/**
 * Chats messaging each other (docs/chat-messages.md). Any signed-in person's
 * chats can reach their own other chats; the service checks ownership.
 */
export const chatMessageRoutes = new Router()

chatMessageRoutes.post('/api/studio/chats/messages/:action', ctrl.tool)
