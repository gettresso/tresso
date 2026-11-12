import { beforeEach, describe, expect, it, vi } from 'vitest'

const items = vi.hoisted(() => new Map<string, string>())
/** Writes left before the store stops answering, as when the app is killed halfway through a save. */
const budget = vi.hoisted(() => ({ writes: Infinity }))

function write(): void {
  if (budget.writes <= 0) {
    throw new Error('The app was killed.')
  }
  budget.writes--
}

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => items.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    write()
    items.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    write()
    items.delete(key)
  },
}))

const { secureTokenStore } = await import('./secureTokenStore')

describe('secureTokenStore', () => {
  beforeEach(() => {
    items.clear()
    budget.writes = Infinity
  })

  it('keeps each token in its own entry and reads them back', async () => {
    await secureTokenStore.save({ accessToken: 'a'.repeat(1800), refreshToken: 'r'.repeat(1500), expiresAt: 1_800_000_000_000 })

    expect([...items.keys()].sort()).toEqual(['auth.accessToken', 'auth.expiresAt', 'auth.refreshToken'])
    expect(await secureTokenStore.load()).toEqual({ accessToken: 'a'.repeat(1800), refreshToken: 'r'.repeat(1500), expiresAt: 1_800_000_000_000 })
  })

  it('keeps a sign-in without a refresh token', async () => {
    await secureTokenStore.save({ accessToken: 'access', refreshToken: 'stale', expiresAt: 1 })
    await secureTokenStore.save({ accessToken: 'access', refreshToken: null, expiresAt: 2 })

    expect(await secureTokenStore.load()).toEqual({ accessToken: 'access', refreshToken: null, expiresAt: 2 })
  })

  it('treats an incomplete set as signed out', async () => {
    items.set('auth.accessToken', 'access')
    items.set('auth.refreshToken', 'refresh')

    expect(await secureTokenStore.load()).toBeNull()
  })

  it('removes the tokens on sign-out and keeps who was signed in until asked to forget them', async () => {
    await secureTokenStore.save({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 1 })
    await secureTokenStore.rememberUser('u1')
    expect(items.get('auth.lastUserId')).toBe('u1')

    await secureTokenStore.save(null)
    expect([...items.keys()]).toEqual(['auth.lastUserId'])
    expect(await secureTokenStore.load()).toBeNull()

    await secureTokenStore.forgetUser()
    expect(items.size).toBe(0)
  })

  it('a save interrupted at any step leaves a loadable set that holds the newest refresh token written', async () => {
    const before = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1_000 }
    const after = { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: 2_000 }
    for (let writes = 0; writes <= 3; writes++) {
      items.clear()
      budget.writes = Infinity
      await secureTokenStore.save(before)
      budget.writes = writes

      await secureTokenStore.save(after).catch(() => undefined)

      const loaded = await secureTokenStore.load()
      expect(loaded).not.toBeNull()
      expect(loaded!.refreshToken).toBe(writes === 0 ? 'refresh-1' : 'refresh-2')
      expect(loaded!.expiresAt).toBe(writes === 3 ? 2_000 : 1_000)
    }
  })

  it('keeps whether the next sign-in asks for the password, apart from the tokens', async () => {
    expect(await secureTokenStore.loginRequired()).toBe(false)

    await secureTokenStore.setLoginRequired(true)
    await secureTokenStore.save(null)
    await secureTokenStore.forgetUser()
    expect(await secureTokenStore.loginRequired()).toBe(true)

    await secureTokenStore.setLoginRequired(false)
    expect(await secureTokenStore.loginRequired()).toBe(false)
    expect(items.size).toBe(0)
  })

  it('reads the refresh token on its own, also when the rest of the set is gone', async () => {
    items.set('auth.refreshToken', 'refresh-left')

    expect(await secureTokenStore.load()).toBeNull()
    expect(await secureTokenStore.refreshToken()).toBe('refresh-left')
  })
})
