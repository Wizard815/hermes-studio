import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { SESSION_CATEGORIES_TABLE, SESSIONS_TABLE } from '../infrastructure/database/schemas'

export const SESSION_CATEGORY_NAME_MAX_LENGTH = 40
export const SESSION_CATEGORY_MAX_DEPTH = 5

export interface SessionCategoryRow {
  id: number
  name: string
  parent_id: number | null
  created_at: number
  updated_at: number
}

function mapCategoryRow(row: Record<string, unknown>): SessionCategoryRow {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    parent_id: row.parent_id != null ? Number(row.parent_id) : null,
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  }
}

export function normalizeSessionCategoryName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}

export function listSessionCategories(): SessionCategoryRow[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()!
  const rows = db.prepare(
    `SELECT id, name, parent_id, created_at, updated_at FROM ${SESSION_CATEGORIES_TABLE} ORDER BY name COLLATE NOCASE, id`,
  ).all() as Record<string, unknown>[]
  return rows.map(mapCategoryRow)
}

export function getSessionCategory(id: number): SessionCategoryRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const row = db.prepare(
    `SELECT id, name, parent_id, created_at, updated_at FROM ${SESSION_CATEGORIES_TABLE} WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined
  return row ? mapCategoryRow(row) : null
}

export function findSessionCategoryByName(name: string, parentId: number | null = null): SessionCategoryRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const row = db.prepare(
    `SELECT id, name, parent_id, created_at, updated_at FROM ${SESSION_CATEGORIES_TABLE} WHERE name = ? COLLATE NOCASE AND COALESCE(parent_id, 0) = ?`,
  ).get(name, parentId ?? 0) as Record<string, unknown> | undefined
  return row ? mapCategoryRow(row) : null
}

/** Number of levels from the root down to (and including) this category; 0 for no category. */
export function sessionCategoryDepth(id: number | null): number {
  let depth = 0
  const seen = new Set<number>()
  let current = id
  while (current != null && !seen.has(current)) {
    const category = getSessionCategory(current)
    if (!category) break
    seen.add(current)
    depth += 1
    current = category.parent_id
  }
  return depth
}

function subtreeHeight(id: number): number {
  const children = listSessionCategories().filter(category => category.parent_id === id)
  return 1 + children.reduce((max, child) => Math.max(max, subtreeHeight(child.id)), 0)
}

export function isSessionCategoryDescendant(id: number, ancestorId: number): boolean {
  const seen = new Set<number>()
  let current: number | null = id
  while (current != null && !seen.has(current)) {
    if (current === ancestorId) return true
    seen.add(current)
    current = getSessionCategory(current)?.parent_id ?? null
  }
  return false
}

export function createSessionCategory(name: string, parentId: number | null = null): SessionCategoryRow {
  const normalizedName = normalizeSessionCategoryName(name)
  if (!normalizedName) throw new Error('Category name is required')
  if (normalizedName.length > SESSION_CATEGORY_NAME_MAX_LENGTH) {
    throw new Error(`Category name must be ${SESSION_CATEGORY_NAME_MAX_LENGTH} characters or fewer`)
  }
  if (!isSqliteAvailable()) {
    const now = Math.floor(Date.now() / 1000)
    return { id: 0, name: normalizedName, parent_id: parentId, created_at: now, updated_at: now }
  }
  if (parentId != null) {
    if (!getSessionCategory(parentId)) throw new Error('Parent category not found')
    if (sessionCategoryDepth(parentId) >= SESSION_CATEGORY_MAX_DEPTH) {
      throw new Error(`Categories can be nested at most ${SESSION_CATEGORY_MAX_DEPTH} levels deep`)
    }
  }
  const existing = findSessionCategoryByName(normalizedName, parentId)
  if (existing) return existing

  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT OR IGNORE INTO ${SESSION_CATEGORIES_TABLE} (name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(normalizedName, parentId, now, now)
  const category = findSessionCategoryByName(normalizedName, parentId)
  if (!category) throw new Error('Failed to create category')
  return category
}

export function renameSessionCategory(id: number, name: string): SessionCategoryRow | null {
  const normalizedName = normalizeSessionCategoryName(name)
  if (!normalizedName) throw new Error('Category name is required')
  if (normalizedName.length > SESSION_CATEGORY_NAME_MAX_LENGTH) {
    throw new Error(`Category name must be ${SESSION_CATEGORY_NAME_MAX_LENGTH} characters or fewer`)
  }
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  const result = db.prepare(
    `UPDATE ${SESSION_CATEGORIES_TABLE} SET name = ?, updated_at = ? WHERE id = ?`,
  ).run(normalizedName, now, id)
  return result.changes > 0 ? getSessionCategory(id) : null
}

export function deleteSessionCategory(id: number): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  db.exec('BEGIN IMMEDIATE')
  try {
    const parentId = getSessionCategory(id)?.parent_id ?? null
    // Children and sessions move up one level instead of being orphaned.
    db.prepare(`UPDATE ${SESSION_CATEGORIES_TABLE} SET parent_id = ? WHERE parent_id = ?`).run(parentId, id)
    db.prepare(`UPDATE ${SESSIONS_TABLE} SET category_id = ? WHERE category_id = ?`).run(parentId, id)
    const result = db.prepare(`DELETE FROM ${SESSION_CATEGORIES_TABLE} WHERE id = ?`).run(id)
    db.exec('COMMIT')
    return result.changes > 0
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function setSessionCategory(sessionId: string, categoryId: number | null): boolean {
  if (!isSqliteAvailable()) return false
  if (categoryId !== null && !getSessionCategory(categoryId)) return false
  const db = getDb()!
  const result = db.prepare(
    `UPDATE ${SESSIONS_TABLE} SET category_id = ? WHERE id = ?`,
  ).run(categoryId, sessionId)
  return result.changes > 0
}

export function moveSessionCategory(id: number, parentId: number | null): SessionCategoryRow | null {
  const category = getSessionCategory(id)
  if (!category) return null
  if (parentId != null) {
    if (!getSessionCategory(parentId)) throw new Error('Parent category not found')
    if (isSessionCategoryDescendant(parentId, id)) throw new Error('A category cannot be moved into itself')
    if (sessionCategoryDepth(parentId) + subtreeHeight(id) > SESSION_CATEGORY_MAX_DEPTH) {
      throw new Error(`Categories can be nested at most ${SESSION_CATEGORY_MAX_DEPTH} levels deep`)
    }
  }
  if (category.parent_id === parentId) return category
  const duplicate = findSessionCategoryByName(category.name, parentId)
  if (duplicate && duplicate.id !== id) throw new Error('A category with this name already exists')
  const db = getDb()!
  db.prepare(`UPDATE ${SESSION_CATEGORIES_TABLE} SET parent_id = ?, updated_at = ? WHERE id = ?`)
    .run(parentId, Math.floor(Date.now() / 1000), id)
  return getSessionCategory(id)
}
