import Router from '@koa/router'
import * as ctrl from '../controllers/sandbox'
import { requireSuperAdmin } from '../public/auth'

/** Sandboxes (docs/sandbox.md): throwaway containers agents run commands in. Super admins only. */
export const sandboxRoutes = new Router()

sandboxRoutes.get('/api/studio/sandbox', requireSuperAdmin, ctrl.list)
sandboxRoutes.delete('/api/studio/sandbox/:id', requireSuperAdmin, ctrl.remove)
sandboxRoutes.post('/api/studio/sandbox/tool/:action', requireSuperAdmin, ctrl.tool)
