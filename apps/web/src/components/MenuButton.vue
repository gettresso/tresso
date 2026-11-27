<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import { useAnchoredMenu } from '@/components/anchoredMenu'

export interface MenuItem {
  id: string
  label: string
  /** Removes or ends something: red, and last in the menu under a rule (the Actions board). */
  danger?: boolean
}

/**
 * A button that opens a menu of choices: browsing them with the keyboard does nothing; choosing one does. The `more`
 * variant is the three-dot More button of a row: it shows no text, so `label` is its accessible name ("More for
 * kim@company.example"), and its menu lines up with the button's end edge.
 */
const props = defineProps<{
  label: string
  menuLabel: string
  items: MenuItem[]
  icon?: InstanceType<typeof AppIcon>['$props']['name']
  disabled?: boolean
  variant?: 'text' | 'more'
}>()
const emit = defineEmits<{ choose: [id: string] }>()

const open = ref(false)
const menu = ref<HTMLElement | null>(null)
const button = ref<HTMLButtonElement | null>(null)
// The variant is how the button is drawn where it is used; it does not change while the button is on screen.
const more = props.variant === 'more'
const { style: menuStyle, above: menuAbove } = useAnchoredMenu(button, menu, open, more ? 'end' : 'start')
const regular = computed(() => props.items.filter((item) => item.danger !== true))
const dangerous = computed(() => props.items.filter((item) => item.danger === true))

defineExpose({ open, show })

/** Opens the menu with the focus on its first choice; nothing while the button is disabled or has no choices. */
async function show(): Promise<void> {
  if (props.disabled || props.items.length === 0) {
    return
  }
  open.value = true
  await nextTick()
  menu.value?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
}

function close(): void {
  open.value = false
  button.value?.focus()
}

// Escape closes the menu, and goes no further (the list would otherwise let go of a selection too).
function escape(event: KeyboardEvent): void {
  if (open.value) {
    event.preventDefault()
    close()
  }
}

function choose(id: string): void {
  open.value = false
  emit('choose', id)
}

function keydown(event: KeyboardEvent): void {
  const items = [...(menu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const focus = (next: number) => items[(next + items.length) % items.length]?.focus()
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      focus(index + 1)
      break
    case 'ArrowUp':
      event.preventDefault()
      focus(index - 1)
      break
    case 'Home':
      event.preventDefault()
      focus(0)
      break
    case 'End':
      event.preventDefault()
      focus(items.length - 1)
      break
    case 'Escape':
    case 'Tab':
      event.preventDefault()
      close()
      break
  }
}

// A click elsewhere closes the menu.
function outside(event: MouseEvent): void {
  const target = event.target as Node | null
  if (open.value && target !== null && !menu.value?.contains(target) && !button.value?.contains(target)) {
    open.value = false
  }
}
// In the capture phase: a press on the macOS app's title strip is stopped at the document by Tauri's drag handling.
onMounted(() => document.addEventListener('mousedown', outside, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', outside, true))
</script>

<template>
  <div class="move" @keydown.esc="escape">
    <button
      v-if="more"
      ref="button"
      type="button"
      class="tool more"
      :aria-label="label"
      :disabled="props.disabled || items.length === 0"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open ? close() : show()"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">
        <path d="M5 12h.01 M12 12h.01 M19 12h.01" />
      </svg>
    </button>
    <button v-else ref="button" type="button" class="tool" :disabled="props.disabled || items.length === 0" aria-haspopup="menu" :aria-expanded="open" @click="open ? close() : show()">
      <AppIcon v-if="icon" :name="icon" /> {{ label }}
    </button>
    <!-- On the body: a glass panel around the button would otherwise become the frame of this fixed menu and cut it off. -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="open" ref="menu" class="menu" :class="{ above: menuAbove, end: more }" :style="menuStyle" role="menu" :aria-label="menuLabel" @keydown="keydown">
          <button v-for="item in regular" :key="item.id" type="button" role="menuitem" tabindex="-1" class="item" @click="choose(item.id)">{{ item.label }}</button>
          <div v-if="regular.length > 0 && dangerous.length > 0" role="separator" class="rule" />
          <button v-for="item in dangerous" :key="item.id" type="button" role="menuitem" tabindex="-1" class="item danger" @click="choose(item.id)">{{ item.label }}</button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.move {
  position: relative;
}
.tool {
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  font: inherit;
  cursor: pointer;
}
.tool:hover:not(:disabled) {
  background: var(--ground);
  color: var(--ink);
}
.tool:focus-visible,
.item:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.tool:disabled {
  opacity: 0.5;
  cursor: default;
}
/* The three-dot More button of a row: 32 square, the open one on the tile (the Actions board). */
.tool.more {
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
}
.tool.more[aria-expanded='true'] {
  background: var(--tile);
  color: var(--ink-2);
}
.menu {
  transform-origin: top left;
  animation: pop-in var(--motion-fast) var(--ease-out);
  z-index: 50;
  display: flex;
  flex-direction: column;
  min-width: 200px;
  max-height: min(320px, var(--menu-room, 320px));
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--raised);
}
.menu.above {
  transform-origin: bottom left;
}
.menu.end {
  transform-origin: top right;
}
.menu.end.above {
  transform-origin: bottom right;
}
/* 32 high, 13/20 at 500 (the Actions board). */
.item {
  flex-shrink: 0;
  min-height: 32px;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}
.item:hover,
.item:focus {
  background: var(--ground);
}
.item.danger {
  color: var(--danger);
}
.rule {
  flex-shrink: 0;
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}
</style>
