import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError } from '@/auth/session'
import { PaymentGate } from '@/components/PaymentGate'

const { auth, notices, expoRouter } = vi.hoisted(() => ({
  auth: {
    isAuthenticated: true,
    paymentRequired: true,
    session: { me: vi.fn<() => Promise<unknown>>() },
    signOut: vi.fn<() => Promise<void>>(),
  },
  notices: { notify: vi.fn<(notice: { text: string; tone: string }) => void>() },
  expoRouter: { canDismiss: vi.fn<() => boolean>(() => true), dismissAll: vi.fn<() => void>() },
}))
vi.mock('@/auth/AuthProvider', () => ({ useAuth: () => auth }))
vi.mock('@/components/Notices', () => ({ useNotices: () => notices }))
vi.mock('expo-router', () => ({ router: expoRouter }))

describe('the payment notice', () => {
  beforeEach(() => {
    auth.paymentRequired = true
    auth.session.me.mockReset()
    auth.signOut.mockReset()
    notices.notify.mockReset()
    expoRouter.dismissAll.mockReset()
  })

  it('covers the app with no way to buy, and closes open modal screens first', () => {
    render(<PaymentGate />)

    expect(screen.getByText('Your Tresso subscription or trial has ended')).toBeTruthy()
    expect(screen.queryByText(/subscribe|buy|price|https?:/i)).toBeNull()
    expect(expoRouter.dismissAll).toHaveBeenCalled()
  })

  it('shows nothing while the user may use the server', () => {
    auth.paymentRequired = false

    const { container } = render(<PaymentGate />)

    expect(container.textContent).toBe('')
  })

  it('tells a server that still says no from one that cannot be reached', async () => {
    auth.session.me.mockRejectedValueOnce(new ApiError(402, 'Payment Required')).mockRejectedValueOnce(new Error('Network request failed'))
    render(<PaymentGate />)

    fireEvent.click(screen.getByText('Check again'))
    await waitFor(() => expect(screen.getByText(/Still not renewed/)).toBeTruthy())

    fireEvent.click(screen.getByText('Check again'))
    await waitFor(() => expect(screen.getByText(/could not be reached: Network request failed/)).toBeTruthy())
  })

  it('warns when signing out could not remove this phone from the notifications', async () => {
    auth.signOut.mockRejectedValueOnce(new Error('The request failed (500).'))
    render(<PaymentGate />)

    fireEvent.click(screen.getByText('Sign out'))

    await waitFor(() => expect(notices.notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', text: expect.stringContaining('may still get your notifications') })))
  })
})
