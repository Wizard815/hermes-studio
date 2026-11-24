import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/command-center'

/**
 * Command Center in the herdr page's Tools dock: GitHub (via the server's
 * `gh`), skillshare (via its CLI), agent details and plan limits. These run
 * programs on the Studio host, so they are super-admin only, like herdr.
 */
export const commandCenterRoutes = new Router()

commandCenterRoutes.get('/api/studio/command-center/settings', requireSuperAdmin, ctrl.getSettings)
commandCenterRoutes.put('/api/studio/command-center/settings', requireSuperAdmin, ctrl.saveSettings)
commandCenterRoutes.get('/api/studio/command-center/github', requireSuperAdmin, ctrl.github)
commandCenterRoutes.post('/api/studio/command-center/agents', requireSuperAdmin, ctrl.agents)
commandCenterRoutes.get('/api/studio/command-center/plan-limits', requireSuperAdmin, ctrl.planLimits)
commandCenterRoutes.get('/api/studio/command-center/skillshare', requireSuperAdmin, ctrl.skillshare)
commandCenterRoutes.post('/api/studio/command-center/skillshare/check', requireSuperAdmin, ctrl.skillshareCheck)
commandCenterRoutes.post('/api/studio/command-center/skillshare/sync', requireSuperAdmin, ctrl.skillshareSync)
commandCenterRoutes.post('/api/studio/command-center/skillshare/update', requireSuperAdmin, ctrl.skillshareUpdate)
commandCenterRoutes.post('/api/studio/command-center/skillshare/install', requireSuperAdmin, ctrl.skillshareInstall)
