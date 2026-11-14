import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/vscode'

/**
 * VS Code (code-server) inside Studio. Super administrators only: VS Code has
 * a terminal and full file access as Studio's user.
 */
export const vscodeRoutes = new Router()

vscodeRoutes.get('/api/vscode', requireSuperAdmin, ctrl.status)
vscodeRoutes.post('/api/vscode/install', requireSuperAdmin, ctrl.install)
vscodeRoutes.post('/api/vscode/session', requireSuperAdmin, ctrl.openSession)
vscodeRoutes.delete('/api/vscode/session/:id', requireSuperAdmin, ctrl.closeSession)
vscodeRoutes.post('/api/vscode/stop', requireSuperAdmin, ctrl.stop)
