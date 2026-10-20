<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'

export interface MenuItem {
  id: string
  label: string
}

/** A button that opens a menu of choices: browsing them with the keyboard does nothing; choosing one does. */
const props = defineProps<{ label: string; menuLabel: string; items: MenuItem[]; icon?: InstanceType<typeof AppIcon>['$props']['name']; disabled?: boolean }>()
const emit = defineEmits<{ choose: [id: string] }>()

const open = ref(false)
const menu = ref<HTMLElement | null>(null)
const button = ref<HTMLButtonElement | null>(null)

defineExpose({ open })

async function show(): Promise<void> {
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
onMounted(() => document.addEventListener('mousedown', outside))
onBeforeUnmount(() => document.removeEventListener('mousedown', outside))
</script>

<template>
  <div class="move" @keydown.esc="escape">
    <button ref="button" type="button" class="tool" :disabled="props.disabled || items.length === 0" aria-haspopup="menu" :aria-expanded="open" @click="open ? close() : show()">
      <AppIcon v-if="icon" :name="icon" /> {{ label }}
    </button>
    <div v-if="open" ref="menu" class="menu" role="menu" :aria-label="menuLabel" @keydown="keydown">
      <button v-for="item in items" :key="item.id" type="button" role="menuitem" tabindex="-1" class="item" @click="choose(item.id)">{{ item.label }}</button>
    </div>
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
.menu {
  transform-origin: top left;
  animation: pop-in var(--motion-fast) var(--ease-out);
  position: absolute;
  top: 40px;
  left: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  min-width: 200px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--raised);
}
.item {
  padding: 8px 12px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.item:hover,
.item:focus {
  background: var(--selected);
}
</style>
