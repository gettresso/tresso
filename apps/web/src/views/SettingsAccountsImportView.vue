<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AccountImportList from '@/components/connect/AccountImportList.vue'
import AccountImportPaste from '@/components/connect/AccountImportPaste.vue'

/**
 * Settings, Accounts, Add several accounts: step 1 pastes the addresses (/settings/accounts/import), step 2 is the list
 * the user connects (/settings/accounts/import/:importId), which an assistant's link also opens.
 */
const route = useRoute()
const importId = computed(() => (typeof route.params.importId === 'string' && route.params.importId !== '' ? route.params.importId : null))
</script>

<template>
  <AccountImportList v-if="importId" :key="importId" :import-id="importId" />
  <AccountImportPaste v-else />
</template>
