import Router from '@koa/router'
import * as ctrl from '../controllers/forge-settings'
import { requireSuperAdmin } from '../public/auth'

/** Settings → Git forges (docs/forge.md): GitHub or the homelab forge. Super admins only. */
export const forgeSettingsRoutes = new Router()

forgeSettingsRoutes.get('/api/studio/forge/settings', requireSuperAdmin, ctrl.read)
forgeSettingsRoutes.put('/api/studio/forge/settings', requireSuperAdmin, ctrl.save)
forgeSettingsRoutes.post('/api/studio/forge/test', requireSuperAdmin, ctrl.test)
