import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { BillingPage, BillingPlan, BillingStatus } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { isDesktop, openInBrowser } from '@/platform/desktop'
import { useAuthStore } from '@/stores/auth'

/**
 * The signed-in user's billing (docs/BILLING.md). The server alone decides access: this store only shows what it says
 * and opens Stripe's pages. On a server that does not bill, `status.enabled` is false and nothing here shows.
 */
export const useBillingStore = defineStore('billing', () => {
  const auth = useAuthStore()
  const status = ref<BillingStatus | null>(null)
  const error = ref<string | null>(null)
  /** A Stripe page is being made, so its button waits. */
  const opening = ref(false)

  async function load(): Promise<BillingStatus> {
    const next = await auth.api<BillingStatus>('/api/v1/billing')
    status.value = next
    error.value = null
    if (next.entitled) {
      auth.paymentRequired = false
    }
    return next
  }

  /** Opens Stripe Checkout for the plan, or the billing portal: in the system browser on desktop, here on the web. */
  async function open(organizationId: string, page: { plan: BillingPlan } | 'portal'): Promise<void> {
    opening.value = true
    error.value = null
    try {
      const { url } =
        page === 'portal'
          ? await auth.send<BillingPage>('POST', '/api/v1/billing/portal', { organizationId })
          : await auth.send<BillingPage>('POST', '/api/v1/billing/checkout', { organizationId, plan: page.plan })
      if (isDesktop) {
        await openInBrowser(url)
      } else {
        window.location.assign(url)
      }
    } catch (cause) {
      error.value = errorMessage(cause)
    } finally {
      opening.value = false
    }
  }

  function reset(): void {
    status.value = null
    error.value = null
  }

  return { status, error, opening, load, open, reset }
})
