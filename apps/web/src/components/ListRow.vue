<script setup lang="ts">
/**
 * One row of a list on a card (the List row board): a mark, a title with one line under it, quiet meta and at most one
 * control at the end. Title and line are cut to one line. An inline edit form replaces them through the `text` slot,
 * beside the mark (the Editing state on the SettingsAccounts board): that column is never cut, may wrap and grow, and
 * the meta and the action then line up with its top. What belongs under the row (an attention row) goes in the default
 * slot. Rows of one kind sit next to each other in one card, inside a container with role="list", with a hairline
 * between them. Layout only: the row handles no clicks; `dir="auto"` on names and addresses is the caller's.
 */
defineSlots<{
  mark?: () => unknown
  text?: () => unknown
  title?: () => unknown
  line?: () => unknown
  meta?: () => unknown
  action?: () => unknown
  default?: () => unknown
}>()
</script>

<template>
  <div role="listitem" class="list-row">
    <div class="main" :class="{ open: $slots.text }">
      <span v-if="$slots.mark" class="mark"><slot name="mark" /></span>
      <span class="text">
        <slot name="text">
          <span class="title"><slot name="title" /></span>
          <span v-if="$slots.line" class="line"><slot name="line" /></span>
        </slot>
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
/* A column given through `text` (an inline edit form) may grow: the parts at the end stay at its top. */
.main.open .meta,
.main.open .action {
  align-self: flex-start;
}
</style>
