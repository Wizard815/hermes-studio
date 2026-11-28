import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/projects'
import * as commitCtrl from '../controllers/project-commits'

/**
 * Projects: a coordinator chat and the threads it starts in herdr (see
 * docs/projects.md). Threads run agents on the Studio host through herdr,
 * so projects are super-admin only, like herdr itself.
 */
export const projectRoutes = new Router()

projectRoutes.get('/api/studio/projects', requireSuperAdmin, ctrl.list)
projectRoutes.post('/api/studio/projects', requireSuperAdmin, ctrl.create)
projectRoutes.get('/api/studio/projects/for-session/:sessionId', requireSuperAdmin, ctrl.forSession)
projectRoutes.post('/api/studio/projects/tool/:action', requireSuperAdmin, ctrl.tool)
projectRoutes.get('/api/studio/projects/:id', requireSuperAdmin, ctrl.get)
projectRoutes.put('/api/studio/projects/:id', requireSuperAdmin, ctrl.update)
projectRoutes.delete('/api/studio/projects/:id', requireSuperAdmin, ctrl.remove)
projectRoutes.post('/api/studio/projects/:id/threads', requireSuperAdmin, ctrl.startThread)
projectRoutes.post('/api/studio/projects/:id/chats', requireSuperAdmin, ctrl.adoptChat)
projectRoutes.get('/api/studio/projects/:id/threads/:threadId', requireSuperAdmin, ctrl.readThread)
projectRoutes.post('/api/studio/projects/:id/threads/:threadId/message', requireSuperAdmin, ctrl.messageThread)
projectRoutes.put('/api/studio/projects/:id/threads/:threadId/resolved', requireSuperAdmin, ctrl.resolveThread)
projectRoutes.delete('/api/studio/projects/:id/threads/:threadId', requireSuperAdmin, ctrl.releaseThread)
projectRoutes.put('/api/studio/projects/:id/threads/:threadId/pr', requireSuperAdmin, ctrl.setThreadPr)
projectRoutes.post('/api/studio/projects/:id/tasks', requireSuperAdmin, ctrl.addTask)
projectRoutes.post('/api/studio/projects/:id/memory', requireSuperAdmin, ctrl.remember)
projectRoutes.get('/api/studio/projects/:id/prs', requireSuperAdmin, ctrl.prStatuses)
projectRoutes.post('/api/studio/projects/:id/artifacts', requireSuperAdmin, ctrl.addArtifact)
projectRoutes.delete('/api/studio/projects/:id/artifacts/:artifactId', requireSuperAdmin, ctrl.removeArtifact)
projectRoutes.delete('/api/studio/projects/:id/memory/:memoryId', requireSuperAdmin, ctrl.forget)
projectRoutes.put('/api/studio/projects/:id/tasks/:taskId', requireSuperAdmin, ctrl.updateTask)
projectRoutes.delete('/api/studio/projects/:id/tasks/:taskId', requireSuperAdmin, ctrl.removeTask)
projectRoutes.post('/api/studio/projects/:id/tasks/:taskId/start', requireSuperAdmin, ctrl.startTask)
// Commits per thread branch and board PR, and a caveman summary of one (docs/project-commits.md).
projectRoutes.get('/api/studio/projects/:id/commits', requireSuperAdmin, commitCtrl.list)
projectRoutes.get('/api/studio/projects/:id/commits/:sha/summary', requireSuperAdmin, commitCtrl.summary)
