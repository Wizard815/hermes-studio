import { BUILTIN_NAVIGATION_IDS, defaultNavigationSettings, validateNavigationSettings, type NavigationSettings } from '../../../../../shared/navigation-settings'
import { getDb } from '../infrastructure/database'
import { USER_NAVIGATION_TABLE } from '../infrastructure/database/schemas'

const NAVIGATION_SCHEMA_VERSION = 1

/** Saved ids this version no longer knows are dropped, keeping the rest of the user's order. */
function knownItems(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw
  const seen = new Set<string>()
  return raw.filter(item => {
    if (typeof item !== 'string' || seen.has(item)) return false
    seen.add(item)
    return (BUILTIN_NAVIGATION_IDS as readonly string[]).includes(item) || item.startsWith('plugin:')
  })
}

export function getUserNavigation(userId: number): NavigationSettings {
  const db = getDb()
  const row = db?.prepare(`SELECT items_json, schema_version FROM ${USER_NAVIGATION_TABLE} WHERE user_id = ?`).get(userId) as { items_json: string; schema_version: number } | undefined
  if (!row) return defaultNavigationSettings()
  let settings: NavigationSettings
  try { settings = validateNavigationSettings({ items: knownItems(JSON.parse(row.items_json)) }) }
  catch { return defaultNavigationSettings() }
  // Early saved lists omitted the built-in plugin center. Repair them once,
  // without resetting other selections or undoing future explicit edits.
  if (row.schema_version < NAVIGATION_SCHEMA_VERSION) {
    if (!settings.items.includes('studioPlugins')) {
      const relayIndex = settings.items.indexOf('apiRelay')
      settings.items.splice(relayIndex < 0 ? settings.items.length : relayIndex, 0, 'studioPlugins')
    }
    db!.prepare(`UPDATE ${USER_NAVIGATION_TABLE} SET items_json = ?, schema_version = ?, updated_at = ? WHERE user_id = ?`)
      .run(JSON.stringify(settings.items), NAVIGATION_SCHEMA_VERSION, Date.now(), userId)
  }
  return settings
}

export function saveUserNavigation(userId: number, settings: NavigationSettings): NavigationSettings {
  const db = getDb()
  if (!db) throw new Error('Navigation storage unavailable')
  db.prepare(`INSERT INTO ${USER_NAVIGATION_TABLE} (user_id, items_json, schema_version, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET items_json = excluded.items_json, schema_version = excluded.schema_version, updated_at = excluded.updated_at`)
    .run(userId, JSON.stringify(settings.items), NAVIGATION_SCHEMA_VERSION, Date.now())
  return settings
}
