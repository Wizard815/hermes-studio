import { desktopBrowserRoutes } from '../modules/studio/routes/desktop-browser'
import { studioPluginRoutes } from '../modules/studio/routes/plugins'
import './provider-store-adapter'
import './model-gateway-adapter'
import { modelGatewayMiddleware } from '../modules/studio/middleware/model-gateway'
import { providerAccountMiddleware } from '../modules/studio/middleware/provider-account'
import { legacyProviderCredentials } from '../modules/studio/middleware/legacy-provider-credentials'
import './plugin-agent-adapter'
import { studioAgentRoutes } from '../modules/studio/routes/agents'
import type { Context, Next } from 'koa'
import './hermes-ops-adapter'
import './agent-log-adapter'
import './mcu-voice-adapter'
import './workflow-runtime-adapter'
import './chat-agent-runtime-adapter'
import './group-chat-agent-runtime-adapter'
import './session-agent-runtime-adapter'
import './person-runtime-adapter'
import { personRoutes } from '../modules/studio/routes/person'
import { apiDocsRoutes } from '../modules/studio'
import { healthRoutes } from './health'
import { updateRoutes } from './update'
import { themeRoutes } from '../modules/studio/routes/theme'
import { navigationRoutes } from '../modules/studio/routes/navigation'
import { announcementRoutes } from '../modules/studio/routes/announcements'
import { appConnectionRoutes, appRelayRoutes } from './app-relay'
import { socialMessageRoutes } from '../modules/studio/routes/social-messages'
import {
  codingAgentRoutes,
} from './coding-agents'
import { herdrPluginRoutes, herdrRoutes } from '../modules/coding-agents/routes/herdr'

// Studio and agent route modules composed into one HTTP application.
import { uploadRoutes } from '../modules/studio/routes/upload'
import { repoPackRoutes } from '../modules/studio/routes/repo-pack'
import { appUploadRoutes } from '../modules/studio/routes/app-upload'
import { authPublicRoutes, authProtectedRoutes } from '../modules/studio/routes/auth'
import { mcuDevicePublicRoutes, mcuDeviceRoutes } from '../modules/studio/routes/mcu-devices'

import { sessionRoutes } from '../modules/studio/routes/sessions'
import { orbRoutes } from '../modules/studio/routes/orb'
import { omiRoutes } from '../modules/studio/routes/omi'
import { llmWikiRoutes } from '../modules/studio/routes/llm-wiki'
import { androidAppLinkRoutes } from '../modules/studio/routes/android-app-links'
import { agentWorkPublicRoutes, agentWorkRoutes } from '../modules/studio/routes/agent-work'
import { commandCenterRoutes } from '../modules/studio/routes/command-center'
import { projectRoutes } from '../modules/studio/routes/projects'
import { federationPublicRoutes, peerRoutes } from '../modules/studio/routes/peers'
import { runLimitRoutes } from '../modules/studio/routes/run-limits'
import { toolLoadRoutes } from '../modules/studio/routes/tool-load'
import { uiSkillsRoutes } from '../modules/studio/routes/ui-skills'
import { watcherRoutes } from '../modules/studio/routes/watcher'
import { approvalAlertPublicRoutes, approvalAlertRoutes } from '../modules/studio/routes/approval-alerts'
import { vscodeRoutes } from '../modules/studio/routes/vscode'
import { screenRoutes } from '../modules/studio/routes/screen'
import { modelApiRoutes } from '../modules/studio/routes/model-api'
import { sessionSharePublicRoutes, sessionShareRoutes } from '../modules/studio/routes/session-shares'
import { profileRoutes } from '../modules/hermes/routes/profiles'
import { skillRoutes } from '../modules/hermes/routes/skills'
import { skillBundleRoutes } from '../modules/hermes/routes/skill-bundles'
import { pluginRoutes } from '../modules/hermes/routes/plugins'
import { hermesApiRoutes } from '../modules/hermes/routes/hermes-api'
import { memoryRoutes } from '../modules/hermes/routes/memory'
import { modelRoutes } from '../modules/hermes/routes/models'
import { providerRoutes } from '../modules/hermes/routes/providers'
import { configRoutes } from '../modules/hermes/routes/config'
import { logRoutes } from '../modules/studio/routes/logs'
import { codexAuthRoutes } from '../modules/hermes/routes/codex-auth'
import { nousAuthRoutes } from '../modules/hermes/routes/nous-auth'
import { copilotAuthRoutes } from '../modules/hermes/routes/copilot-auth'
import { xaiAuthRoutes } from '../modules/hermes/routes/xai-auth'
import { anthropicAuthRoutes } from '../modules/hermes/routes/anthropic-auth'
import { minimaxAuthRoutes } from '../modules/hermes/routes/minimax-auth'
import { weixinRoutes } from '../modules/hermes/routes/weixin'
import { mattermostSetupRoutes } from '../modules/hermes/routes/mattermost-setup'
import { fileRoutes } from '../modules/studio/routes/files'
import { downloadRoutes } from '../modules/studio/routes/download'
import { jobRoutes } from '../modules/hermes/routes/jobs'
import { cronHistoryRoutes } from '../modules/hermes/routes/cron-history'
import { kanbanRoutes } from '../modules/hermes/routes/kanban'
import { workflowRoutes } from '../modules/studio/routes/workflows'
import { ttsRoutes, ttsProtectedRoutes } from '../modules/studio/routes/tts'
import { sttProtectedRoutes } from '../modules/studio/routes/stt'
import { jevRoutes } from '../modules/studio/routes/jev'
import { mcuFirmwareRoutes } from '../modules/studio/routes/mcu-firmware'
import { mediaRoutes } from '../modules/studio/routes/media'
import { groupChatPublicRoutes, groupChatRoutes } from '../modules/studio/routes/group-chat'
import { chatRunRoutes } from '../modules/studio/routes/chat-run'
import { chatWebhookPublicRoutes, chatWebhookRoutes } from '../modules/studio/routes/chat-webhooks'
import { performanceMonitorRoutes } from '../modules/studio/routes/performance-monitor'
import { journeyRoutes } from '../modules/hermes/routes/journey'
import { terminalRoutes } from '../modules/hermes/routes/terminal'
import { mcpRoutes } from '../modules/hermes/routes/mcp'
import { runtimeVersionRoutes } from '../modules/hermes/routes/runtime-versions'
import { legacyDataMigrationRoutes } from '../modules/hermes/routes/legacy-data-migration'
import { agentStatusRoutes } from '../modules/studio/routes/agent-status'
import { writeGateRoutes } from '../modules/hermes/routes/write-gate'
import { ekkoMemoryRoutes } from '../modules/ekko/routes/memory'
import { ekkoSkillRoutes } from '../modules/ekko/routes/skills'
import { ekkoMcpRoutes } from '../modules/ekko/routes/mcp'
import { ekkoConfigRoutes } from '../modules/ekko/routes/config'
import { petdexPublicRoutes, petdexRoutes } from '../modules/studio/routes/petdex'
import { petRoutes } from '../modules/studio/routes/pets'
import { legacyAppApiCompatibility } from '../modules/studio/middleware/legacy-app-api'
import { browserRoutes } from '../modules/studio/routes/browser'
import { browserPublicRoutes } from '../modules/studio/routes/browser-public'
import { androidDeviceRoutes } from '../modules/studio/routes/android-devices'
import { systemRoutes } from '../modules/studio/routes/system'
import { chatImportRoutes } from '../modules/studio/routes/chat-import'
import { testLabRoutes } from '../modules/studio/routes/test-lab'
import { sandboxRoutes } from '../modules/studio/routes/sandbox'
import { forgeSettingsRoutes } from '../modules/studio/routes/forge-settings'

/**
 * Register all routes on the Koa app.
 * Public routes are registered first, then auth middleware,
 * then all protected routes.
 */
export function registerRoutes(app: any, authMiddleware: Array<(ctx: Context, next: Next) => Promise<void>>) {
  app.use(legacyAppApiCompatibility)

  // --- Public routes (no auth required) ---
  app.use(modelGatewayMiddleware)
  app.use(healthRoutes.routes())
  app.use(androidAppLinkRoutes.routes())
  app.use(authPublicRoutes.routes())
  app.use(mcuDevicePublicRoutes.routes())
  app.use(ttsRoutes.routes())
  app.use(apiDocsRoutes.routes())
  app.use(petdexPublicRoutes.routes())
  app.use(groupChatPublicRoutes.routes())
  app.use(sessionSharePublicRoutes.routes())
  app.use(chatWebhookPublicRoutes.routes())
  app.use(browserPublicRoutes.routes())
  // Other Studios: each request carries the sender's device signature (docs/projects.md#federation).
  app.use(federationPublicRoutes.routes())
  // Mattermost's Approve / Reject buttons carry their own per-item secret.
  app.use(agentWorkPublicRoutes.routes())
  // A phone trades its one-use pairing code for its key (docs/approval-alerts.md).
  app.use(approvalAlertPublicRoutes.routes())

  // herdr plugin routes carry their own token and loopback check.
  app.use(herdrPluginRoutes.routes())

  // --- Auth middleware: all routes below require authentication ---
  authMiddleware.forEach((middleware) => app.use(middleware))
  app.use(legacyProviderCredentials)
  app.use(providerAccountMiddleware)

  // --- Protected routes (auth required) ---
  app.use(authProtectedRoutes.routes())
  app.use(studioAgentRoutes.routes())
  app.use(studioPluginRoutes.routes())
  app.use(desktopBrowserRoutes.routes())
  app.use(mcuDeviceRoutes.routes())
  app.use(appConnectionRoutes.routes())
  app.use(uploadRoutes.routes())
  app.use(repoPackRoutes.routes())
  app.use(appUploadRoutes.routes())
  app.use(updateRoutes.routes())           // Must be before proxy (proxy catch-all matches everything)
  app.use(herdrRoutes.routes())           // Before codingAgentRoutes' /:id patterns
  app.use(androidDeviceRoutes.routes())
  app.use(systemRoutes.routes())
  app.use(chatImportRoutes.routes())
  app.use(testLabRoutes.routes())
  app.use(sandboxRoutes.routes())
  app.use(forgeSettingsRoutes.routes())
  app.use(codingAgentRoutes.routes())
  app.use(agentStatusRoutes.routes())
  app.use(themeRoutes.routes())
  app.use(navigationRoutes.routes())
  app.use(announcementRoutes.routes())
  app.use(appRelayRoutes.routes())
  app.use(socialMessageRoutes.routes())
  app.use(sessionRoutes.routes())
  app.use(orbRoutes.routes())
  app.use(omiRoutes.routes())
  app.use(llmWikiRoutes.routes())
  app.use(agentWorkRoutes.routes())
  app.use(commandCenterRoutes.routes())
  app.use(projectRoutes.routes())
  app.use(peerRoutes.routes())
  app.use(runLimitRoutes.routes())
  app.use(toolLoadRoutes.routes())
  app.use(uiSkillsRoutes.routes())
  app.use(watcherRoutes.routes())
  app.use(approvalAlertRoutes.routes())
  app.use(vscodeRoutes.routes())
  app.use(screenRoutes.routes())
  app.use(hermesApiRoutes.routes())
  app.use(modelApiRoutes.routes())
  app.use(personRoutes.routes())
  app.use(sessionShareRoutes.routes())
  app.use(profileRoutes.routes())
  app.use(ekkoMemoryRoutes.routes())
  app.use(ekkoSkillRoutes.routes())
  app.use(ekkoMcpRoutes.routes())
  app.use(ekkoConfigRoutes.routes())
  app.use(skillRoutes.routes())
  app.use(skillBundleRoutes.routes())
  app.use(pluginRoutes.routes())
  app.use(memoryRoutes.routes())
  app.use(modelRoutes.routes())
  app.use(providerRoutes.routes())
  app.use(configRoutes.routes())
  app.use(logRoutes.routes())
  app.use(codexAuthRoutes.routes())
  app.use(nousAuthRoutes.routes())
  app.use(copilotAuthRoutes.routes())
  app.use(xaiAuthRoutes.routes())
  app.use(anthropicAuthRoutes.routes())
  app.use(minimaxAuthRoutes.routes())
  app.use(weixinRoutes.routes())
  app.use(mattermostSetupRoutes.routes())
  app.use(chatRunRoutes.routes())
  app.use(chatWebhookRoutes.routes())
  app.use(groupChatRoutes.routes())
  app.use(fileRoutes.routes())
  app.use(downloadRoutes.routes())
  app.use(jobRoutes.routes())
  app.use(cronHistoryRoutes.routes())
  app.use(kanbanRoutes.routes())
  app.use(workflowRoutes.routes())
  app.use(ttsProtectedRoutes.routes())
  app.use(sttProtectedRoutes.routes())
  app.use(jevRoutes.routes())
  app.use(mcuFirmwareRoutes.routes())
  app.use(mediaRoutes.routes())
  app.use(performanceMonitorRoutes.routes())
  app.use(journeyRoutes.routes())
  app.use(terminalRoutes.routes())
  app.use(mcpRoutes.routes())                   // MCP management
  app.use(runtimeVersionRoutes.routes())         // Runtime and version management
  app.use(legacyDataMigrationRoutes.routes())    // One-time legacy Windows Hermes data migration
  app.use(writeGateRoutes.routes())              // Hermes Agent write approval review
  app.use(petdexRoutes.routes())
  app.use(petRoutes.routes())
  app.use(browserRoutes.routes())          // Headless browser management
}
