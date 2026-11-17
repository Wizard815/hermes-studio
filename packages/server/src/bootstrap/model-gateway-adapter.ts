import { configureModelGatewayAdapters } from '../modules/studio/public/model-gateway-adapters'
import { configureProviderHttp, createProviderHttpTransport } from '../modules/studio/public/provider-http'
import { configureProviderUpstream } from '../modules/studio/public/provider-upstream'
import { codingModelGatewayAdapters } from '../modules/coding-agents/public/model-gateway'
import { createEkkoAuthorizedProviderFetch, resolveEkkoProviderRuntimeConfig } from '../modules/ekko/services/provider-runtime'
import { nextPooledApiKey } from '../modules/studio/public/provider-key-pools'
import { authorizedModelProviderPreset } from '../../../ekko-agent/src/model/authorized-providers'

configureModelGatewayAdapters(codingModelGatewayAdapters)
// Key pools (Models → Key pools): the gateway takes the Provider's own key and its pooled keys in turn.
configureProviderUpstream(async input => {
  const resolved = await resolveEkkoProviderRuntimeConfig(input)
  const apiKey = await nextPooledApiKey(resolved.provider, resolved.apiKey, input.profile)
  return apiKey === resolved.apiKey ? resolved : { ...resolved, apiKey }
})
configureProviderHttp(createProviderHttpTransport({
  createFetch: createEkkoAuthorizedProviderFetch,
  headers: (provider, apiKey) => authorizedModelProviderPreset(provider, apiKey)?.headers,
}))
