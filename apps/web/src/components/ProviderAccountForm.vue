<script setup lang="ts">
import { ref } from 'vue'
import { providerName, type MailAccount, type OAuthProviderId, type ProviderFeature } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useAccountsStore } from '@/stores/accounts'
import LogoLoader from '@/components/LogoLoader.vue'

/**
 * Signing a Gmail or Microsoft 365 account in with its provider again, for its row in Settings: the row's More menu and
 * its attention line call `signInAgain`; this says what happens meanwhile (the provider's page opening, the browser to
 * continue in) and why it did not open. Nothing shows while nothing happens.
 */
const props = defineProps<{ account: MailAccount; provider: OAuthProviderId }>()

const accounts = useAccountsStore()
const signingIn = ref(false)
/** The desktop app opened the provider's page in the system browser; the accounts page gets the answer. */
const continueInBrowser = ref(false)
const error = ref<string | null>(null)

/**
 * Opens the provider's sign-in page; the API sends the browser back to the accounts page (in the desktop app, through
 * its `tresso://` link, while the page in the system browser is left behind). Signing in again asks for mail and
 * whatever the account allows already; `['calendar']` allows just the calendars. A second press while the page opens
 * does nothing.
 */
async function signInAgain(features?: ProviderFeature[]): Promise<void> {
  if (signingIn.value) return
  signingIn.value = true
  continueInBrowser.value = false
  error.value = null
  try {
    if ((await accounts.openProviderSignIn(props.provider, props.account.id, features)) === 'browser') {
      signingIn.value = false
      continueInBrowser.value = true
    }
  } catch (e) {
    error.value = errorMessage(e)
    signingIn.value = false
  }
}

defineExpose({ signInAgain, signingIn })
</script>

<template>
  <p v-if="signingIn" class="note" role="status"><LogoLoader /> Opening {{ providerName(provider) }}…</p>
  <p v-else-if="continueInBrowser" class="note" role="status">Continue in your browser. Tresso shows the result here once you have signed in.</p>
  <p v-if="error" class="form-error" role="alert">{{ error }}</p>
</template>

<style scoped>
.note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
}
.form-error {
  margin: 0;
  font-size: 13px;
}
</style>
