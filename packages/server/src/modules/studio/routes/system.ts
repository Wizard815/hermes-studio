import Router from '@koa/router'
import * as ctrl from '../controllers/system'
import { requireSuperAdmin } from '../public/auth'

/** Processes and Docker on the Studio host: every route is super-admin only. */
export const systemRoutes = new Router()

systemRoutes.get('/api/studio/system', requireSuperAdmin, ctrl.snapshot)
systemRoutes.post('/api/studio/system/processes/:pid/signal', requireSuperAdmin, ctrl.signal)
systemRoutes.get('/api/studio/system/docker', requireSuperAdmin, ctrl.dockerStatus)
systemRoutes.post('/api/studio/system/docker/containers/:id/:action', requireSuperAdmin, ctrl.dockerAction)
systemRoutes.get('/api/studio/system/docker/containers/:id/logs', requireSuperAdmin, ctrl.dockerLogs)
