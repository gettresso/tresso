<script setup lang="ts">
/**
 * One row of a list on a card (the List row board): a mark, a title with one line under it, quiet meta and at most one
 * control at the end. What belongs to the row (an attention row, an inline edit form) goes in the default slot, under
 * it. Rows of one kind sit next to each other in one card, inside a container with role="list", with a hairline
 * between them. Layout only: the row handles no clicks; `dir="auto"` on names and addresses is the caller's.
 */
defineSlots<{
  mark?: () => unknown
  title?: () => unknown
  line?: () => unknown
  meta?: () => unknown
  action?: () => unknown
  default?: () => unknown
}>()
</script>

<template>
  <div role="listitem" class="list-row">
    <div class="main">
      <span v-if="$slots.mark" class="mark"><slot name="mark" /></span>
      <span class="text">
        <span class="title"><slot name="title" /></span>
        <span v-if="$slots.line" class="line"><slot name="line" /></span>
      </span>
      <span v-if="$slots.meta" class="meta"><slot name="meta" /></span>
      <span v-if="$slots.action" class="action"><slot name="action" /></span>
    </div>
    <slot />
  </div>
</template>

<style scoped>
/* 64 high at least: a 36 tile, 14 above and below, 16 at the sides, 12 between its parts. */
.list-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
}
.list-row + .list-row {
  border-top: 1px solid var(--line);
}
.main {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 36px;
}
.mark {
  flex-shrink: 0;
  align-self: flex-start;
  display: flex;
}
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.title,
.line {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title {
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--ink);
}
.line {
  font-size: 13px;
  line-height: 19px;
  color: var(--ink-2);
}
.meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--ink-2);
  white-space: nowrap;
}
.action {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}
</style>
