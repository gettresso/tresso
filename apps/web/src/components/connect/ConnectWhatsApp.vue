<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import AppIcon from '@/components/AppIcon.vue'
import ProviderMark from '@/components/ProviderMark.vue'
import WhatsAppLink from '@/components/chat/WhatsAppLink.vue'
import {
  ASK_COPY_BODY,
  ASK_COPY_TITLE,
  CONNECT_LEAD,
  FAILURES,
  IMPORT_DAYS,
  PLACE_ALL_NOTE,
  PLACE_LOCAL_NOTE,
  REMOVE_BODY,
  REMOVE_TITLE,
  RISK_CONFIRM,
  RISK_TEXT,
  linkStage,
  linkedTitle,
} from '@/components/chat/whatsappTexts'

/**
 * Connect WhatsApp (the ConnectWhatsApp board): three steps, one primary button each.
 * 1. Before you start: the risk, confirmed with the box; nothing starts before it is ticked. Show QR code.
 * 2. Scan: Tresso starts its own link to WhatsApp and shows the code (Getting a code, the code, The code expired).
 * 3. Linked: once the phone scanned, WhatsApp is connected at once and the recent chats come in; the dialog shows the
 *    reading and where the chats live. "Only this Mac" is chosen unless the dialog was opened to take the relay over
 *    from another Mac (`mode` all with another relay there): then the chats are on the server already and nothing is
 *    asked. Picking "All my devices" asks first whether the chats may be copied to the server; picking "Only this Mac"
 *    again asks before they are removed from it. Done waits for the answer.
 * A failure (it could not start, the phone signed Tresso out) is one pattern: a title, one sentence, one button.
 *
 * A modal <dialog>: the rest of the page is inert while it is open, Escape closes it, and focus goes back to what
 * opened it. Close or Done leave it; reading goes on, and Settings shows it.
 */
const props = defineProps<{
  /** The place chosen when the dialog opens; "Only this Mac" unless the user came to take the relay over. */
  mode?: 'local' | 'all'
}>()
const emit = defineEmits<{ close: []; done: [] }>()
const wa = useWhatsAppRelayStore()
const dialog = ref<HTMLDialogElement | null>(null)
/** Show QR code was pressed in this dialog: the link steps show from here on. */
const started = ref(false)
/** Where the chats live, as picked in the dialog. */
const place = ref<'local' | 'all'>(props.mode ?? 'local')
/** The question open behind a pick of "All my devices" (copy) or of "Only this Mac" after copying (remove). */
const asking = ref<'copy' | 'remove' | null>(null)
/** Connected from this dialog: the linked step shows the reading and the place. */
const connectedHere = ref(false)
/**
 * The dialog was opened to take the relay over from another Mac (`mode` all) and the server's account is there: the
 * chats are on the server already, so nothing is asked. Checked again when the phone has linked.
 */
const takeOverFromOther = computed(() => props.mode === 'all' && wa.otherRelay !== null)
const askAnswer = ref<HTMLButtonElement | null>(null)
const PLACES = [
  { id: 'local', title: 'Only this Mac', note: PLACE_LOCAL_NOTE },
  { id: 'all', title: 'All my devices', note: PLACE_ALL_NOTE },
] as const
/** While a question is open, the place it asks about shows as picked (the board's "All my devices asks first"). */
const shownPlace = computed(() => (asking.value === 'copy' ? 'all' : asking.value === 'remove' ? 'local' : place.value))
const placeButtons = ref<HTMLButtonElement[]>([])
let opener: HTMLElement | null = null
/** The control the question was opened from, for the focus to go back to. */
let askedFrom: HTMLElement | null = null

const stage = computed(() => linkStage(wa.bridge))
/** The longest wait for a code before the dialog says it could not start (whatsmeow's first code takes seconds). */
const CODE_WAIT_MS = 60_000
/** A code was asked for and none came within CODE_WAIT_MS: a backstop, so the dialog never spins forever. */
const codeLate = ref(false)
let codeTimer: ReturnType<typeof setTimeout> | null = null
/** The connect after the phone linked was made by itself once; after that it waits for Try again. */
let connectTried = false
/** A code was shown in this dialog: only then is a stopped, unlinked bridge "The code expired" (not a relink starting). */
const codeShown = ref(false)
/** The expired tile: a code shown here timed out, and no start runs. */
const expiredShown = computed(() => codeShown.value && wa.busy === null)
/** The step the dialog shows. */
const view = computed<'start' | 'link' | 'linked' | 'problem'>(() => {
  if (connectedHere.value || (wa.connected && wa.linked)) {
    return 'linked'
  }
  if (!started.value) {
    return 'start'
  }
  // Failed, or stopped from outside with nothing to say (no error, no code on its way, no restart planned: the shell's
  // snapshot says `restarting` during its backoff, which linkStage counts as loading), or a code that never came: all
  // end in the could-not-start pattern with Try again, never on a spinner.
  // A relink starts from stopped and unlinked: before a code was shown here that is idle too, so a refused start shows
  // at once.
  const stopped = stage.value === 'idle' || (stage.value === 'expired' && !codeShown.value)
  if (stage.value === 'failed' || (stopped && wa.busy === null) || codeLate.value) {
    return 'problem'
  }
  return stage.value === 'linked' ? 'linked' : 'link'
})
/** The failure the problem step names: the bridge's, or a start the shell refused (its words, from the store). */
const problem = computed(() =>
  wa.bridge.error !== null && !codeLate.value
    ? FAILURES[wa.bridge.error]
    : { title: FAILURES.exited.title, text: wa.error ?? FAILURES.exited.text, action: FAILURES.exited.action },
)
/** Linked, not connected, no question open and nothing running: the connect waits for Try again. */
const connectStuck = computed(() => view.value === 'linked' && !wa.connected && wa.askNumber === null && wa.busy === null)
/** Linked and not connected, whatever runs: closing now undoes the link (the store's cancel), so the dialog says so. */
const unlinksOnClose = computed(() => view.value === 'linked' && !wa.connected)
const reading = computed(() => wa.importState !== 'done')
const progressText = computed(() => (reading.value ? `Reading chats from the last ${IMPORT_DAYS} days…` : 'Chats read'))
/** Done waits for an open question and for a change of the place under way. */
const doneDisabled = computed(() => asking.value !== null || wa.busy === 'mode' || wa.busy === 'connect')

/** What the live region says: changes of step only, never a new code or a tick of the reading. */
const announcement = computed(() => {
  switch (view.value) {
    case 'link':
      return stage.value === 'scan' ? 'A code to scan is shown.' : stage.value === 'expired' && expiredShown.value ? 'The code expired.' : 'Getting a code.'
    case 'linked':
      return reading.value ? 'Linked. Reading your recent chats.' : 'Linked. Your recent chats are in.'
    default:
      return ''
  }
})

/** Show QR code, Try again, Link again: starts Tresso's link to WhatsApp, only once the risk was confirmed. */
async function showCode(): Promise<void> {
  if (!wa.riskAccepted || wa.busy !== null) {
    return
  }
  if (view.value === 'problem' && wa.bridge.error === 'missing') {
    // A part of Tresso is missing: starting again cannot help, the one button closes.
    emit('close')
    return
  }
  started.value = true
  codeLate.value = false
  await wa.start({ link: true })
}

// The backstop: while a code is on its way (also while a start still waits for other work, or a relink starts from a
// stopped, unlinked state), a timer; a code, a link or any other step ends it.
watch(
  () => view.value === 'link' && stage.value !== 'scan' && !(stage.value === 'expired' && expiredShown.value),
  (waiting) => {
    if (codeTimer !== null) {
      clearTimeout(codeTimer)
      codeTimer = null
    }
    if (waiting) {
      codeTimer = setTimeout(() => (codeLate.value = true), CODE_WAIT_MS)
    }
  },
)

// A code or the link that arrives late takes back the backstop's word; a code shown makes a later stop "expired".
watch(stage, (now) => {
  if (now === 'scan') {
    codeShown.value = true
  }
  if (now === 'scan' || now === 'linked') {
    codeLate.value = false
  }
})

/** The phone linked: WhatsApp is connected at once (the reading starts). */
async function connect(numberConfirmed = false): Promise<void> {
  if (wa.connected || wa.busy !== null) {
    return
  }
  connectTried = true
  const takeOver = place.value === 'all' && takeOverFromOther.value
  if (!takeOver) {
    // Copying to the server is asked first, after connecting on this Mac.
    place.value = 'local'
  }
  if (await wa.connect(takeOver ? 'all' : 'local', { number: numberConfirmed })) {
    connectedHere.value = true
  }
}

// Once, by itself, as soon as the phone linked and nothing else runs (a start still finishing makes it wait).
watch(
  () => view.value === 'linked' && !wa.connected && wa.busy === null && !connectTried,
  (due) => {
    if (due) {
      void connect()
    }
  },
  { immediate: true },
)

// Every step change puts focus on the step's heading: the button that was pressed may be gone.
watch(view, async () => {
  await nextTick()
  dialog.value?.querySelector<HTMLElement>('h1')?.focus()
})

async function ask(kind: 'copy' | 'remove'): Promise<void> {
  askedFrom = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  asking.value = kind
  await nextTick()
  askAnswer.value?.focus()
}

/** A place picked: "All my devices" asks before copying, "Only this Mac" asks before removing what was copied. */
function pick(next: 'local' | 'all'): void {
  if (asking.value !== null || wa.busy !== null || next === place.value) {
    return
  }
  void ask(next === 'all' ? 'copy' : 'remove')
}

async function answer(yes: boolean): Promise<void> {
  const kind = asking.value
  asking.value = null
  if (yes && kind !== null) {
    const to = kind === 'copy' ? 'all' : 'local'
    if (await wa.switchMode(to, { copy: to === 'all' })) {
      place.value = to
    }
  }
  await nextTick()
  // Back where the question came from; the picked place when that went.
  ;(askedFrom?.isConnected ? askedFrom : placeButtons.value[place.value === 'all' ? 1 : 0])?.focus()
  askedFrom = null
}

/** The number question of "All my devices" was answered yes: the step it stopped is done again with that yes. */
async function relayAnyway(): Promise<void> {
  if (wa.askNumber === 'connect') {
    await connect(true)
  } else if (wa.askNumber === 'mode' && (await wa.switchMode('all', { copy: true, number: true }))) {
    place.value = 'all'
  }
}

/** Enter presses the step's one button, unless it lands on a control that handles it (a button, a link). */
function onEnter(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (event.isComposing || target?.closest('button, a, select, textarea, input')) {
    return
  }
  event.preventDefault()
  if (view.value === 'start' || view.value === 'problem') {
    void showCode()
  } else if (view.value === 'linked') {
    // What the step's visible primary button does: Try again while the connect waits for it, Done once connected,
    // nothing while a question is open or something runs.
    if (connectStuck.value) {
      void connect()
    } else if (wa.connected && !doneDisabled.value && wa.askNumber === null) {
      emit('done')
    }
  }
}

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  if (wa.connected) {
    place.value = wa.mode ?? place.value
  }
  dialog.value?.showModal?.()
})
onUnmounted(() => {
  if (codeTimer !== null) {
    clearTimeout(codeTimer)
  }
  // Out of the page, so nothing is inert any more: the element that opened the dialog takes focus again.
  const target = opener
  void nextTick(() => {
    if (target?.isConnected) {
      target.focus()
    }
  })
})
</script>

<template>
  <dialog ref="dialog" class="wa-dialog" aria-labelledby="wa-title" @cancel.prevent="emit('close')" @keydown.enter="onEnter">
    <div class="head">
      <span class="eyebrow">Tresso for Mac</span>
      <button type="button" class="icon-button" aria-label="Close" @click="emit('close')"><AppIcon name="close" :size="18" /></button>
    </div>

    <template v-if="view === 'start'">
      <div class="intro">
        <span class="logo"><ProviderMark kind="whatsapp" :size="48" /></span>
        <div class="heading">
          <h1 id="wa-title" tabindex="-1">Connect WhatsApp</h1>
          <p class="lead">{{ CONNECT_LEAD }}</p>
        </div>
      </div>
      <div class="notice">
        <div class="risk">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3l9.5 17h-19z" />
            <path d="M12 10v4M12 17.5v.01" />
          </svg>
          <p id="wa-risk">{{ RISK_TEXT }}</p>
        </div>
        <label class="confirm">
          <input v-model="wa.riskAccepted" type="checkbox" aria-describedby="wa-risk" />
          <span>{{ RISK_CONFIRM }}</span>
        </label>
      </div>
      <p v-if="wa.error" class="error" role="alert">{{ wa.error }}</p>
      <div class="footer">
        <button type="button" class="button button-primary big" :disabled="!wa.riskAccepted || wa.busy !== null" @click="showCode">Show QR code</button>
      </div>
    </template>

    <template v-else-if="view === 'link'">
      <h1 id="wa-title" tabindex="-1">Scan this code with your phone</h1>
      <WhatsAppLink :expired-shown="expiredShown" />
    </template>

    <template v-else-if="view === 'linked'">
      <div class="intro">
        <span class="mark ok" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </span>
        <div class="heading">
          <h1 id="wa-title" tabindex="-1" dir="auto">{{ linkedTitle(wa.identity) }}</h1>
          <p v-if="wa.identity?.name" class="lead" dir="auto">{{ wa.identity.name }}</p>
        </div>
      </div>
      <p v-if="wa.connected" class="progress">
        <svg v-if="reading" class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke-opacity="0.16" />
          <path d="M12 3a9 9 0 019 9" />
        </svg>
        <svg v-else class="read" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        <span>{{ progressText }}</span>
      </p>
      <div role="radiogroup" aria-labelledby="wa-place" class="places">
        <span id="wa-place" class="strong">Where your WhatsApp messages live</span>
        <button
          v-for="option in PLACES"
          :key="option.id"
          ref="placeButtons"
          type="button"
          role="radio"
          class="place"
          :class="{ on: shownPlace === option.id }"
          :aria-checked="shownPlace === option.id"
          :disabled="!wa.connected || wa.busy !== null"
          @click="pick(option.id)"
        >
          <span class="ring"><span class="dot" /></span>
          <span class="place-text">
            <span class="strong">{{ option.title }}</span>
            <span class="quiet">{{ option.note }}</span>
          </span>
        </button>
      </div>
      <div v-if="asking" class="ask" role="alertdialog" aria-labelledby="wa-ask-title" aria-describedby="wa-ask-body">
        <span id="wa-ask-title" class="strong">{{ asking === 'copy' ? ASK_COPY_TITLE : REMOVE_TITLE }}</span>
        <span id="wa-ask-body" class="quiet">{{ asking === 'copy' ? ASK_COPY_BODY : REMOVE_BODY }}</span>
        <div class="actions">
          <button type="button" class="button small" :class="asking === 'copy' ? 'button-primary' : 'button-danger'" @click="answer(true)">{{ asking === 'copy' ? 'Copy' : 'Remove' }}</button>
          <button ref="askAnswer" type="button" class="button button-quiet small" @click="answer(false)">Cancel</button>
        </div>
      </div>
      <div v-if="wa.askNumber === 'connect' || wa.askNumber === 'mode'" class="ask" role="alertdialog" aria-labelledby="wa-number-title">
        <span id="wa-number-title" class="strong">{{ wa.error }}</span>
        <div class="actions">
          <button type="button" class="button button-danger small" :disabled="wa.busy !== null" @click="relayAnyway">Relay from this Mac</button>
          <button type="button" class="button button-quiet small" :disabled="wa.busy !== null" @click="wa.error = null; wa.askNumber = null">Cancel</button>
        </div>
      </div>
      <p v-else-if="wa.error" class="error" role="alert">{{ wa.error }}</p>
      <p v-if="unlinksOnClose" class="quiet">Closing now unlinks this Mac from your phone again.</p>
      <div class="footer">
        <button v-if="connectStuck" type="button" class="button button-primary big" @click="connect()">Try again</button>
        <button v-else type="button" class="button button-primary big" :disabled="doneDisabled || !wa.connected" @click="emit('done')">Done</button>
      </div>
    </template>

    <template v-else>
      <div class="intro problem" role="alert">
        <span class="mark bad" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.01" /></svg>
        </span>
        <div class="heading">
          <h1 id="wa-title" tabindex="-1">{{ problem.title }}</h1>
          <p class="lead">{{ problem.text }}</p>
        </div>
      </div>
      <div class="footer">
        <button type="button" class="button button-primary big" :disabled="wa.busy !== null" @click="showCode">{{ problem.action }}</button>
      </div>
    </template>

    <p class="visually-hidden" role="status">{{ announcement }}</p>
  </dialog>
</template>

<style scoped>
.wa-dialog {
  box-sizing: border-box;
  width: min(500px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  padding: 24px 28px 28px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--paper);
  color: var(--ink);
  box-shadow: var(--raised);
  animation: pop-in var(--motion-base) var(--ease-out);
}
.wa-dialog[open] {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
}
.eyebrow {
  flex: 1;
  color: var(--ink-2);
  font-size: 13px;
  font-weight: 600;
}
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--paper);
  color: var(--ink-2);
  cursor: pointer;
}
.intro {
  display: flex;
  align-items: center;
  gap: 16px;
}
.intro.problem {
  align-items: flex-start;
}
.logo {
  display: flex;
  flex-shrink: 0;
}
.logo :deep(.tile) {
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 999px !important;
  background: var(--paper);
}
.mark {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 999px;
}
.mark.ok {
  background: var(--know-soft);
  color: var(--know);
}
.mark.bad {
  background: var(--danger-soft);
  color: var(--danger);
}
.heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
/* The heading takes focus at each step change (for the screen reader and the keyboard), not to be clicked: no ring. */
h1:focus {
  outline: none;
}
h1 {
  margin: 0;
  font: 700 26px/32px var(--font-display);
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.lead {
  margin: 0;
  color: var(--ink-2);
  font-size: 15px;
  line-height: 22px;
}
.notice {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  border-radius: 16px;
  background: var(--ground);
}
.risk {
  display: flex;
  gap: 12px;
}
.risk svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--delegate);
}
.risk p {
  margin: 0;
  font-size: 14px;
  line-height: 21px;
}
.confirm {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: 14px;
  font-weight: 600;
  line-height: 21px;
  cursor: pointer;
}
.confirm input {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  margin: 1px 0 0;
  accent-color: var(--ink);
}
.progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 14px;
  line-height: 21px;
}
.progress svg {
  flex-shrink: 0;
}
.read {
  color: var(--know);
}
.places {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.strong {
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
}
.quiet {
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
}
.place {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border: 0;
  border-radius: 16px;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.place.on {
  background: var(--selected);
  box-shadow: inset 0 0 0 1px var(--focus);
}
.place:disabled {
  cursor: default;
}
.ring {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border: 1.5px solid var(--line-strong);
  border-radius: 999px;
}
.place.on .ring {
  border-color: var(--focus);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}
.place.on .dot {
  background: var(--focus);
}
.place-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ask {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 6px;
}
.button.small {
  height: 36px;
  padding: 0 18px;
  font-size: 14px;
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
  font-weight: 500;
}
.footer {
  display: flex;
  justify-content: flex-end;
}
.button.big {
  height: 46px;
  padding: 0 24px;
  font-size: 15px;
}
.spin {
  animation: wa-spin 0.9s linear infinite;
}
@keyframes wa-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .wa-dialog,
  .spin {
    animation: none;
  }
}
@media (max-width: 600px) {
  .wa-dialog {
    padding: 20px 16px;
  }
}
</style>
