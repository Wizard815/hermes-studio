import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/hermes-api'

/**
 * Hermes Agent's own API through Studio (super administrators): Studio's pages
 * for messaging platforms, memory providers, toolsets, webhooks, MCP catalog,
 * plugins, local models and the rest call /api/hermes-agent/<Hermes API path>.
 */
export const hermesApiRoutes = new Router()

hermesApiRoutes.get('/api/hermes-agent-bridge', requireSuperAdmin, ctrl.status)
hermesApiRoutes.post('/api/hermes-agent-bridge/start', requireSuperAdmin, ctrl.start)
hermesApiRoutes.all('/api/hermes-agent/{*path}', requireSuperAdmin, ctrl.forward)
