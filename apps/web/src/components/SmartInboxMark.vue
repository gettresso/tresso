<script setup lang="ts">
import { computed } from 'vue'
import { smartInboxIcon, type SyncedSmartInbox } from '@tresso/core'
import AppIcon from '@/components/AppIcon.vue'

/**
 * The line icon of a smart inbox, in the second ink. The icon follows the built-in kind, never the name; the name is
 * written next to it by the caller, so the icon is decoration and hidden from assistive technology.
 */
const props = defineProps<{ smartInbox: Pick<SyncedSmartInbox, 'builtin'> }>()

const icon = computed(() => smartInboxIcon(props.smartInbox))
</script>

<template>
  <AppIcon :name="icon" :size="16" class="smart-inbox-icon" aria-hidden="true" />
</template>

<style scoped>
.smart-inbox-icon {
  flex-shrink: 0;
  color: var(--ink-2);
}
</style>
