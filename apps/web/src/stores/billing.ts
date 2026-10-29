import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { BillingPage, BillingPlan, BillingStatus } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { isDesktop, openInBrowser } from '@/platform/desktop'
import { useAuthStore } from '@/stores/auth'

/** What a server that predates billing (no /api/v1/billing) amounts to: nothing is billed. */
const NOT_BILLED: BillingStatus = { enabled: false, entitled: true, plans: [], organizations: [] }

/**
 * The signed-in user's billing (docs/BILLING.md). The server alone decides access: this store only shows what it says
 * and opens Stripe's pages. On a server that does not bill, `status.enabled` is false and nothing here shows.
 */
export const useBillingStore = defineStore('billing', () => {
  const auth = useAuthStore()
  const status = ref<BillingStatus | null>(null)
  const error = ref<string | null>(null)
  /** A Stripe page is being made or opened, so its buttons wait. */
  const opening = ref(false)

  async function load(): Promise<BillingStatus> {
    const session = auth.generation
    let next: BillingStatus
    try {
      next = await auth.api<BillingStatus>('/api/v1/billing')
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 404)) {
        throw cause
      }
      next = NOT_BILLED
    }
    if (session !== auth.generation) {
      // Signed out meanwhile: the answer belongs to the previous session.
      return next
    }
    status.value = next
    error.value = null
    if (next.entitled && auth.paymentRequired) {
      // Everything stopped where the server blocked it (the mail copy, sync); a reload starts it all again cleanly.
      window.location.reload()
    }
    return next
  }

  /** Opens Stripe Checkout for the plan, or the billing portal: in the system browser on desktop, here on the web. */
  async function open(organizationId: string, page: { plan: BillingPlan } | 'portal'): Promise<void> {
    opening.value = true
    error.value = null
    let leaving = false
    try {
      const { url } =
        page === 'portal'
          ? await auth.send<BillingPage>('POST', '/api/v1/billing/portal', { organizationId })
          : await auth.send<BillingPage>('POST', '/api/v1/billing/checkout', { organizationId, plan: page.plan })
      if (!isStripePage(url)) {
        throw new Error('The server sent a payment page that is not a secure web address; it was not opened.')
      }
      if (isDesktop) {
        await openInBrowser(url)
      } else {
        // This page goes away; its buttons stay disabled until it does, so a second click makes no second checkout.
        // Coming back from Stripe with Back may restore this very page from the browser's cache: enable them again.
        leaving = true
        window.addEventListener('pageshow', () => (opening.value = false), { once: true })
        window.location.assign(url)
      }
    } catch (cause) {
      error.value = errorMessage(cause)
    } finally {
      opening.value = leaving
    }
  }

  function reset(): void {
    status.value = null
    error.value = null
    opening.value = false
  }

  return { status, error, opening, load, open, reset }
})

/** Only an https address is opened: anything else (javascript:, a plain http page) is no payment page. */
function isStripePage(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
