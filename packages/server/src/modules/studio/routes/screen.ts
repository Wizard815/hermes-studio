import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/screen'

/**
 * The agents' screen (Hermes Bot Screen): a desktop with a real browser that
 * agents use and you can watch and take over. Super administrators only.
 */
export const screenRoutes = new Router()

screenRoutes.get('/api/studio/screen', requireSuperAdmin, ctrl.status)
screenRoutes.post('/api/studio/screen/install', requireSuperAdmin, ctrl.install)
screenRoutes.post('/api/studio/screen/start', requireSuperAdmin, ctrl.start)
screenRoutes.post('/api/studio/screen/stop', requireSuperAdmin, ctrl.stop)
screenRoutes.post('/api/studio/screen/ticket', requireSuperAdmin, ctrl.ticket)
screenRoutes.post('/api/studio/screen/control', requireSuperAdmin, ctrl.control)
// Agents record their browser actions with their own run credentials.
screenRoutes.post('/api/studio/screen/activity', ctrl.recordActivity)
screenRoutes.get('/api/studio/screen/activity', requireSuperAdmin, ctrl.listActivity)
// Saved logins (Hermes's vault): manage them, and let agents fill them.
screenRoutes.get('/api/studio/screen/vault', requireSuperAdmin, ctrl.listVault)
screenRoutes.post('/api/studio/screen/vault', requireSuperAdmin, ctrl.addVaultItem)
screenRoutes.delete('/api/studio/screen/vault/:id', requireSuperAdmin, ctrl.removeVaultItem)
screenRoutes.post('/api/studio/screen/vault/fill', requireSuperAdmin, ctrl.fillVaultItem)
