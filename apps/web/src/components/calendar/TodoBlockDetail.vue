<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { dueLabel, longDate, todoBlockTimes, toWall, type TodoBlock } from '@tresso/core'
import { TODO_COLOR } from '@/calendar/look'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{
  block: TodoBlock
  zone: string
  now: number
  busy: boolean
  error: string | null
}>()
const emit = defineEmits<{ close: []; plan: []; unplan: []; done: [] }>()

const todo = computed(() => props.block.todo)
const due = computed(() => dueLabel(todo.value, new Date(props.now)))
const when = computed(() => `${longDate(toWall(props.block.start, props.zone), toWall(props.now, props.zone))}, ${todoBlockTimes(props.block, props.zone)}`)
</script>

<template>
  <aside class="detail" role="dialog" aria-modal="false" aria-labelledby="todo-block-title" :style="TODO_COLOR" @keydown.esc.stop="emit('close')">
    <header class="header">
      <span class="swatch" aria-hidden="true"><AppIcon name="todo" :size="14" /></span>
      <h2 id="todo-block-title">{{ todo.title }}</h2>
      <button type="button" class="button button-quiet icon" aria-label="Close" @click="emit('close')"><AppIcon name="close" /></button>
    </header>

    <p class="when">{{ when }}</p>
    <p class="line"><AppIcon name="calendar" :size="15" /> Planned for this todo, busy for others</p>
    <p v-if="due" class="line"><AppIcon name="clock" :size="15" /> Due {{ due }}</p>
    <p v-if="block.conflict" class="conflict" role="status">This time is taken now, and nothing else is free before the due date. Plan again or remove it.</p>
    <p v-if="todo.notes" class="notes">{{ todo.notes }}</p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <footer class="actions">
      <button type="button" class="button button-primary" :disabled="busy" @click="emit('done')">Done</button>
      <button type="button" class="button button-quiet" :disabled="busy" @click="emit('plan')">Plan again</button>
      <button type="button" class="button button-quiet" :disabled="busy" @click="emit('unplan')">Remove from calendar</button>
    </footer>
    <RouterLink class="open-todo" :to="{ name: 'todo', params: { todoId: todo.id } }">Open the todo</RouterLink>
  </aside>
</template>

<style scoped>
.detail {
  animation: fade-in var(--motion-base) ease-out;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 340px;
  max-width: 100%;
  padding: 16px;
  border-left: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--raised);
  overflow-y: auto;
}
.header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.swatch {
  flex: none;
  display: flex;
  margin-top: 5px;
  color: var(--cal);
}
h2 {
  flex: 1;
  margin: 0;
  font: 700 18px/24px var(--font-display);
  overflow-wrap: anywhere;
}
.icon {
  width: 32px;
  height: 32px;
  padding: 0;
}
p {
  margin: 0;
}
.when {
  font-weight: 600;
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-2);
  font-size: 13px;
}
.notes {
  white-space: pre-wrap;
  font-size: 13px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.conflict,
.error {
  color: var(--danger);
  font-size: 13px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.open-todo {
  font-size: 13px;
}
</style>
