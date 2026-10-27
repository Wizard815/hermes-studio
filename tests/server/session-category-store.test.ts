import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session category store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('creates normalized global categories without case-insensitive duplicates', async () => {
    const { createSessionCategory, listSessionCategories } = await import(
      '../../packages/server/src/modules/studio/repositories/session-category-store'
    )

    const created = createSessionCategory('  Client   Work  ')
    const existing = createSessionCategory('client work')

    expect(created.name).toBe('Client Work')
    expect(existing.id).toBe(created.id)
    expect(listSessionCategories()).toEqual([created])
  })

  it('stores one nullable category id directly on a session', async () => {
    const { createSessionCategory, deleteSessionCategory, renameSessionCategory, setSessionCategory } = await import(
      '../../packages/server/src/modules/studio/repositories/session-category-store'
    )
    const { createSession, getSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const category = createSessionCategory('Work')
    createSession({ id: 'session-1', profile: 'profile-a', category_id: category.id })
    createSession({ id: 'session-2', profile: 'profile-b', category_id: category.id })

    expect(getSession('session-1')?.category_id).toBe(category.id)
    expect(getSession('session-2')?.category_id).toBe(category.id)
    expect(setSessionCategory('session-1', null)).toBe(true)
    expect(getSession('session-1')?.category_id).toBeNull()
    expect(setSessionCategory('session-1', 999)).toBe(false)

    const renamed = renameSessionCategory(category.id, 'Client Work')
    expect(renamed?.name).toBe('Client Work')
    expect(setSessionCategory('session-1', category.id)).toBe(true)
    expect(deleteSessionCategory(category.id)).toBe(true)
    expect(getSession('session-1')?.category_id).toBeNull()
  })

  it('nests categories, scopes names per parent, and reparents on delete', async () => {
    const {
      createSessionCategory, deleteSessionCategory, listSessionCategories, moveSessionCategory, setSessionCategory,
    } = await import('../../packages/server/src/modules/studio/repositories/session-category-store')
    const { createSession, getSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')

    const work = createSessionCategory('Work')
    const personal = createSessionCategory('Personal')
    const workNotes = createSessionCategory('Notes', work.id)
    const personalNotes = createSessionCategory('notes', personal.id)
    expect(workNotes.parent_id).toBe(work.id)
    expect(personalNotes.id).not.toBe(workNotes.id)
    expect(createSessionCategory('NOTES', work.id).id).toBe(workNotes.id)
    expect(() => createSessionCategory('x', 999)).toThrow('Parent category not found')

    expect(() => moveSessionCategory(work.id, workNotes.id)).toThrow('into itself')
    expect(moveSessionCategory(workNotes.id, null)?.parent_id).toBeNull()
    expect(() => moveSessionCategory(personalNotes.id, null)).toThrow('already exists')

    const sub = createSessionCategory('Sub', work.id)
    createSession({ id: 's1', profile: 'p' })
    setSessionCategory('s1', sub.id)
    expect(deleteSessionCategory(work.id)).toBe(true)
    expect(getSession('s1')?.category_id).toBe(sub.id)
    expect(listSessionCategories().find(c => c.id === sub.id)?.parent_id).toBeNull()
    expect(deleteSessionCategory(sub.id)).toBe(true)
    expect(getSession('s1')?.category_id).toBeNull()
  })

  it('limits nesting depth', async () => {
    const { createSessionCategory, SESSION_CATEGORY_MAX_DEPTH } = await import(
      '../../packages/server/src/modules/studio/repositories/session-category-store'
    )
    let parent = createSessionCategory('L0')
    for (let i = 1; i < SESSION_CATEGORY_MAX_DEPTH; i++) parent = createSessionCategory(`L${i}`, parent.id)
    expect(() => createSessionCategory('too deep', parent.id)).toThrow('nested at most')
  })
})
