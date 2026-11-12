<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import AppIcon from '@/components/AppIcon.vue'
import WhatsAppLink from '@/components/chat/WhatsAppLink.vue'
import {
  BRIDGE_NOTE,
  BUILD_COMMAND,
  FOLDER_NOTE,
  IMPORT_NOTE,
  INSTALL_URL,
  LINK_NOTE,
  RISK_CONFIRM,
  RISK_TEXT,
  bridgeIdle,
  bridgeText,
  folderText,
  importText,
  linkText,
  shortFolder,
} from '@/components/chat/whatsappTexts'

/**
 * Connect WhatsApp (the ConnectWhatsApp board, with the plan's corrections): the folder, the bridge, the link to the
 * phone and the first import, each a check that is ticked once done, in order. Nothing links before the user confirmed
 * the risk; "Only this Mac" is the only mode in this release. After Connect it stays open to show the import; Done or
 * Close leave it (the import goes on, Settings shows it).
 *
 * A modal <dialog>: the rest of the page is inert while it is open, Escape closes it, and focus goes back to what
 * opened it.
 */
const emit = defineEmits<{ close: [] }>()
const wa = useWhatsAppRelayStore()
const dialog = ref<HTMLDialogElement | null>(null)
/** Connected from this dialog: it now shows the import and offers Done. */
const connectedHere = ref(false)
let opener: HTMLElement | null = null

const folderView = computed(() => folderText(wa.inspection))
const bridgeView = computed(() => bridgeText(wa.bridge, wa.bridgeStarted))
const linkView = computed(() => linkText(wa.bridge, wa.identity))
const importView = computed(() =>
  importText(connectedHere.value ? wa.importState : 'waiting', {
    messages: wa.progress?.stored ?? 0,
    chats: wa.progress?.chats ?? 0,
    stored: wa.chatCount,
    refused: wa.stuckRefused,
  }),
)

const folderDone = computed(() => folderView.value.ok)
const bridgeDone = computed(() => wa.bridge.process === 'owned' && wa.bridge.port !== null && wa.bridge.error === null)
const linkDone = computed(() => wa.linked)
const importDone = computed(() => connectedHere.value && wa.importState === 'done')
const canStart = computed(() => folderDone.value && wa.riskAccepted && wa.busy === null)
const canConnect = computed(() => folderDone.value && bridgeDone.value && linkDone.value && wa.busy === null && !wa.connected)
/** Start the bridge (first time), or start it again after it stopped or failed. */
const startLabel = computed(() => (bridgeIdle(wa.bridge) && !wa.bridgeStarted ? 'Start the bridge' : 'Start again'))
const showStart = computed(() => wa.bridge.process === 'stopped' && !linkView.value.expired)

/** What the live region says: changes of stage only, never a tick of the import or a new code. */
const announcement = computed(() => {
  if (connectedHere.value) {
    return wa.importState === 'done' ? 'Your recent chats are in.' : wa.importState === 'stuck' ? 'Reading your chats is stuck.' : 'Reading your recent chats.'
  }
  if (bridgeView.value.problem !== null) {
    return `The bridge is not running: ${bridgeView.value.status}.`
  }
  if (linkDone.value) {
    return `${linkView.value.status}.`
  }
  if (linkView.value.qr) {
    return 'A code to scan is shown.'
  }
  if (linkView.value.expired) {
    return 'The code expired.'
  }
  if (wa.bridge.process === 'owned') {
    return 'Starting the bridge.'
  }
  return folderDone.value ? 'Folder found.' : ''
})

function stateOf(done: boolean): 'done' | 'open' {
  return done ? 'done' : 'open'
}

async function connect(): Promise<void> {
  if (!canConnect.value) {
    return
  }
  if (await wa.connect()) {
    connectedHere.value = true
  }
}

/** Enter presses the main button, unless it lands on a control that handles it (a button, a link). */
function onEnter(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (event.isComposing || target?.closest('button, a, select, textarea')) {
    return
  }
  event.preventDefault()
  if (connectedHere.value) {
    emit('close')
  } else {
    void connect()
  }
}

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  dialog.value?.showModal?.()
})
onUnmounted(() => {
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
  <dialog ref="dialog" class="wa-dialog" aria-labelledby="wa-title" aria-describedby="wa-intro" @cancel.prevent="emit('close')" @keydown.enter="onEnter">
    <div class="head">
      <span class="eyebrow">Tresso for Mac</span>
      <button type="button" class="icon-button" aria-label="Close" @click="emit('close')"><AppIcon name="close" :size="18" /></button>
    </div>

    <div class="intro">
      <span class="mark" aria-hidden="true">WA</span>
      <div class="heading">
        <h1 id="wa-title">Connect WhatsApp</h1>
        <p id="wa-intro" class="lead">Read and answer your WhatsApp chats next to your mail. Tresso talks to whatsapp-mcp running on this Mac; your phone stays the WhatsApp account.</p>
      </div>
    </div>

    <div class="risk">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3l9.5 17h-19z" />
        <path d="M12 10v4M12 17.5v.01" />
      </svg>
      <div class="risk-text">
        <p id="wa-risk">{{ RISK_TEXT }}</p>
        <label class="confirm">
          <input v-model="wa.riskAccepted" type="checkbox" aria-describedby="wa-risk" :disabled="wa.bridgeStarted || wa.connected" />
          <span>{{ RISK_CONFIRM }}</span>
        </label>
      </div>
    </div>

    <ol class="checks" aria-label="Checks">
      <li :class="stateOf(folderDone)">
        <span class="badge" aria-hidden="true"><svg v-if="folderDone" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg><template v-else>1</template></span>
        <span class="body">
          <span class="title-line">
            <span class="title">whatsapp-mcp found</span>
            <span class="status">{{ folderView.status }}</span>
            <span class="visually-hidden">{{ folderDone ? '(done)' : '(not done)' }}</span>
          </span>
          <span class="note">{{ FOLDER_NOTE }}</span>
          <span class="field-row">
            <span class="path" :class="{ empty: wa.folder === null }">{{ wa.folder === null ? 'No folder chosen' : shortFolder(wa.folder) }}</span>
            <button type="button" class="button small" :disabled="wa.busy !== null || wa.connected" @click="wa.chooseFolder()">Choose folder</button>
          </span>
          <span v-if="folderView.detail" class="detail">{{ folderView.detail }}</span>
          <code v-if="wa.inspection?.found && !wa.inspection.built" class="command">{{ BUILD_COMMAND }}</code>
        </span>
      </li>

      <li :class="stateOf(bridgeDone)">
        <span class="badge" aria-hidden="true"><svg v-if="bridgeDone" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg><template v-else>2</template></span>
        <span class="body">
          <span class="title-line">
            <span class="title">Bridge running</span>
            <span class="status" :class="{ problem: bridgeView.problem !== null }">{{ bridgeView.status }}</span>
            <span class="visually-hidden">{{ bridgeDone ? '(done)' : '(not done)' }}</span>
          </span>
          <span class="note">{{ BRIDGE_NOTE }}</span>
          <span v-if="bridgeView.detail" class="detail" :class="{ problem: bridgeView.problem !== null }">{{ bridgeView.detail }}</span>
          <code v-if="bridgeView.problem === 'not_built' || bridgeView.problem === 'unprotected'" class="command">{{ BUILD_COMMAND }}</code>
          <span v-if="showStart" class="field-row">
            <button type="button" class="button small" :disabled="!canStart" :aria-describedby="wa.riskAccepted ? undefined : 'wa-start-hint'" @click="wa.start()">{{ startLabel }}</button>
            <span v-if="!wa.riskAccepted" id="wa-start-hint" class="hint">Confirm the risk above to start the bridge.</span>
          </span>
        </span>
      </li>

      <li :class="stateOf(linkDone)">
        <span class="badge" aria-hidden="true"><svg v-if="linkDone" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg><template v-else>3</template></span>
        <span class="body">
          <span class="title-line">
            <span class="title">Linked to your phone</span>
            <span class="status">{{ linkView.status }}</span>
            <span class="visually-hidden">{{ linkDone ? '(done)' : '(not done)' }}</span>
          </span>
          <WhatsAppLink v-if="!linkDone && (wa.bridge.process === 'owned' || linkView.expired)" />
          <span v-else class="note">{{ LINK_NOTE }}</span>
        </span>
      </li>

      <li :class="stateOf(importDone)">
        <span class="badge" aria-hidden="true"><svg v-if="importDone" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg><template v-else>4</template></span>
        <span class="body">
          <span class="title-line">
            <span class="title">Recent chats read</span>
            <span class="status" :class="{ problem: wa.importState === 'stuck' && connectedHere }">{{ importView.status }}</span>
            <span class="visually-hidden">{{ importDone ? '(done)' : '(not done)' }}</span>
          </span>
          <span class="note">{{ IMPORT_NOTE }}</span>
          <span v-if="importView.detail" class="detail">{{ importView.detail }}</span>
        </span>
      </li>
    </ol>

    <fieldset class="places">
      <legend>Where your WhatsApp messages live</legend>
      <label class="place" :class="{ on: true }">
        <input type="radio" name="wa-place" value="local" checked />
        <span class="place-text">
          <span class="place-title">Only this Mac</span>
          <span class="place-note">Chats never leave this computer. Web and mobile do not show WhatsApp.</span>
        </span>
      </label>
      <label class="place off">
        <input type="radio" name="wa-place" value="all" disabled />
        <span class="place-text">
          <span class="place-title">All my devices</span>
          <span class="place-note">This Mac passes your chats to your Tresso server, so web and mobile show them too. Replies from other devices are sent once this Mac is online.</span>
          <span class="place-note">Coming in a later version.</span>
        </span>
      </label>
    </fieldset>

    <p class="visually-hidden" role="status">{{ announcement }}</p>
    <p v-if="wa.error" class="error" role="alert">{{ wa.error }}</p>

    <div class="footer">
      <a :href="INSTALL_URL" target="_blank" rel="noopener noreferrer" class="install">How to install whatsapp-mcp</a>
      <button v-if="connectedHere" type="button" class="button button-primary big" @click="emit('close')">Done</button>
      <button v-else type="button" class="button button-primary big" :disabled="!canConnect" @click="connect">
        Connect WhatsApp<kbd>Enter</kbd>
      </button>
    </div>
  </dialog>
</template>

<style scoped>
.wa-dialog {
  width: min(720px, calc(100vw - 32px));
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
  gap: 20px;
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
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
  align-items: flex-start;
  gap: 16px;
}
.mark {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 999px;
  background: var(--know);
  color: var(--paper);
  font: 700 15px var(--font-display);
}
.heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
h1 {
  margin: 0;
  font: 700 28px/34px var(--font-display);
}
.lead {
  margin: 0;
  color: var(--ink-2);
  font-size: 14px;
  line-height: 21px;
}
.risk {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-card);
  background: var(--delegate-soft);
  color: var(--delegate);
}
.risk svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.risk-text {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--ink);
  font-size: 14px;
  line-height: 21px;
}
.risk-text p {
  margin: 0;
}
.confirm {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-weight: 600;
  cursor: pointer;
}
.confirm input {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin: 3px 0 0;
}
.checks {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}
.checks li {
  display: flex;
  gap: 14px;
  padding: 16px;
}
.checks li + li {
  border-top: 1px solid var(--line);
}
.badge {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font: 500 12px var(--font-mono);
}
.done .badge {
  background: var(--know-soft);
  color: var(--know);
}
.body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.title-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}
.title {
  font-size: 15px;
  font-weight: 600;
}
.status {
  color: var(--ink-2);
  font-size: 13px;
  font-weight: 600;
}
.done .status {
  color: var(--know);
}
.status.problem,
.detail.problem {
  color: var(--delegate);
}
.note,
.detail,
.hint {
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
}
.field-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.path {
  display: flex;
  flex: 1 1 260px;
  align-items: center;
  min-width: 0;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  font: 400 13px var(--font-mono);
  overflow-wrap: anywhere;
}
.path.empty {
  color: var(--ink-3);
}
.button.small {
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
}
.command {
  display: block;
  padding: 8px 12px;
  border-radius: var(--radius-control);
  background: var(--ground);
  font: 400 13px var(--font-mono);
  overflow-wrap: anywhere;
  user-select: all;
}
.places {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
}
legend {
  padding: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
}
.place {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-card);
  cursor: pointer;
}
.place.on {
  border: 1.5px solid var(--ink);
  background: var(--ground);
}
.place.off {
  cursor: default;
  opacity: 0.6;
}
.place input {
  flex-shrink: 0;
  margin: 2px 0 0;
}
.place-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.place-title {
  font-size: 14px;
  font-weight: 600;
}
.place-note {
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
  font-weight: 500;
}
.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.install {
  color: var(--focus);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}
.button.big {
  height: 44px;
  padding: 0 20px;
  font-size: 15px;
}
kbd {
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--paper) 18%, transparent);
  font: 500 11px var(--font-mono);
}
@media (prefers-reduced-motion: reduce) {
  .wa-dialog {
    animation: none;
  }
}
@media (max-width: 600px) {
  .wa-dialog {
    padding: 20px 16px;
  }
}
</style>
