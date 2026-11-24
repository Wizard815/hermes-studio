import type { ModelCatalogSnapshot } from '../../public/model-catalog'
import { estimateCatalogUsageCost } from '../usage/catalog-pricing'
import { estimateUsageCost, type UsagePricing } from '../usage/usage-cost'
import type { GatewayUsage } from './service'

/**
 * Price of one gateway call for run limits, in the same order recorded usage
 * uses (docs/harness/usage-cost.md): the Usage page's manual price for the
 * exact provider and model, then the models.dev catalog. Undefined when the
 * model has no known price (the call still counts for tokens).
 */
export function priceGatewayRunUsage(
  input: { provider?: string; model?: string; usage: GatewayUsage },
  rates: UsagePricing[],
  catalog: ModelCatalogSnapshot | undefined,
): number | undefined {
  if (!input.model) return undefined
  const manual = input.provider ? rates.find(row => row.provider === input.provider && row.model === input.model) : undefined
  if (manual) return estimateUsageCost(input.usage, manual)?.costUsd
  return estimateCatalogUsageCost(catalog, input.provider || '', input.model, input.usage, 'model_call', 1)?.costUsd
}
