import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/plugins'
import * as gadget from '../controllers/gadget'

export const pluginRoutes = new Router()

pluginRoutes.get('/api/hermes/plugins', ctrl.list)
pluginRoutes.get('/api/hermes/plugins/recommended', ctrl.recommended)
pluginRoutes.put('/api/hermes/plugins/recommended', requireSuperAdmin, ctrl.setRecommended)
pluginRoutes.get('/api/hermes/plugins/gadget/status', gadget.status)
pluginRoutes.put('/api/hermes/plugins/gadget/platform', requireSuperAdmin, gadget.update)
pluginRoutes.post('/api/hermes/plugins/:key/enable', ctrl.enable)
pluginRoutes.post('/api/hermes/plugins/:key/disable', ctrl.disable)
