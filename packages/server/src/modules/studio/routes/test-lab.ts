import Router from '@koa/router'
import * as ctrl from '../controllers/test-lab'
import { requireSuperAdmin } from '../public/auth'

/** Test Lab (docs/test-lab.md): throwaway app containers and an agent test. Super admins only. */
export const testLabRoutes = new Router()

testLabRoutes.get('/api/studio/test-lab', requireSuperAdmin, ctrl.status)
testLabRoutes.put('/api/studio/test-lab/settings', requireSuperAdmin, ctrl.saveSettings)
testLabRoutes.get('/api/studio/test-lab/runs', requireSuperAdmin, ctrl.listRuns)
testLabRoutes.post('/api/studio/test-lab/runs', requireSuperAdmin, ctrl.startRun)
testLabRoutes.get('/api/studio/test-lab/runs/:id', requireSuperAdmin, ctrl.getRun)
testLabRoutes.post('/api/studio/test-lab/runs/:id/stop', requireSuperAdmin, ctrl.stopRun)
testLabRoutes.delete('/api/studio/test-lab/runs/:id/containers', requireSuperAdmin, ctrl.removeRun)
testLabRoutes.get('/api/studio/test-lab/runs/:id/screenshots/:name', requireSuperAdmin, ctrl.screenshot)
testLabRoutes.get('/api/studio/test-lab/runs/:id/logs/:app', requireSuperAdmin, ctrl.appLog)
testLabRoutes.get('/api/studio/test-lab/runs/:id/download', requireSuperAdmin, ctrl.download)
