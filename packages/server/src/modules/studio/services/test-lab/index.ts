import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getWebUiHome, config } from '../../public/config'
import { modelGatewayAdapters } from '../../public/model-gateway-adapters'
import { resolveProviderUpstream } from '../../public/provider-upstream'
import { withProviderAccount } from '../../public/provider-account'
import { getRunLimits } from '../run-limits'
import { apiMode, unifiedCatalog } from '../model-api/service'
import { LabDocker } from './docker'
import { TestLabService, type LabModel } from './service'
import { openRouterKeyUsage } from './openrouter'

export { TestLabError, TestLabService } from './service'
export { openRouterKeyUsage } from './openrouter'

async function upstream(userId: number, model: LabModel) {
  return withProviderAccount(userId, () => resolveProviderUpstream({ profile: model.profile, provider: model.provider, model: model.model, apiMode: model.apiMode }), model.profile)
}

let service: TestLabService | null = null

export function getTestLab(): TestLabService {
  service ??= new TestLabService({
    home: () => join(getWebUiHome(), 'test-lab'),
    docker: new LabDocker(),
    instance: createHash('sha1').update(getWebUiHome()).digest('hex').slice(0, 12),
    models: async (userId, profile = 'default') => withProviderAccount(userId, async () => {
      const catalog = await unifiedCatalog([profile])
      return [...catalog].filter(([, entry]) => !entry.group.model_meta?.[entry.model]?.disabled && !['bedrock_converse', 'codex_app_server'].includes(apiMode(entry.group, entry.model) || ''))
        .map(([id, entry]) => ({ id, provider: entry.group.provider, model: entry.model, profile: entry.profile, apiMode: apiMode(entry.group, entry.model) }))
        .sort((a, b) => a.id.localeCompare(b.id))
    }, profile),
    registerGateway: async ({ userId, model, sessionId, runId, token }) => {
      const runtime = await upstream(userId, model)
      if (!runtime.baseUrl) throw new Error(`${model.provider} has no endpoint`)
      return modelGatewayAdapters().register('chat_completions', {
        userId, profile: model.profile, provider: model.provider, model: model.model, baseUrl: runtime.baseUrl, apiKey: runtime.apiKey || '',
        apiMode: model.apiMode || runtime.apiMode, sessionId, runId,
        // The run's spend is counted by run limits (gateway usage), not as a chat run.
        onUsageEvent: () => {},
      }, { token })
    },
    gatewayPort: () => config.port,
    limits: {
      set: (sessionId, capUsd, minutes) => { getRunLimits().saveChatLimits(sessionId, { costUsd: capUsd, minutes }, { reset: true }) },
      spent: sessionId => {
        const run = getRunLimits().describe(sessionId).run
        return run ? { costUsd: run.costUsd, tokens: run.tokens, unpricedCalls: run.unpricedCalls } : null
      },
      forget: sessionId => { try { getRunLimits().dismiss(sessionId); getRunLimits().forgetChat(sessionId) } catch { /* limits are off */ } },
    },
    openRouterUsage: async (model, userId) => {
      const runtime = await upstream(userId, model)
      return openRouterKeyUsage(runtime.baseUrl, runtime.apiKey)
    },
    log: message => process.stderr.write(`${message}\n`),
  })
  return service
}
