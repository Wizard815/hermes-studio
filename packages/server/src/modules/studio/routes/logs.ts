import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/logs'

export const logRoutes = new Router()

logRoutes.get('/api/studio/logs', requireSuperAdmin, ctrl.list)
logRoutes.get('/api/studio/logs/:name', requireSuperAdmin, ctrl.read)
