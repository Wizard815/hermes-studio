import type { DropdownOption } from 'naive-ui'
import { categoryPathLabel } from './session-category-groups'

interface CategoryOption {
  id: number
  name: string
  parent_id?: number | null
}

interface BuildSessionCategoryMenuChildrenOptions {
  categories: readonly CategoryOption[]
  currentCategoryId: number | null | undefined
  createCategoryLabel: string
  uncategorizedLabel: string
  loadFailedLabel: string
  retryLabel: string
  loadFailed: boolean
  loading: boolean
}

export function buildSessionCategoryMenuChildren({
  categories,
  currentCategoryId,
  createCategoryLabel,
  uncategorizedLabel,
  loadFailedLabel,
  retryLabel,
  loadFailed,
  loading,
}: BuildSessionCategoryMenuChildrenOptions): DropdownOption[] {
  if (loadFailed) {
    return [
      { label: loadFailedLabel, key: 'category:load-failed', disabled: true },
      { label: retryLabel, key: 'category:retry', disabled: loading },
    ]
  }

  return [
    {
      label: createCategoryLabel,
      key: 'category:create',
      disabled: loading,
    },
    {
      type: 'divider',
      key: 'category:create-divider',
    },
    {
      label: uncategorizedLabel,
      key: 'category:none',
      disabled: currentCategoryId == null,
    },
    ...categories.map(category => ({
      label: categoryPathLabel(categories, category.id),
      key: `category:${category.id}`,
      disabled: currentCategoryId === category.id,
    })),
  ]
}

export function resolveRecentSessionCategoryLabel(
  categoryId: number | null | undefined,
  categoryNames: ReadonlyMap<number, string>,
  loaded: boolean,
  loadFailed: boolean,
  uncategorizedLabel: string,
): string | undefined {
  if (!loaded || loadFailed) return undefined
  if (categoryId == null) return uncategorizedLabel
  return categoryNames.get(categoryId)
}
