import Router from '@koa/router'
import * as ctrl from '../controllers/chat-import'
import { requireSuperAdmin } from '../public/auth'

/** Import chats from other agents (docs/chat-import.md): super admins only. */
export const chatImportRoutes = new Router()

chatImportRoutes.post('/api/studio/chat-import/scan', requireSuperAdmin, ctrl.scanPath)
chatImportRoutes.put('/api/studio/chat-import/upload', requireSuperAdmin, ctrl.scanUpload)
chatImportRoutes.get('/api/studio/chat-import/scans/:id', requireSuperAdmin, ctrl.getScan)
chatImportRoutes.delete('/api/studio/chat-import/scans/:id', requireSuperAdmin, ctrl.discardScan)
chatImportRoutes.post('/api/studio/chat-import/scans/:id/import', requireSuperAdmin, ctrl.startImport)
chatImportRoutes.get('/api/studio/chat-import/jobs/:id', requireSuperAdmin, ctrl.getJob)
