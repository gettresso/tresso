import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { BillingStatus } from '@tresso/core'
import SettingsBillingView from '@/views/SettingsBillingView.vue'
import { useBillingStore } from '@/stores/billing'

const route = vi.hoisted(() => ({ query: {} as Record<string, string> }))
const router = vi.hoisted(() => ({ replace: vi.fn<(to: unknown) => void>() }))

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => router,
}))

const TRIAL: BillingStatus = {
  enabled: true,
  entitled: true,
  plans: ['monthly'],
  organizations: [
    { id: 'org-1', name: 'Kim Visser', personal: true, status: 'trial', entitled: true, trialEndsAt: '2099-01-01T00:00:00Z', currentPeriodEnd: null, seats: 1, canManage: true },
  ],
}
const SUBSCRIBED: BillingStatus = {
  ...TRIAL,
  organizations: [{ ...TRIAL.organizations[0]!, status: 'active', currentPeriodEnd: '2099-02-01T00:00:00Z' }],
}

function stubLoad(...answers: BillingStatus[]) {
  const billing = useBillingStore()
  const load = vi.spyOn(billing, 'load')
  for (const answer of answers) {
    load.mockImplementationOnce(async () => {
      billing.status = answer
      return answer
    })
  }
  return load
}

describe('SettingsBillingView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    route.query = {}
    router.replace.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the trial with the plans to subscribe to', async () => {
    stubLoad(TRIAL)

    const view = mount(SettingsBillingView)
    await flushPromises()

    expect(view.text()).toContain('Free trial')
    expect(view.text()).toContain('Subscribe monthly')
  })

  it('waits for Stripe after Checkout until the subscription shows', async () => {
    vi.useFakeTimers()
    route.query = { checkout: 'done' }
    const load = stubLoad(TRIAL, SUBSCRIBED)

    const view = mount(SettingsBillingView)
    await flushPromises()
    expect(router.replace).toHaveBeenCalledWith({ query: {} })
    expect(view.text()).toContain('Confirming the payment')

    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()

    expect(load).toHaveBeenCalledTimes(2)
    expect(view.text()).toContain('Thank you, you are subscribed.')
    expect(view.text()).toContain('Manage subscription')
  })

  it('says a cancelled checkout charged nothing', async () => {
    route.query = { checkout: 'cancelled' }
    stubLoad(TRIAL)

    const view = mount(SettingsBillingView)
    await flushPromises()

    expect(view.text()).toContain('nothing was charged')
  })

  it('says when the server does not bill', async () => {
    stubLoad({ enabled: false, entitled: true, plans: [], organizations: [] })

    const view = mount(SettingsBillingView)
    await flushPromises()

    expect(view.text()).toContain('This server does not bill')
  })
})
