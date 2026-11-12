<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { backdropClose } from '@/components/backdropClose'
import LogoLoader from '@/components/LogoLoader.vue'

/**
 * Asked before a sign-out removes the mail on this device while drafts in it never reached the server (written
 * offline, say): they would be deleted with it. The user can try to save them first, sign out anyway, or stay.
 * `failed` says that a try to save them did not bring all of them up. With `count` null, whether there are such
 * drafts could not be checked (`checkError` says why): only signing out anyway or staying is offered.
 */
const props = defineProps<{ count: number | null; checkError: string | null; saving: boolean; failed: boolean }>()
const emit = defineEmits<{ save: []; signOut: []; cancel: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
let unmounted = false
onMounted(() => dialog.value?.showModal?.())
onBeforeUnmount(() => {
  unmounted = true
})

/**
 * The browser closed the dialog itself: Chromium lets a page refuse Escape (cancel) only once without a click or key
 * in between, then closes anyway (as HandOverDialog handles it). While the drafts are being saved the dialog comes
 * back, so the outcome stays in view; otherwise closing it this way is Cancel.
 */
function closed(): void {
  if (unmounted) {
    return
  }
  if (props.saving) {
    dialog.value?.showModal?.()
    return
  }
  emit('cancel')
}

function cancel(): void {
  if (!props.saving) emit('cancel')
}
// A click on the backdrop cancels, like Escape; not while the drafts are being saved.
const backdrop = backdropClose(cancel)

const question = computed(() =>
  props.count === null
    ? `Tresso could not check this device for drafts that were never saved to the server (${props.checkError ?? 'unknown reason'}). Signing out deletes the mail on this device, with any such drafts. Sign out anyway?`
    : props.count === 1
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
    @close="closed"
    @pointerdown="backdrop.onPointerdown"
    @click="backdrop.onClick"
  >
    <h2 id="unsaved-drafts-title">Sign out?</h2>
    <p id="unsaved-drafts-description">{{ question }}</p>
    <p v-if="failed" class="form-error" role="alert">{{ count === 1 ? 'Saving it did not work.' : 'Saving did not work for all of them.' }} Try again once you are online, or sign out anyway.</p>
    <div class="actions">
      <button v-if="count !== null" type="button" class="button button-primary" :disabled="saving" @click="emit('save')">
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
