import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import { MailProvider, useMail } from '@/mail/MailProvider'
import { databaseName } from '@/mail/mailSession'

const { keychain, disk, browser } = vi.hoisted(() => ({
  browser: { signIn: vi.fn(async (_options: { promptLogin: boolean }) => ({ code: 'the-code', codeVerifier: 'the-verifier' })) },
  keychain: { items: new Map<string, string>(), unreadable: false },
  disk: { files: new Map<string, unknown>(), deleted: [] as string[] },
}))

vi.mock('@/config', () => ({ config: { apiUrl: 'https://api.example.test', clientId: 'mobile', redirectUri: 'tresso://auth/callback' } }))
vi.mock('@/auth/browserSignIn', () => ({ signInInBrowser: browser.signIn }))
vi.mock('@/notifications/expoPush', () => ({ secureDeviceId: {} }))
vi.mock('@/notifications/push', () => ({ forgetPushDevice: async () => undefined }))
vi.mock('expo/fetch', () => ({ fetch: () => new Promise(() => undefined) }))
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => {
    if (keychain.unreadable) {
      throw new Error('User interaction is not allowed.')
    }
    return keychain.items.get(key) ?? null
  },
  setItemAsync: async (key: string, value: string) => {
    keychain.items.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    keychain.items.delete(key)
  },
}))
vi.mock('@/mail/sql', async () => {
  const { memorySql } = await import('@tresso/core/testing/sql')
  return {
    openSql: async (name: string) => {
      if (!disk.files.has(name)) {
        disk.files.set(name, await memorySql())
      }
      return { ...(disk.files.get(name) as object), close: async () => undefined }
    },
    deleteSql: async (name: string) => {
      disk.deleted.push(name)
      disk.files.delete(name)
    },
  }
})

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const KIM = databaseName('kim')
let seen: { auth: ReturnType<typeof useAuth>; mail: ReturnType<typeof useMail> } | null = null

function Probe() {
  const auth = useAuth()
  const mail = useMail()
  useEffect(() => {
    seen = { auth, mail }
  })
  return null
}

function launch() {
  return render(
    <AuthProvider>
      <MailProvider>
        <Probe />
      </MailProvider>
    </AuthProvider>,
  )
}

function keepSignIn(expiresAt: number) {
  keychain.items.set('auth.accessToken', 'access-1')
  keychain.items.set('auth.refreshToken', 'refresh-1')
  keychain.items.set('auth.expiresAt', String(expiresAt))
  keychain.items.set('auth.lastUserId', 'kim')
}

/** The API: who is signed in, an empty delta, and the token endpoint answering `token`. */
function api(token: () => Promise<Response>): Fetch {
  return async (input) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) {
      return token()
    }
    if (url.endsWith('/oauth/revoke')) {
      return new Response(null, { status: 200 })
    }
    if (url.endsWith('/api/v1/me')) {
      return new Response(JSON.stringify({ id: 'kim', email: 'kim@example.test', displayName: 'Kim' }))
    }
    if (url.includes('/api/v1/sync/changes')) {
      return new Response(JSON.stringify({ cursor: 1, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [] }))
    }
    return new Response(null, { status: 404 })
  }
}

describe('when the sign-in ends', () => {
  beforeEach(() => {
    keychain.items.clear()
    keychain.unreadable = false
    disk.files.clear()
    disk.deleted = []
    seen = null
    browser.signIn.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the mail on the phone when the kept sign-in cannot be read at launch, and opens it once it can', async () => {
    keepSignIn(Date.now() + 3_600_000)
    vi.stubGlobal('fetch', vi.fn<Fetch>(api(() => Promise.reject(new TypeError('Network request failed')))))
    const before = launch()
    await waitFor(() => expect(seen?.mail.userId).toBe('kim'))
    before.unmount()
    keychain.unreadable = true

    launch()

    await waitFor(() => expect(seen?.auth.restoreFailed).toBe(true))
    expect(seen?.auth.isAuthenticated).toBe(false)
    expect(seen?.auth.storageError).toBe('The saved sign-in could not be read: User interaction is not allowed.')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(disk.deleted).toEqual([])
    expect(disk.files.has(KIM)).toBe(true)

    keychain.unreadable = false
    await act(() => seen!.auth.retryRestore())

    await waitFor(() => expect(seen?.mail.userId).toBe('kim'))
    expect(seen?.auth.restoreFailed).toBe(false)
    expect(disk.deleted).toEqual([])
  })

  it('keeps the mail on the phone when the sign-in cannot be renewed offline', async () => {
    keepSignIn(Date.now() - 1)
    vi.stubGlobal('fetch', vi.fn<Fetch>(api(() => Promise.reject(new TypeError('Network request failed')))))

    launch()

    await waitFor(() => expect(seen?.mail.userId).toBe('kim'))
    // The refresh is asked once more after 2 seconds before the request fails.
    await waitFor(() => expect(seen?.mail.syncError).toContain('could not be renewed right now'), { timeout: 4_000 })
    expect(seen?.auth.isAuthenticated).toBe(true)
    expect(keychain.items.get('auth.refreshToken')).toBe('refresh-1')
    expect(disk.deleted).toEqual([])
  })

  it('closes the copy and keeps it when the sign-in expired', async () => {
    keepSignIn(Date.now() - 1)
    let refuse: () => void = () => undefined
    const refused = new Promise<Response>((resolve) => (refuse = () => resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))))
    vi.stubGlobal('fetch', vi.fn<Fetch>(api(() => refused)))

    launch()
    await waitFor(() => expect(seen?.mail.userId).toBe('kim'))
    refuse()

    await waitFor(() => expect(seen?.auth.ended).toBe('expired'))
    await waitFor(() => expect(seen?.mail.userId).toBeNull())
    expect(disk.files.has(KIM)).toBe(true)
    expect(disk.deleted).toEqual([])
    expect(keychain.items.get('auth.lastUserId')).toBe('kim')
  })

  it('removes the copy when the user signs out', async () => {
    keepSignIn(Date.now() + 3_600_000)
    const fetchImpl = vi.fn<Fetch>(api(() => Promise.reject(new Error('no refresh in this test'))))
    vi.stubGlobal('fetch', fetchImpl)

    launch()
    await waitFor(() => expect(seen?.mail.userId).toBe('kim'))

    await act(() => seen!.auth.signOut())

    await waitFor(() => expect(disk.deleted).toEqual([KIM]))
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/oauth/revoke'))).toBe(true)
    expect([...keychain.items.keys()]).toEqual(['auth.loginRequired'])
  })

  it('finishes a sign-out that was cut off, also removing the mail, at the next launch', async () => {
    keepSignIn(Date.now() + 3_600_000)
    vi.stubGlobal('fetch', vi.fn<Fetch>(api(() => Promise.reject(new Error('no refresh in this test')))))
    const before = launch()
    await waitFor(() => expect(seen?.mail.userId).toBe('kim'))
    before.unmount()
    // The app was killed right after the sign-out wrote its flag.
    keychain.items.set('auth.loginRequired', 'yes')

    launch()

    await waitFor(() => expect(disk.deleted).toEqual([KIM]))
    expect(seen?.auth.isAuthenticated).toBe(false)
    expect([...keychain.items.keys()]).toEqual(['auth.loginRequired'])
  })

  it('asks for the password at the sign-in after a sign-out, also after a restart, and not once that sign-in completed', async () => {
    keepSignIn(Date.now() + 3_600_000)
    vi.stubGlobal('fetch', vi.fn<Fetch>(api(async () => new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })))))
    const first = launch()
    await waitFor(() => expect(seen?.mail.userId).toBe('kim'))
    await act(() => seen!.auth.signOut())
    first.unmount()

    const second = launch()
    await waitFor(() => expect(seen?.auth.restoring).toBe(false))
    await act(async () => {
      await seen!.auth.signIn()
    })
    expect(browser.signIn).toHaveBeenLastCalledWith({ promptLogin: true })
    await waitFor(() => expect(seen?.mail.userId).toBe('kim'))
    second.unmount()

    launch()
    await waitFor(() => expect(seen?.mail.userId).toBe('kim'))
    expect(await seen!.auth.session.loginRequired()).toBe(false)
  })

  it('does not ask for the password at the sign-in after the sign-in expired', async () => {
    keepSignIn(Date.now() - 1)
    vi.stubGlobal('fetch', vi.fn<Fetch>(api(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))))

    launch()
    await waitFor(() => expect(seen?.auth.ended).toBe('expired'))
    await act(async () => {
      await seen!.auth.signIn().catch(() => undefined)
    })

    expect(browser.signIn).toHaveBeenLastCalledWith({ promptLogin: false })
  })
})
