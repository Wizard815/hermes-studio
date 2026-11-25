/** OpenRouter's counter for the key (USD spent so far); null for other providers. */
export async function openRouterKeyUsage(baseUrl: string | undefined, apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<number | null> {
  let host = ''
  try { host = new URL(baseUrl || '').hostname } catch { return null }
  if (host !== 'openrouter.ai' && !host.endsWith('.openrouter.ai')) return null
  if (!apiKey) throw new Error('the provider has no key')
  const res = await fetcher('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`)
  const body = await res.json() as { data?: { usage?: unknown } }
  const usage = Number(body?.data?.usage)
  if (!Number.isFinite(usage)) throw new Error('OpenRouter sent no usage')
  return usage
}
