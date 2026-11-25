import Router from '@koa/router'
import { requireAdmin, requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/omi'

/**
 * Omi (Connections → Omi, docs/omi.md). Settings, keys, the results webhook
 * and the Hermes skill are super-admin only. Omi's key reaches only /work,
 * /approvals (and the Orb work path and Agent work approve/reject), which the
 * auth middleware enforces (services/omi/scope.ts).
 */
export const omiRoutes = new Router()

omiRoutes.get('/api/studio/omi', requireSuperAdmin, ctrl.status)
omiRoutes.put('/api/studio/omi/settings', requireSuperAdmin, ctrl.saveSettings)
omiRoutes.post('/api/studio/omi/test', requireSuperAdmin, ctrl.test)
omiRoutes.post('/api/studio/omi/keys', requireSuperAdmin, ctrl.createKey)
omiRoutes.delete('/api/studio/omi/keys/:id', requireSuperAdmin, ctrl.revokeKey)
omiRoutes.post('/api/studio/omi/webhook', requireSuperAdmin, ctrl.registerWebhook)
omiRoutes.delete('/api/studio/omi/webhook', requireSuperAdmin, ctrl.removeWebhook)
omiRoutes.post('/api/studio/omi/hermes-skill', requireSuperAdmin, ctrl.installSkill)
omiRoutes.get('/api/studio/omi/work', requireAdmin, ctrl.listWork)
omiRoutes.post('/api/studio/omi/work', requireAdmin, ctrl.startWork)
omiRoutes.get('/api/studio/omi/approvals', requireAdmin, ctrl.approvals)
