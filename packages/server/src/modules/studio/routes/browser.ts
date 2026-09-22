import Router from '@koa/router'
import * as ctrl from '../controllers/browser'

export const browserRoutes = new Router()

// Browser tab management
browserRoutes.get('/api/studio/browser/state', ctrl.getState)
browserRoutes.post('/api/studio/browser/tabs/create', ctrl.createTab)
browserRoutes.post('/api/studio/browser/tabs/activate', ctrl.activateTab)
browserRoutes.post('/api/studio/browser/tabs/close', ctrl.closeTab)

// Navigation
browserRoutes.post('/api/studio/browser/navigate', ctrl.navigate)
browserRoutes.post('/api/studio/browser/navigation-action', ctrl.navigationAction)

// Content reading
browserRoutes.post('/api/studio/browser/snapshot', ctrl.snapshot)
browserRoutes.post('/api/studio/browser/text-read', ctrl.textRead)

// Interaction
browserRoutes.post('/api/studio/browser/interact', ctrl.interact)

// Screenshot capture
browserRoutes.post('/api/studio/browser/screenshot', ctrl.screenshot)

// Console logs
browserRoutes.post('/api/studio/browser/console-read', ctrl.consoleRead)
browserRoutes.post('/api/studio/browser/console-clear', ctrl.consoleClear)

// Lease management
browserRoutes.post('/api/studio/browser/lease/release', ctrl.releaseLease)

// Status / info (public for diagnostics)
browserRoutes.get('/api/studio/browser/status', ctrl.getStatus)
