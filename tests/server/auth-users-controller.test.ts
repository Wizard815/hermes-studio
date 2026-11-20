import { describe, expect, it, vi } from 'vitest'

// The managed-user API answers with the account summary, never the stored row (password hash, avatar).
const row = { id: 7, username: 'sam', password_hash: 'scrypt:salt:hash', role: 'admin', status: 'active', created_at: 1, updated_at: 1, last_login_at: null, avatar: 'data:image/png;base64,AAAA' }
const summary = { id: 7, username: 'sam', role: 'admin', status: 'active', profiles: ['default'], default_profile: 'default', created_at: 1, updated_at: 1, last_login_at: null }

vi.mock('../../packages/server/src/modules/studio/public/users', () => ({
  DEFAULT_PASSWORD: '123456', DEFAULT_USERNAME: 'admin',
  bootstrapDefaultSuperAdmin: vi.fn(), countActiveSuperAdmins: vi.fn(() => 1), countUsers: vi.fn(() => 2),
  createUser: vi.fn(() => row), deleteUser: vi.fn(), findUserById: vi.fn(() => row), findUserByUsername: vi.fn(() => null),
  getUserAvatar: vi.fn(), listUserProfiles: vi.fn(() => []), listUsers: vi.fn(() => [summary]), setUserAvatar: vi.fn(),
  updateUser: vi.fn(() => row), updateUsername: vi.fn(), updateUserPassword: vi.fn(), verifyPassword: vi.fn(() => false),
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNamesFromDisk: () => ['default'] }))

const ctxFor = (body: Record<string, unknown>, params: Record<string, string> = {}) =>
  ({ request: { body }, params, state: { user: { id: 1, role: 'super_admin' } }, status: 200, body: undefined } as any)

describe('managed users API', () => {
  it('creating a user does not send its password hash', async () => {
    const { createManagedUser } = await import('../../packages/server/src/modules/studio/controllers/auth')
    const ctx = ctxFor({ username: 'sam', password: 'studio-pass-123' })
    await createManagedUser(ctx)
    expect(ctx.status).toBe(201)
    expect(ctx.body.user).toEqual(summary)
    expect(JSON.stringify(ctx.body)).not.toContain('scrypt:')
  })

  it('updating a user does not send its password hash', async () => {
    const { updateManagedUser } = await import('../../packages/server/src/modules/studio/controllers/auth')
    const ctx = ctxFor({ password: 'a-new-password' }, { id: '7' })
    await updateManagedUser(ctx)
    expect(ctx.body.user).toEqual(summary)
    expect(JSON.stringify(ctx.body)).not.toContain('scrypt:')
  })
})
