<script setup lang="ts">
import { useMailStore } from '@/stores/mail'

/**
 * A quiet line above a list while what it shows may be out of date: the copy is still getting the mail, catching up
 * after a long time away, updating after an update, or could not sync for a while (see describeSync). Nothing blocks;
 * the footer of the sidebar says how far it is and announces it.
 */
const mail = useMailStore()
</script>

<template>
  <p v-if="mail.syncStatus.notice !== null" class="sync-notice">{{ mail.syncStatus.notice }}</p>
</template>

<style scoped>
.sync-notice {
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--radius-control);
  background: var(--ground);
  color: var(--ink-2);
  font-size: 12px;
}
</style>
