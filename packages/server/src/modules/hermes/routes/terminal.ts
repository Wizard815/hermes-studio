import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/terminal'

export const terminalRoutes = new Router()

// Persistent UI terminal (tmux) access for API clients and the agent.
terminalRoutes.get('/api/hermes/terminal/sessions', requireSuperAdmin, ctrl.listSessions)
terminalRoutes.post('/api/hermes/terminal/read', requireSuperAdmin, ctrl.readSession)
terminalRoutes.post('/api/hermes/terminal/write', requireSuperAdmin, ctrl.writeSession)
terminalRoutes.post('/api/hermes/terminal/close', requireSuperAdmin, ctrl.closeSession)