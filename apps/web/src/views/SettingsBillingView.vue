<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { hasSubscription } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import BillingPanel from '@/components/BillingPanel.vue'
import { useBillingStore } from '@/stores/billing'

/** The subscription of each of the user's organizations; Stripe Checkout and the portal return here. */
const billing = useBillingStore()
const route = useRoute()
const router = useRouter()
const notice = ref<string | null>(null)

/** After Checkout, Stripe's webhook takes a moment: look again a few times until the subscription shows. */
const WAIT_TRIES = 10
const WAIT_MS = 3000
let timer: ReturnType<typeof setTimeout> | null = null

async function waitForSubscription(tries: number): Promise<void> {
  const status = await billing.load()
  if (status.organizations.some((organization) => organization.canManage && hasSubscription(organization)) || tries <= 1) {
    notice.value = status.entitled ? 'Thank you, you are subscribed.' : 'The payment is still being processed. This page shows it once Stripe confirms.'
    return
  }
  timer = setTimeout(() => {
    waitForSubscription(tries - 1).catch((cause: unknown) => (billing.error = errorMessage(cause)))
  }, WAIT_MS)
}

onMounted(async () => {
  const checkout = route.query.checkout
  if (checkout !== undefined) {
    // The address is the bookmark Stripe returns to; it should not say "done" again on the next visit.
    void router.replace({ query: {} })
  }
  try {
    if (checkout === 'done') {
      notice.value = 'Confirming the payment…'
      await waitForSubscription(WAIT_TRIES)
    } else {
      if (checkout === 'cancelled') {
        notice.value = 'Checkout was cancelled; nothing was charged.'
      }
      await billing.load()
    }
  } catch (cause) {
    billing.error = errorMessage(cause)
  }
})

onBeforeUnmount(() => {
  if (timer !== null) {
    clearTimeout(timer)
  }
})
</script>

<template>
  <section class="billing">
    <header>
      <h2>Subscription</h2>
      <p>Tresso Cloud is paid per member. Everything Tresso does is the same on your own server, for free.</p>
    </header>
    <p v-if="notice" class="hint" role="status">{{ notice }}</p>
    <BillingPanel v-if="billing.status?.enabled" />
    <p v-else-if="billing.status" class="hint">This server does not bill: everything is included.</p>
    <p v-else-if="billing.error" class="form-error" role="alert">{{ billing.error }}</p>
  </section>
</template>

<style scoped>
.billing {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 640px;
}
h2 {
  margin: 0 0 4px;
  font: 700 22px/28px var(--font-display);
}
header p,
.hint {
  margin: 0;
  color: var(--ink-2);
}
</style>
