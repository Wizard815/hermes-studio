import Router from '@koa/router'
import * as ctrl from '../controllers/browser'

export const browserPublicRoutes = new Router()

// Status / info — public (no auth required) so the client can check availability
browserPublicRoutes.get('/api/studio/browser/status', ctrl.getStatus)
