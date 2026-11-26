import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/run-limits'

/** Run limits (docs/agent-limits.md). Settings' limits are super-admin; a chat's own follow chat access. */
export const runLimitRoutes = new Router()

runLimitRoutes.get('/api/studio/run-limits', ctrl.getDefaults)
runLimitRoutes.put('/api/studio/run-limits', requireSuperAdmin, ctrl.saveDefaults)
runLimitRoutes.get('/api/studio/run-limits/chats/:id', ctrl.getChat)
runLimitRoutes.put('/api/studio/run-limits/chats/:id', ctrl.saveChat)
runLimitRoutes.post('/api/studio/run-limits/chats/:id/continue', ctrl.continueChat)
runLimitRoutes.post('/api/studio/run-limits/chats/:id/stop', ctrl.stopChat)
