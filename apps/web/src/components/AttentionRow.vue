<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue'

/**
 * What the user has to fix about the row it sits in (the Attention row board): one line that says what is wrong and one
 * button that fixes it. Orange (`warning`) when a part does not work, red (`danger`) when the thing itself stopped. The
 * text stays ink; only the icon and the tint carry the colour.
 */
const props = defineProps<{ tone: 'warning' | 'danger'; text: string; action?: string }>()
const emit = defineEmits<{ act: [] }>()
</script>

<template>
  <div class="attention" :class="[props.tone, { bare: !props.action }]" :role="props.tone === 'danger' ? 'alert' : 'status'">
    <AppIcon class="icon" :name="props.tone === 'danger' ? 'error' : 'alert'" :size="16" />
    <span class="text">{{ props.text }}</span>
    <button v-if="props.action" type="button" class="button act" @click="emit('act')">{{ props.action }}</button>
  </div>
</template>

<style scoped>
/* 44 high at least, the attention row radius (10, as a tile), the button 6 from the edge. */
.attention {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  min-width: 0;
  min-height: 44px;
  box-sizing: border-box;
  padding: 6px 6px 6px 12px;
  border-radius: var(--radius-card);
}
.attention.bare {
  padding-right: 12px;
}
.attention.warning {
  background: var(--warning-soft);
}
.attention.danger {
  background: var(--danger-soft);
}
.icon {
  flex-shrink: 0;
}
.warning .icon {
  color: var(--warning);
}
.danger .icon {
  color: var(--danger);
}
.text {
  flex: 1 1 220px;
  min-width: 0;
  font-size: 13px;
  line-height: 19px;
  font-weight: 500;
  color: var(--ink);
  overflow-wrap: anywhere;
}
/* The outlined row button: 32 high, the one button this row has. */
.act {
  flex-shrink: 0;
  height: 32px;
  box-sizing: border-box;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
  white-space: nowrap;
}
.act:hover {
  background: color-mix(in srgb, var(--ink) 4.5%, var(--paper));
}
</style>
