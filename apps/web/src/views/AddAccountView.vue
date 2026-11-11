<script setup lang="ts">
import { useRouter } from 'vue-router'
import ConnectMailDialog from '@/components/connect/ConnectMailDialog.vue'
import SettingsAccountsView from '@/views/SettingsAccountsView.vue'

/**
 * /settings/accounts/new: the accounts, with the dialog that connects a new one over them. It has an address of its
 * own because provider sign-ins come back here (ProviderConnector::ADD_PATH, and the desktop app's link), and every
 * "Add account" in the app leads here.
 */
const router = useRouter()

function close(openAccountId: string | null): void {
  // The first account's inbox, once it is connected; otherwise back to the accounts behind the dialog.
  void router.push(openAccountId !== null ? { name: 'account', params: { accountId: openAccountId } } : { name: 'settings-accounts' })
}
</script>

<template>
  <SettingsAccountsView :finishes-sign-in="false" />
  <ConnectMailDialog @close="close" />
</template>
