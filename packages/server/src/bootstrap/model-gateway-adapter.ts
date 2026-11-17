import { configureModelGatewayAdapters } from '../modules/studio/public/model-gateway-adapters'
import { configureProviderHttp, createProviderHttpTransport } from '../modules/studio/public/provider-http'
import { configureProviderUpstream } from '../modules/studio/public/provider-upstream'
import { codingModelGatewayAdapters } from '../modules/coding-agents/public/model-gateway'
import { createEkkoAuthorizedProviderFetch, resolveEkkoProviderRuntimeConfig } from '../modules/ekko/services/provider-runtime'
import { failoverPooledApiKey, nextPooledApiKey } from '../modules/studio/public/provider-key-pools'
import { withProviderAccount } from '../modules/studio/services/providers/account-store'
import { authorizedModelProviderPreset } from '../../../ekko-agent/src/model/authorized-providers'

configureModelGatewayAdapters(codingModelGatewayAdapters)
// Key pools (Models → Key pools): the gateway takes the Provider's own key and its pooled keys in turn.
configureProviderUpstream(async input => {
  const resolved = await resolveEkkoProviderRuntimeConfig(input)
  const apiKey = await nextPooledApiKey(resolved.provider, resolved.apiKey, input.profile)
  return apiKey === resolved.apiKey ? resolved : { ...resolved, apiKey }
})
const providerTransport = createProviderHttpTransport({
  createFetch: createEkkoAuthorizedProviderFetch,
  headers: (provider, apiKey) => authorizedModelProviderPreset(provider, apiKey)?.headers,
})
// A pooled key that hits a rate limit rests, and the request is retried once on the next key.
configureProviderHttp(async input => {
  const response = await providerTransport(input)
  if (response.status !== 429 || !input.apiKey || !input.provider) return response
  const failover = () => failoverPooledApiKey(input.provider!, input.apiKey, input.profile, response.headers.get('retry-after'))
  const next = await (input.ownerUserId ? withProviderAccount(input.ownerUserId, failover, input.profile) : failover()).catch(() => undefined)
  if (!next) return response
  await response.body?.cancel().catch(() => undefined)
  return providerTransport({ ...input, apiKey: next })
})
