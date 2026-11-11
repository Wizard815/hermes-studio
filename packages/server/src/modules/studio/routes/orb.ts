import Router from '@koa/router'
import { requireAdmin, requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/orb'

/**
 * Pondering Orb (homelab dashboard), connected in Connections → Pondering Orb.
 * Settings are super-admin only; data and tools are open to admins so agents
 * running under an admin's credentials can read plans and add tasks. Orb sends
 * work to Studio through /work: a new Studio chat that Studio follows and
 * reports back on.
 */
export const orbRoutes = new Router()

orbRoutes.get('/api/studio/orb', requireSuperAdmin, ctrl.status)
orbRoutes.put('/api/studio/orb/settings', requireSuperAdmin, ctrl.saveSettings)
orbRoutes.get('/api/studio/orb/data/:kind', requireAdmin, ctrl.data)
orbRoutes.post('/api/studio/orb/tools/:name', requireAdmin, ctrl.tool)
orbRoutes.get('/api/studio/orb/work', requireAdmin, ctrl.listWork)
orbRoutes.post('/api/studio/orb/work', requireAdmin, ctrl.startWork)
