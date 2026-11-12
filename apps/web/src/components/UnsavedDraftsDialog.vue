<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { backdropClose } from '@/components/backdropClose'
import LogoLoader from '@/components/LogoLoader.vue'

/**
 * Asked before a sign-out removes the mail on this device while drafts in it never reached the server (written
 * offline, say): they would be deleted with it. The user can try to save them first, sign out anyway, or stay.
 * `failed` says that a try to save them did not bring all of them up.
 */
const props = defineProps<{ count: number; saving: boolean; failed: boolean }>()
const emit = defineEmits<{ save: []; signOut: []; cancel: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
onMounted(() => dialog.value?.showModal?.())

function cancel(): void {
  if (!props.saving) emit('cancel')
}
// A click on the backdrop cancels, like Escape; not while the drafts are being saved.
const backdrop = backdropClose(cancel)

const question = computed(() =>
  props.count === 1
    ? '1 draft on this device was never saved to the server. Sign out and delete it?'
    : `${props.count} drafts on this device were never saved to the server. Sign out and delete them?`,
)
</script>

<template>
  <dialog
    ref="dialog"
    class="confirm-dialog"
    role="alertdialog"
    aria-labelledby="unsaved-drafts-title"
    aria-describedby="unsaved-drafts-description"
    @cancel.prevent="cancel"
    @pointerdown="backdrop.onPointerdown"
    @click="backdrop.onClick"
  >
    <h2 id="unsaved-drafts-title">Sign out?</h2>
    <p id="unsaved-drafts-description">{{ question }}</p>
    <p v-if="failed" class="form-error" role="alert">Saving did not work for all of them. Try again once you are online, or sign out anyway.</p>
    <div class="actions">
      <button type="button" class="button button-primary" :disabled="saving" @click="emit('save')">
        <template v-if="saving"><LogoLoader tone="current" /> Saving…</template><template v-else>{{ count === 1 ? 'Try to save it first' : 'Try to save them first' }}</template>
      </button>
      <button type="button" class="button button-danger" :disabled="saving" @click="emit('signOut')">Sign out anyway</button>
      <button type="button" class="button button-quiet" :disabled="saving" @click="cancel">Cancel</button>
    </div>
  </dialog>
</template>

<style scoped>
.confirm-dialog {
  animation: pop-in var(--motion-base) var(--ease-out);
  width: min(460px, calc(100vw - 32px));
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  color: var(--ink);
  box-shadow: var(--raised);
}
.confirm-dialog h2 {
  margin: 0 0 8px;
  font: 700 18px/24px var(--font-display);
}
.confirm-dialog p {
  margin: 0 0 16px;
  color: var(--ink-2);
}
.confirm-dialog p.form-error {
  color: var(--danger);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
