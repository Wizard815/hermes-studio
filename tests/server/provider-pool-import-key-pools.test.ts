import { describe, expect, it } from 'vitest'
import { mergeProviderSnapshot, type ProviderPoolState } from '../../packages/server/src/modules/studio/services/providers/account-pool'

const hermesAuth = {
  version: 1,
  providers: {},
  credential_pool: {
    'custom:fakepool': [
      // Hermes seeds an entry for the provider's own key without the key itself.
      { id: 'a', label: 'fakepool', auth_type: 'api_key', source: 'config:fakepool' },
      { id: 'b', label: 'dummy-a', auth_type: 'api_key', source: 'manual', access_token: 'dummy-a' },
      { id: 'c', label: 'dummy-b', auth_type: 'api_key', source: 'manual', access_token: 'dummy-b' },
      { id: 'd', label: 'same as main', auth_type: 'api_key', source: 'manual', access_token: 'good-key' },
    ],
  },
}

const snapshot = (profile: string) => ({
  profile,
  config: {
    model: { provider: 'custom:fakepool', default: 'fake-model' },
    custom_providers: [{ name: 'fakepool', base_url: 'http://127.0.0.1:18999/v1', api_key: 'good-key', model: 'fake-model', api_mode: 'chat_completions' }],
  },
  env: '',
  auth: hermesAuth,
  anthropic: '',
  qwen: '',
})

describe('importing Hermes profiles into account Providers', () => {
  it("keeps a Hermes key pool on the Provider, once, without the Provider's own key", () => {
    const state: ProviderPoolState = { version: 3, imports: {}, fingerprints: {} }
    const first = mergeProviderSnapshot({ snapshot: snapshot('default'), config: {}, env: '', auth: {}, state, environmentMap: {} })
    expect(Object.keys(first.config.providers)).toContain('custom:fakepool')
    expect(first.auth.credential_pool['custom:fakepool'].map((entry: any) => entry.access_token)).toEqual(['dummy-a', 'dummy-b'])
    // A second profile with the same Provider adds nothing twice.
    const second = mergeProviderSnapshot({ snapshot: snapshot('work'), config: first.config, env: first.env, auth: first.auth, state, environmentMap: {} })
    expect(second.auth.credential_pool['custom:fakepool']).toHaveLength(2)
  })
})
