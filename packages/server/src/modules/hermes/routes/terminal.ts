import Router from '@koa/router'
import * as ctrl from '../controllers/terminal'

export const terminalRoutes = new Router()

// Persistent UI terminal (tmux) access for API clients and the agent.
terminalRoutes.get('/api/hermes/terminal/sessions', ctrl.listSessions)
terminalRoutes.post('/api/hermes/terminal/read', ctrl.readSession)
terminalRoutes.post('/api/hermes/terminal/write', ctrl.writeSession)
terminalRoutes.post('/api/hermes/terminal/close', ctrl.closeSession)