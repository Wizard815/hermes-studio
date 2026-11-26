import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/tool-load'

/** Too many tools for a small model (docs/hermes-tool-load.md). The threshold is super-admin; a chat's notice follows chat access. */
export const toolLoadRoutes = new Router()

toolLoadRoutes.get('/api/studio/tool-load', ctrl.getSettings)
toolLoadRoutes.put('/api/studio/tool-load', requireSuperAdmin, ctrl.saveSettings)
toolLoadRoutes.get('/api/studio/tool-load/chats/:id', ctrl.getChat)
toolLoadRoutes.post('/api/studio/tool-load/chats/:id/dismiss', ctrl.dismissChat)
