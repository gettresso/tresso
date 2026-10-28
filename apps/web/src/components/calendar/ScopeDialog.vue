<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { SCOPE_LABELS, scopeHint, type EditScope } from '@tresso/core'
import { backdropClose } from '@/components/backdropClose'

/** Asks which events of a series a deletion applies to. */
const props = defineProps<{ scopes: EditScope[]; title: string; busy: boolean; notifyCount: number }>()
const emit = defineEmits<{ confirm: [scope: EditScope, notify: boolean]; cancel: [] }>()

const scope = ref<EditScope>(props.scopes[0] ?? 'this')
const notify = ref(true)
const dialog = ref<HTMLDialogElement | null>(null)

onMounted(() => dialog.value?.showModal?.())
// A click on the backdrop cancels, like Escape.
const backdrop = backdropClose(() => emit('cancel'))
</script>

<template>
  <dialog ref="dialog" class="scope-dialog" aria-labelledby="scope-title" @cancel.prevent="emit('cancel')" @pointerdown="backdrop.onPointerdown" @click="backdrop.onClick">
    <form method="dialog" @submit.prevent="emit('confirm', scope, notify)">
      <h2 id="scope-title">{{ title }}</h2>
      <fieldset v-if="scopes.length > 0">
        <legend class="visually-hidden">Which events</legend>
        <label v-for="option in scopes" :key="option" class="option">
          <input v-model="scope" type="radio" name="scope" :value="option" />
          <span>
            <strong>{{ SCOPE_LABELS[option] }}</strong>
            <small>{{ scopeHint(option, true) }}</small>
          </span>
        </label>
      </fieldset>
      <label v-if="notifyCount > 0" class="option">
        <input v-model="notify" type="checkbox" />
        <span>Tell {{ notifyCount === 1 ? 'the guest' : `the ${notifyCount} guests` }}</span>
      </label>
      <div class="actions">
        <button type="submit" class="button button-danger" :disabled="busy">Delete</button>
        <button type="button" class="button button-quiet" @click="emit('cancel')">Keep it</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.scope-dialog {
  animation: pop-in var(--motion-base) var(--ease-out);
  width: min(420px, calc(100vw - 32px));
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  color: var(--ink);
  box-shadow: var(--raised);
}
h2 {
  margin: 0 0 12px;
  font: 700 18px/24px var(--font-display);
}
fieldset {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 12px;
  padding: 0;
  border: 0;
}
.option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.option span {
  display: flex;
  flex-direction: column;
}
.option small {
  color: var(--ink-2);
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
</style>
