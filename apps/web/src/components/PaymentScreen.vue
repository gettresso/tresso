<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { errorMessage } from '@/api/errors'
import BillingPanel from '@/components/BillingPanel.vue'
import { useAuthStore } from '@/stores/auth'
import { useBillingStore } from '@/stores/billing'

/**
 * Covers the app while the server answers 402: the trial or subscription is over. It shows why, lets an owner or admin
 * subscribe or manage the subscription at Stripe, and checks again once they paid. Nothing else works meanwhile; the
 * server decides that, this screen only explains it.
 */
const auth = useAuthStore()
const billing = useBillingStore()
const checking = ref(false)
const stillBlocked = ref(false)

async function checkAgain(): Promise<void> {
  checking.value = true
  stillBlocked.value = false
  try {
    const status = await billing.load()
    if (status.entitled) {
      // Everything that stopped (sync, the mail copy) starts again cleanly.
      window.location.reload()
      return
    }
    stillBlocked.value = true
  } catch (cause) {
    billing.error = errorMessage(cause)
  } finally {
    checking.value = false
  }
}

onMounted(() => {
  billing.load().catch((cause: unknown) => {
    billing.error = errorMessage(cause)
  })
})
</script>

<template>
  <div class="cover">
    <section class="payment" role="dialog" aria-modal="true" aria-labelledby="payment-title">
      <h1 id="payment-title">Your Tresso subscription has ended</h1>
      <p class="lead">Your mail, calendar and todos are kept. Subscribe to pick up where you left off.</p>
      <BillingPanel v-if="billing.status" />
      <p v-else-if="!billing.error" class="hint">Loading…</p>
      <p v-if="stillBlocked" class="hint" role="status">Still not subscribed. A payment can take a moment to come through.</p>
      <div class="footer">
        <button type="button" class="button button-quiet" :disabled="checking" @click="checkAgain">I have paid, check again</button>
        <button type="button" class="button button-quiet" @click="auth.signOut()">Sign out</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cover {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  padding: calc(var(--titlebar, 0px) + 24px) 24px 24px;
  background: var(--canvas);
  overflow: auto;
}
.payment {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: min(640px, 100%);
  padding: 28px;
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--raised);
}
h1 {
  margin: 0;
  font: 700 24px/30px var(--font-display);
}
.lead,
.hint {
  margin: 0;
  color: var(--ink-2);
}
.footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
