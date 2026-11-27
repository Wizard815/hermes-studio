import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/repo-pack'

/** Add a repo to a chat (docs/repo-pack.md). Super-admin: it runs repomix on the host and uses the host's GitHub token. */
export const repoPackRoutes = new Router()

repoPackRoutes.get('/api/studio/repo-pack/repos', requireSuperAdmin, ctrl.repos)
repoPackRoutes.post('/api/studio/repo-pack', requireSuperAdmin, ctrl.pack)
