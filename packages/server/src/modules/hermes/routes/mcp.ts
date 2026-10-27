import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/mcp'

export const mcpRoutes = new Router()

mcpRoutes.get('/api/hermes/mcp/servers', ctrl.listServers)
mcpRoutes.post('/api/hermes/mcp/servers', requireSuperAdmin, ctrl.addServer)
mcpRoutes.patch('/api/hermes/mcp/servers/:name', requireSuperAdmin, ctrl.updateServer)
mcpRoutes.delete('/api/hermes/mcp/servers/:name', requireSuperAdmin, ctrl.removeServer)
mcpRoutes.post('/api/hermes/mcp/servers/:name/test', requireSuperAdmin, ctrl.testServer)
mcpRoutes.get('/api/hermes/mcp/tools', ctrl.listTools)
mcpRoutes.post('/api/hermes/mcp/reload', requireSuperAdmin, ctrl.reloadMcp)
