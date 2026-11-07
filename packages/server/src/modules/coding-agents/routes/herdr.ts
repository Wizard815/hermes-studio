import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/herdr'

/** Herdr drives real shells on this machine: every route is super-admin only. */
export const herdrRoutes = new Router()

herdrRoutes.get('/api/coding-agents/herdr', requireSuperAdmin, ctrl.status)
herdrRoutes.put('/api/coding-agents/herdr/settings', requireSuperAdmin, ctrl.updateSettings)
herdrRoutes.post('/api/coding-agents/herdr/server/start', requireSuperAdmin, ctrl.startServer)
herdrRoutes.post('/api/coding-agents/herdr/integrations', requireSuperAdmin, ctrl.installIntegrations)
herdrRoutes.post('/api/coding-agents/herdr/plugin-install', requireSuperAdmin, ctrl.installPlugin)
herdrRoutes.post('/api/coding-agents/herdr/install', requireSuperAdmin, ctrl.installHerdr)
herdrRoutes.post('/api/coding-agents/herdr/setup', requireSuperAdmin, ctrl.setupHerdr)
herdrRoutes.get('/api/coding-agents/herdr/profiles', requireSuperAdmin, ctrl.profiles)
herdrRoutes.post('/api/coding-agents/herdr/agents', requireSuperAdmin, ctrl.launchAgent)
herdrRoutes.post('/api/coding-agents/herdr/workspaces', requireSuperAdmin, ctrl.createWorkspace)
herdrRoutes.get('/api/coding-agents/herdr/folders', requireSuperAdmin, ctrl.getFolders)
herdrRoutes.put('/api/coding-agents/herdr/folders', requireSuperAdmin, ctrl.saveFolders)
herdrRoutes.post('/api/coding-agents/herdr/panes/:paneId/focus', requireSuperAdmin, ctrl.focusPane)
herdrRoutes.get('/api/coding-agents/herdr/sessions/:sessionId', requireSuperAdmin, ctrl.sessionLink)
herdrRoutes.post('/api/coding-agents/herdr/sessions/:sessionId/open', requireSuperAdmin, ctrl.openSession)
herdrRoutes.post('/api/coding-agents/herdr/sessions/:sessionId/prompt', requireSuperAdmin, ctrl.promptSession)
herdrRoutes.delete('/api/coding-agents/herdr/sessions/:sessionId/pane', requireSuperAdmin, ctrl.closeSessionPane)

/**
 * Called by Studio's plugin inside herdr. Registered before Studio's user auth:
 * each route checks the plugin's own token and accepts loopback requests only.
 */
export const herdrPluginRoutes = new Router({ prefix: '/api/coding-agents/herdr/plugin' })

herdrPluginRoutes.use(ctrl.requirePluginToken)
herdrPluginRoutes.get('/chats', ctrl.pluginChats)
herdrPluginRoutes.get('/link', ctrl.pluginLink)
herdrPluginRoutes.get('/agents', ctrl.pluginAgents)
herdrPluginRoutes.post('/open', ctrl.pluginOpen)
herdrPluginRoutes.post('/launch', ctrl.launchAgent)
herdrPluginRoutes.get('/settings', ctrl.pluginSettings)
herdrPluginRoutes.put('/settings', ctrl.updatePluginSettings)
