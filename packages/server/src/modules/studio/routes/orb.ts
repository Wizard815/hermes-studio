import Router from '@koa/router'
import { requireAdmin, requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/orb'

/**
 * Pondering Orb (homelab dashboard) for the Mission view and Studio's MCP.
 * Settings are super-admin only; data and tools are open to admins so agents
 * running under an admin's credentials can read plans and add tasks.
 */
export const orbRoutes = new Router()

orbRoutes.get('/api/studio/orb', requireSuperAdmin, ctrl.status)
orbRoutes.put('/api/studio/orb/settings', requireSuperAdmin, ctrl.saveSettings)
orbRoutes.get('/api/studio/orb/data/:kind', requireAdmin, ctrl.data)
orbRoutes.post('/api/studio/orb/tools/:name', requireAdmin, ctrl.tool)
