import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/llm-wiki'

/**
 * Connections → LLM wiki (docs/llm-wiki.md): the LLM wiki as each Hermes
 * profile's memory provider. Super administrators only: it writes profiles'
 * tokens and memory settings.
 */
export const llmWikiRoutes = new Router()

llmWikiRoutes.get('/api/studio/llm-wiki', requireSuperAdmin, ctrl.status)
llmWikiRoutes.put('/api/studio/llm-wiki/profiles/:profile', requireSuperAdmin, ctrl.saveProfile)
llmWikiRoutes.post('/api/studio/llm-wiki/profiles/:profile/test', requireSuperAdmin, ctrl.testProfile)
