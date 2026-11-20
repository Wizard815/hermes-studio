import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/plugins'

export const pluginRoutes = new Router()

pluginRoutes.get('/api/hermes/plugins', ctrl.list)
pluginRoutes.get('/api/hermes/plugins/recommended', ctrl.recommended)
pluginRoutes.put('/api/hermes/plugins/recommended', requireSuperAdmin, ctrl.setRecommended)
pluginRoutes.post('/api/hermes/plugins/:key/enable', ctrl.enable)
pluginRoutes.post('/api/hermes/plugins/:key/disable', ctrl.disable)
