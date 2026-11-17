import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/mattermost-setup'

export const mattermostSetupRoutes = new Router()

mattermostSetupRoutes.get('/api/hermes/mattermost/setup', ctrl.current)
mattermostSetupRoutes.post('/api/hermes/mattermost/setup/inspect', requireSuperAdmin, ctrl.inspect)
mattermostSetupRoutes.post('/api/hermes/mattermost/setup/apply', requireSuperAdmin, ctrl.apply)
