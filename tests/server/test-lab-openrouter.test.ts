import { expect, it, vi } from 'vitest'
import { openRouterKeyUsage } from '../../packages/server/src/modules/studio/services/test-lab/openrouter'

it('reads OpenRouter\'s key usage, and nothing for other providers', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { usage: 7.4911, limit: null } }), { status: 200 }))
  expect(await openRouterKeyUsage('https://openrouter.ai/api/v1', 'sk-or-x', fetcher as any)).toBe(7.4911)
  expect(fetcher).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.objectContaining({ headers: { authorization: 'Bearer sk-or-x' } }))
  expect(await openRouterKeyUsage('https://api.deepseek.com/v1', 'k', fetcher as any)).toBeNull()
  expect(fetcher).toHaveBeenCalledOnce()
  await expect(openRouterKeyUsage('https://openrouter.ai/api/v1', 'k', (async () => new Response('no', { status: 401 })) as any)).rejects.toThrow('OpenRouter answered 401')
  await expect(openRouterKeyUsage('https://openrouter.ai/api/v1', '', fetcher as any)).rejects.toThrow('no key')
})
