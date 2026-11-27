import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/ui-skills'

/** UI skills (bundled), docs/ui-skills.md. */
export const uiSkillsRoutes = new Router()

uiSkillsRoutes.get('/api/studio/ui-skills', ctrl.status)
uiSkillsRoutes.put('/api/studio/ui-skills', requireSuperAdmin, ctrl.setEnabled)

/** Homelab skills (bundled), docs/homelab-skills.md: the skills and where each one is. */
uiSkillsRoutes.get('/api/studio/homelab-skills', ctrl.homelabStatus)
