import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/peers'

/**
 * Paired Studios (docs/projects.md#federation). Pairing and sharing are
 * super-admin only; the federation routes take no login and check the other
 * Studio's device signature instead.
 */
export const peerRoutes = new Router()

peerRoutes.get('/api/studio/peers', requireSuperAdmin, ctrl.list)
peerRoutes.post('/api/studio/peers/code', requireSuperAdmin, ctrl.createCode)
peerRoutes.post('/api/studio/peers/pair', requireSuperAdmin, ctrl.pair)
peerRoutes.put('/api/studio/peers/:peerId', requireSuperAdmin, ctrl.update)
peerRoutes.delete('/api/studio/peers/:peerId', requireSuperAdmin, ctrl.remove)
peerRoutes.get('/api/studio/peers/:peerId/projects', requireSuperAdmin, ctrl.remoteProjects)
peerRoutes.post('/api/studio/peers/:peerId/projects/:projectId/message', requireSuperAdmin, ctrl.remoteMessage)
peerRoutes.post('/api/studio/peers/:peerId/projects/:projectId/tasks', requireSuperAdmin, ctrl.remoteTask)

export const federationPublicRoutes = new Router()

federationPublicRoutes.post('/api/studio/federation/pair', ctrl.federation)
federationPublicRoutes.get('/api/studio/federation/projects', ctrl.federation)
federationPublicRoutes.post('/api/studio/federation/projects/:projectId/message', ctrl.federation)
federationPublicRoutes.post('/api/studio/federation/projects/:projectId/tasks', ctrl.federation)
federationPublicRoutes.delete('/api/studio/federation/peer', ctrl.federation)
