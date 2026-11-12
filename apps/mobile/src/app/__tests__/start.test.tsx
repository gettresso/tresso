import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Start from '@/app/index'

type Auth = {
  restoring: boolean
  isAuthenticated: boolean
  restoreFailed: boolean
  storageError: string | null
  ended: 'signedOut' | 'expired' | null
  signingOut: boolean
  signIn: ReturnType<typeof vi.fn>
  signOut: ReturnType<typeof vi.fn>
  retryRestore: ReturnType<typeof vi.fn>
}

const { auth, mail } = vi.hoisted(() => ({
  auth: {} as Auth,
  mail: {
    mailAccounts: async () => [],
    store: () => null,
    todos: async () => [],
    handOvers: async () => [],
    version: 0,
    live: true,
    status: { kind: 'catchingUp', text: 'Catching up: 12,400 changes to go', fraction: 0.4, remaining: 12_400, notice: 'Catching up on changes. What you see may be out of date until it is done.', announcement: 'Catching up, 25%' },
  },
}))
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => auth }))
vi.mock('@/mail/MailProvider', () => ({ useMail: () => mail }))
vi.mock('@/brief/useDailyBrief', () => ({ useLatestBrief: () => ({ left: 0 }) }))
vi.mock('@/components/Notices', () => ({ useNotices: () => ({ notify: () => {} }) }))
vi.mock('@/components/InboxList', () => ({ InboxList: ({ header }: { header: React.ReactNode }) => header }))
vi.mock('@/compose/ComposerProvider', () => ({ useComposer: () => ({ composer: { openNew: () => {} } }) }))
vi.mock('@/components/Icon', () => ({ Icon: () => null }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }))
vi.mock('react-native-safe-area-context', async () => {
  const { View } = await import('react-native')
  return { SafeAreaView: View }
})

function button(name: string): HTMLElement {
  return screen.getByRole('button', { name })
}

describe('the start screen', () => {
  beforeEach(() => {
    Object.assign(auth, {
      restoring: false,
      isAuthenticated: false,
      restoreFailed: false,
      storageError: null,
      ended: null,
      signingOut: false,
      signIn: vi.fn(async () => true),
      signOut: vi.fn(async () => undefined),
      retryRestore: vi.fn(async () => undefined),
    })
  })

  it('says the session expired and the mail stayed when the sign-in ended that way', () => {
    auth.ended = 'expired'
    render(<Start />)

    expect(screen.getByText('Your session has expired. Your mail is still on this phone.')).toBeTruthy()
  })

  it('says nothing about an expiry after a sign-out', () => {
    auth.ended = 'signedOut'
    render(<Start />)

    expect(screen.queryByText(/Your session has expired/)).toBeNull()
  })

  it('shows the sign-out under way on the sign-in button, and does not sign in before it is done', () => {
    auth.ended = 'signedOut'
    auth.signingOut = true
    render(<Start />)

    const signIn = button('Signing out…')
    expect(signIn.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(signIn)
    expect(auth.signIn).not.toHaveBeenCalled()
  })

  it('shows the sign-out under way on its button, and does not start a second one', () => {
    auth.isAuthenticated = true
    auth.signingOut = true
    render(<Start />)

    const signOut = button('Signing out…')
    expect(signOut.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(signOut)
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('signs out from the Sign out button', () => {
    auth.isAuthenticated = true
    render(<Start />)

    fireEvent.click(button('Sign out'))
    expect(auth.signOut).toHaveBeenCalledOnce()
  })

  it('says under the title how far the sync is, and that the list may be out of date meanwhile', () => {
    auth.isAuthenticated = true
    render(<Start />)

    expect(screen.getByText('Catching up: 12,400 changes to go')).toBeTruthy()
    expect(screen.getByText('Catching up on changes. What you see may be out of date until it is done.')).toBeTruthy()
    expect(screen.getByTestId('sync-progress')).toBeTruthy()
    expect(screen.queryByText(/not live/)).toBeNull()
  })
})
