import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/llmwiki'

/**
 * LLMWIKI, the owner's Obsidian memory vault, connected in Connections → LLMWIKI.
 * Super administrators only: it is one person's memory. Agents reach it through
 * Studio's MCP (ekko_studio_use_memory) with their user's credentials.
 */
export const llmWikiRoutes = new Router()

llmWikiRoutes.get('/api/studio/llmwiki', requireSuperAdmin, ctrl.status)
llmWikiRoutes.put('/api/studio/llmwiki/settings', requireSuperAdmin, ctrl.saveSettings)
llmWikiRoutes.post('/api/studio/llmwiki/search', requireSuperAdmin, ctrl.search)
llmWikiRoutes.post('/api/studio/llmwiki/read', requireSuperAdmin, ctrl.read)
llmWikiRoutes.post('/api/studio/llmwiki/note', requireSuperAdmin, ctrl.note)
