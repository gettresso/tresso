import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { BillingStatus } from '@tresso/core'

const desktop = vi.hoisted(() => ({ isDesktop: false, opened: [] as string[] }))

vi.mock('@/platform/desktop', () => ({
  get isDesktop() {
    return desktop.isDesktop
  },
  openInBrowser: async (url: string) => {
    desktop.opened.push(url)
  },
}))

vi.mock('@/platform/webPush', () => ({ disableWebPush: async () => undefined }))

const { useAuthStore } = await import('@/stores/auth')
const { useBillingStore } = await import('@/stores/billing')

const BLOCKED: BillingStatus = {
  enabled: true,
  entitled: false,
  plans: ['monthly'],
  organizations: [
    { id: 'org-1', name: 'Kim', personal: true, status: 'trial', entitled: false, trialEndsAt: '2026-10-01T00:00:00Z', currentPeriodEnd: null, seats: 1, canManage: true },
  ],
}

describe('billing store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    desktop.isDesktop = false
    desktop.opened = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears the payment screen once the server says the user may use it again', async () => {
    const auth = useAuthStore()
    auth.paymentRequired = true
    vi.spyOn(auth, 'api').mockResolvedValueOnce(BLOCKED).mockResolvedValueOnce({ ...BLOCKED, entitled: true })
    const billing = useBillingStore()

    await billing.load()
    expect(auth.paymentRequired).toBe(true)

    await billing.load()
    expect(auth.paymentRequired).toBe(false)
    expect(billing.status?.entitled).toBe(true)
  })

  it('opens Checkout here on the web, and in the system browser on desktop', async () => {
    const auth = useAuthStore()
    const send = vi.spyOn(auth, 'send').mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_1' })
    const assign = vi.fn<(url: string) => void>()
    vi.stubGlobal('location', { ...window.location, assign })
    const billing = useBillingStore()

    await billing.open('org-1', { plan: 'monthly' })
    expect(send).toHaveBeenCalledWith('POST', '/api/v1/billing/checkout', { organizationId: 'org-1', plan: 'monthly' })
    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_1')

    desktop.isDesktop = true
    await billing.open('org-1', 'portal')
    expect(send).toHaveBeenLastCalledWith('POST', '/api/v1/billing/portal', { organizationId: 'org-1' })
    expect(desktop.opened).toEqual(['https://checkout.stripe.com/c/pay/cs_1'])
  })

  it('shows why a Stripe page could not be opened', async () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'send').mockRejectedValue(new Error('This organization already has a subscription; manage it in the billing portal.'))
    const billing = useBillingStore()

    await billing.open('org-1', { plan: 'monthly' })

    expect(billing.error).toContain('already has a subscription')
    expect(billing.opening).toBe(false)
  })
})

describe('auth store and 402', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('puts up the payment screen when the server answers 402, and takes it down on sign-out', async () => {
    const auth = useAuthStore()
    auth.tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ title: 'Payment Required', status: 402 }), { status: 402 })))

    await expect(auth.api('/api/v1/me')).rejects.toMatchObject({ status: 402 })
    expect(auth.paymentRequired).toBe(true)

    await auth.signOut()
    expect(auth.paymentRequired).toBe(false)
  })
})
