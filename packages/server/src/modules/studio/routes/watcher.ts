import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/watcher'

/** The Watcher (docs/watcher.md): super admins see the bell and change Settings → Watcher. */
export const watcherRoutes = new Router()

watcherRoutes.get('/api/studio/watcher/events', requireSuperAdmin, ctrl.listEvents)
watcherRoutes.post('/api/studio/watcher/events/read', requireSuperAdmin, ctrl.markRead)
watcherRoutes.post('/api/studio/watcher/events/clear', requireSuperAdmin, ctrl.clearEvents)
watcherRoutes.get('/api/studio/watcher/settings', requireSuperAdmin, ctrl.getSettings)
watcherRoutes.put('/api/studio/watcher/settings', requireSuperAdmin, ctrl.saveSettings)
watcherRoutes.get('/api/studio/watcher/trust', requireSuperAdmin, ctrl.listRules)
watcherRoutes.post('/api/studio/watcher/trust', requireSuperAdmin, ctrl.addRule)
watcherRoutes.delete('/api/studio/watcher/trust/:id', requireSuperAdmin, ctrl.removeRule)
watcherRoutes.get('/api/studio/watcher/tasks/:id/approval-mode', requireSuperAdmin, ctrl.getTaskMode)
watcherRoutes.put('/api/studio/watcher/tasks/:id/approval-mode', requireSuperAdmin, ctrl.setTaskMode)
