import Router from '@koa/router'
import { requireAdmin, requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/agent-work'

/**
 * Agent work on Vikunja tasks (Connections → Agent work): the work, its
 * activity log and approvals. Settings are super-admin only. Mattermost's
 * buttons reach the public route, which checks the post's own secret.
 */
export const agentWorkRoutes = new Router()

agentWorkRoutes.get('/api/studio/agent-work', requireAdmin, ctrl.list)
agentWorkRoutes.post('/api/studio/agent-work', requireAdmin, ctrl.create)
agentWorkRoutes.get('/api/studio/agent-work/summary', ctrl.summary)
agentWorkRoutes.get('/api/studio/agent-work/activity', requireAdmin, ctrl.activity)
agentWorkRoutes.get('/api/studio/agent-work/settings', requireSuperAdmin, ctrl.getSettings)
agentWorkRoutes.put('/api/studio/agent-work/settings', requireSuperAdmin, ctrl.saveSettings)
agentWorkRoutes.get('/api/studio/agent-work/digest', requireAdmin, ctrl.digest)
agentWorkRoutes.post('/api/studio/agent-work/digest', requireAdmin, ctrl.writeDigest)
agentWorkRoutes.get('/api/studio/agent-work/:id', requireAdmin, ctrl.get)
agentWorkRoutes.post('/api/studio/agent-work/:id/status', requireAdmin, ctrl.setStatus)
agentWorkRoutes.post('/api/studio/agent-work/:id/approve', requireAdmin, ctrl.approve)
agentWorkRoutes.post('/api/studio/agent-work/:id/reject', requireAdmin, ctrl.reject)

export const agentWorkPublicRoutes = new Router()
agentWorkPublicRoutes.post('/api/studio/agent-work/mattermost/action', ctrl.mattermostAction)
