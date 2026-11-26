import { configureModelGatewayAdapters } from '../modules/studio/public/model-gateway-adapters'
import { configureProviderHttp, createProviderHttpTransport } from '../modules/studio/public/provider-http'
import { configureProviderUpstream } from '../modules/studio/public/provider-upstream'
import { codingModelGatewayAdapters } from '../modules/coding-agents/public/model-gateway'
import { createEkkoAuthorizedProviderFetch, resolveEkkoProviderRuntimeConfig } from '../modules/ekko/services/provider-runtime'
import { nextPooledApiKey, sendWithKeyPool } from '../modules/studio/public/provider-key-pools'
import { withProviderAccount } from '../modules/studio/services/providers/account-store'
import { LocalServerNotRunningError, resolveHermesLocalUpstream } from '../modules/hermes/services/models/local-provider'
import { ModelApiError } from '../modules/studio/services/model-api/errors'
import { authorizedModelProviderPreset } from '../../../ekko-agent/src/model/authorized-providers'

configureModelGatewayAdapters(codingModelGatewayAdapters)
// Key pools (Models → Key pools): the gateway takes the Provider's own key and its pooled keys in turn.
configureProviderUpstream(async input => {
  // Hermes local: wherever Hermes's llama-server runs now, with its key (or a clear error when it is off).
  let resolved = await resolveEkkoProviderRuntimeConfig(input)
  try { resolved = resolveHermesLocalUpstream(resolved) } catch (error) {
    // A 4xx the caller shows as it is (Hermes would keep retrying a 5xx).
    if (error instanceof LocalServerNotRunningError) throw new ModelApiError(error.message, 409, null, 'local_server_not_running')
    throw error
  }
  const apiKey = await nextPooledApiKey(resolved.provider, resolved.apiKey, input.profile)
  return apiKey === resolved.apiKey ? resolved : { ...resolved, apiKey }
})
const providerTransport = createProviderHttpTransport({
  createFetch: createEkkoAuthorizedProviderFetch,
  headers: (provider, apiKey) => authorizedModelProviderPreset(provider, apiKey)?.headers,
})
// A pooled key that hits a rate limit rests, and the request moves to the next free key.
configureProviderHttp(input => sendWithKeyPool(input, apiKey => providerTransport(apiKey === input.apiKey ? input : { ...input, apiKey: apiKey! }),
  operation => input.ownerUserId ? withProviderAccount(input.ownerUserId, operation, input.profile) : operation()))
