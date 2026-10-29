import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { BillingStatus } from '@tresso/core'
import PaymentScreen from '@/components/PaymentScreen.vue'
import { useAuthStore } from '@/stores/auth'
import { useBillingStore } from '@/stores/billing'

const ENDED: BillingStatus = {
  enabled: true,
  entitled: false,
  plans: ['monthly', 'yearly'],
  organizations: [
    { id: 'org-1', name: 'Kim Visser', personal: true, status: 'trial', entitled: false, trialEndsAt: '2026-10-01T00:00:00Z', currentPeriodEnd: null, seats: 1, canManage: true },
    { id: 'org-2', name: 'Support', personal: false, status: 'canceled', entitled: false, trialEndsAt: '2026-09-01T00:00:00Z', currentPeriodEnd: null, seats: 3, canManage: false },
  ],
}

describe('PaymentScreen', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('explains the block and offers the plans to an owner, and an admin to others', async () => {
    const billing = useBillingStore()
    vi.spyOn(billing, 'load').mockImplementation(async () => {
      billing.status = ENDED
      return ENDED
    })
    const open = vi.spyOn(billing, 'open').mockResolvedValue()

    const screen = mount(PaymentScreen)
    await flushPromises()

    expect(screen.text()).toContain('Your free trial has ended')
    expect(screen.text()).toContain('The free trial has ended.')
    expect(screen.text()).toContain('Ask an owner or admin of Support to renew it.')
    const buttons = screen.findAll('button').map((button) => button.text())
    expect(buttons).toEqual(['Subscribe monthly', 'Subscribe yearly', 'I have paid, check again', 'Sign out'])

    await screen.findAll('button')[1]!.trigger('click')
    expect(open).toHaveBeenCalledWith('org-1', { plan: 'yearly' })
  })

  it('asks again, and says so when the payment did not come through yet', async () => {
    const billing = useBillingStore()
    const load = vi.spyOn(billing, 'load').mockImplementation(async () => {
      billing.status = ENDED
      return ENDED
    })
    const screen = mount(PaymentScreen)
    await flushPromises()

    await screen.findAll('button').find((button) => button.text() === 'I have paid, check again')!.trigger('click')
    await flushPromises()

    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.text()).toContain('Still not subscribed.')
  })

  it('names an ended trial, and explains a billing status that could not be loaded', async () => {
    const billing = useBillingStore()
    vi.spyOn(billing, 'load').mockRejectedValueOnce(new Error('Failed to fetch'))

    const screen = mount(PaymentScreen, { attachTo: document.body })
    await flushPromises()
    expect(screen.text()).toContain('Failed to fetch')
    expect(document.activeElement?.id).toBe('payment-title')

    billing.status = ENDED
    await flushPromises()
    expect(screen.text()).toContain('Your free trial has ended')
    screen.unmount()
  })

  it('signs out', async () => {
    const auth = useAuthStore()
    const signOut = vi.spyOn(auth, 'signOut').mockResolvedValue()
    vi.spyOn(useBillingStore(), 'load').mockResolvedValue(ENDED)

    const screen = mount(PaymentScreen)
    await screen.findAll('button').find((button) => button.text() === 'Sign out')!.trigger('click')

    expect(signOut).toHaveBeenCalled()
  })
})
