export const BUILTIN_NAVIGATION_IDS = ['person', 'chat', 'group', 'workflow', 'history', 'connections', 'android', 'system', 'agents', 'models', 'usage', 'studioPlugins', 'upstream', 'apiRelay'] as const
export type BuiltinNavigationId = typeof BUILTIN_NAVIGATION_IDS[number]
export interface NavigationSettings { items: string[] }

// This fork removed API Relay from the navigation. Its id stays valid so saved
// lists keep loading, but it is no longer offered by default or in the catalog.
const REMOVED_NAVIGATION_IDS: ReadonlySet<string> = new Set(['apiRelay'])

export const pluginNavigationId = (pluginId: string, viewId: string) => `plugin:${pluginId}/${viewId}`
export const defaultNavigationSettings = (): NavigationSettings => ({ items: BUILTIN_NAVIGATION_IDS.filter(id => !REMOVED_NAVIGATION_IDS.has(id)) })

export function validateNavigationSettings(value: unknown): NavigationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid navigation settings')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => key !== 'items') || !Array.isArray(input.items) || input.items.length > 201) throw new Error('Expected at most 201 navigation items')
  const items = input.items
  if (items.some(item => typeof item !== 'string' || !(
    (BUILTIN_NAVIGATION_IDS as readonly string[]).includes(item) || /^plugin:[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}$/i.test(item)
  )) || new Set(items).size !== items.length) throw new Error('Invalid or duplicate navigation item')
  return { items: [...items] as string[] }
}
