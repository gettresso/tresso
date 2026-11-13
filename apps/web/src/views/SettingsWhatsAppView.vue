<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import { useChatsStore } from '@/stores/chats'
import { chatName } from '@/components/chat/chatTexts'
import { shortDue } from '@/mail/format'
import AppIcon from '@/components/AppIcon.vue'
import ConnectWhatsApp from '@/components/connect/ConnectWhatsApp.vue'
import WhatsAppLink from '@/components/chat/WhatsAppLink.vue'
import {
  BUILD_COMMAND,
  CLOSE_PORT_URL,
  bridgeText,
  importText,
  linkedAge,
  linkText,
  phoneNumber,
  relativeTime,
  shortFolder,
} from '@/components/chat/whatsappTexts'

/**
 * Settings, WhatsApp (the SettingsWhatsApp board, with the plan's corrections): the connection's health, what comes in,
 * Notify me, and Disconnect. /settings/whatsapp/connect shows the connect dialog over it, as /settings/accounts/new
 * does for mail. The desktop app on macOS only; the router keeps everyone else out.
 */
const wa = useWhatsAppRelayStore()
const chats = useChatsStore()
const route = useRoute()
const router = useRouter()

const connecting = computed(() => route.name === 'settings-whatsapp-connect')
const showLink = ref(false)
const confirmingDisconnect = ref(false)
const confirmingGroups = ref(false)
const disconnectButton = ref<HTMLButtonElement | null>(null)
const disconnectCancel = ref<HTMLButtonElement | null>(null)
const groupsSelect = ref<HTMLSelectElement | null>(null)
const groupsCancel = ref<HTMLButtonElement | null>(null)

// A confirmation takes focus on its safe answer when it opens, and gives it back to what asked for it when it closes.
function focusAround(open: () => boolean, inside: () => HTMLElement | null, outside: () => HTMLElement | null): void {
  watch(open, async (isOpen) => {
    await nextTick()
    ;(isOpen ? inside() : outside())?.focus()
  })
}
focusAround(
  () => confirmingDisconnect.value,
  () => disconnectCancel.value,
  () => disconnectButton.value,
)
focusAround(
  () => confirmingGroups.value,
  () => groupsCancel.value,
  () => groupsSelect.value,
)
/** For "last message 2 minutes ago" and "Linked 3 days ago"; moves once a minute. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const device = computed(() => wa.config?.deviceName ?? wa.deviceName ?? 'this Mac')
const number = computed(() => (wa.identity?.number ? phoneNumber(wa.identity.number) : null))
const subtitle = computed(() => (number.value === null ? `Through whatsapp-mcp on ${device.value}` : `${number.value}, through whatsapp-mcp on ${device.value}`))

/** The pill next to the title. */
const pill = computed<{ text: string; ok: boolean }>(() => {
  if (wa.busy === 'disconnect') return { text: 'Disconnecting', ok: false }
  const bridge = wa.bridge
  if (bridge.process === 'owned') {
    if (bridge.link === 'linked') return { text: 'Connected', ok: true }
    if (bridge.link === 'unknown') return { text: 'Starting', ok: false }
    return { text: 'Not linked', ok: false }
  }
  return bridge.link === 'unlinked' && bridge.error === null ? { text: 'Not linked', ok: false } : { text: 'Bridge stopped', ok: false }
})

const bridgeView = computed(() => bridgeText(wa.bridge, true))
const bridgeRow = computed<{ value: string; ok: boolean; detail: string | null; action: 'start' | 'close-port' | null }>(() => {
  const view = bridgeView.value
  if (wa.bridge.process === 'owned' && wa.bridge.port !== null) {
    if (wa.bridge.loopbackOnly === false) {
      return { value: view.status, ok: false, detail: view.detail, action: 'close-port' }
    }
    const last = wa.lastMessageAt === null ? 'no messages yet' : `last message ${relativeTime(wa.lastMessageAt, now.value)}`
    return { value: `Running, ${last}`, ok: true, detail: null, action: null }
  }
  if (wa.bridge.process === 'owned') {
    return { value: 'Starting', ok: false, detail: null, action: null }
  }
  return { value: view.status, ok: false, detail: view.detail, action: 'start' }
})

const linkView = computed(() => linkText(wa.bridge, wa.identity))
const linkRow = computed<{ value: string; ok: boolean }>(() => {
  if (wa.linked) {
    return { value: linkedAge(wa.config?.linkedAt ?? null, now.value), ok: true }
  }
  if (wa.bridge.process === 'stopped' && !linkView.value.expired) {
    return { value: 'Not known while the bridge is stopped.', ok: false }
  }
  return { value: 'Not linked. Nothing comes in or goes out.', ok: false }
})
/** The QR panel: asked for, or needed (the bridge waits for a scan, or the code expired). */
const linkPanel = computed(() => showLink.value || (!wa.linked && (wa.bridge.link === 'waiting_for_scan' || wa.bridge.link === 'unlinked')))

const importView = computed(() =>
  importText(wa.importState, { messages: wa.progress?.stored ?? 0, chats: wa.progress?.chats ?? 0, stored: wa.chatCount, refused: wa.stuckRefused }),
)
/** Said in the live region: the import's stage, not its counts (they change every few seconds). */
const importAnnouncement = computed(() =>
  wa.importState === 'reading' ? 'Bringing in your recent chats.' : wa.importState === 'stuck' ? 'Bringing in your chats is stuck.' : wa.importState === 'done' ? 'Your recent chats are in.' : '',
)

/** The import date the config keeps, in the app's date format. */
const importSince = computed(() => (wa.config === null ? '' : shortDue(wa.config.importSince)))
/** The whatsapp-mcp row: the folder, and whether Tresso's bridge runs from it now. */
const folderRow = computed<{ value: string; ok: boolean }>(() => {
  const folder = wa.config === null ? '' : shortFolder(wa.config.folder)
  return wa.bridge.process === 'owned' && wa.bridge.error === null ? { value: `${folder}, bridge started by Tresso`, ok: true } : { value: `${folder}, bridge not running`, ok: false }
})
const disconnecting = computed(() => wa.busy === 'disconnect')

const groupsValue = computed(() => (wa.config?.includeGroups === false ? 'direct' : 'all'))

function onGroups(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'direct') {
    // Removing copied group chats is asked first; the select shows the saved value until then.
    ;(event.target as HTMLSelectElement).value = groupsValue.value
    confirmingGroups.value = true
  } else {
    void wa.setIncludeGroups(true)
  }
}

async function removeGroups(): Promise<void> {
  if (await wa.setIncludeGroups(false)) {
    confirmingGroups.value = false
  }
}

async function disconnect(): Promise<void> {
  if (await wa.disconnect()) {
    confirmingDisconnect.value = false
  }
}

async function closeConnect(): Promise<void> {
  await wa.cancel()
  await router.push({ name: 'settings-whatsapp' })
}

/** Done after connecting: the chats are what the user came for. */
async function connectDone(): Promise<void> {
  await wa.cancel()
  await router.push({ name: wa.connected ? 'whatsapp' : 'settings-whatsapp' })
}

/** The chats the user left out, by JID: as the copy names them, else by number (a chat whose row went). */
const leftOutRows = computed(() =>
  (wa.config?.leftOut ?? []).map((jid) => {
    const stored = chats.leftOut.find((chat) => chat.jid === jid)
    return { jid, name: chatName(stored ?? { name: null, jid, kind: jid.endsWith('@g.us') ? 'group' : 'direct' }) }
  }),
)

function setNotify(event: Event): void {
  void wa.setNotify((event.target as HTMLInputElement).checked)
}

onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 60_000)
})
onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock)
})
</script>

<template>
  <section class="whatsapp">
    <p v-if="!wa.configLoaded" class="state" role="status">Loading WhatsApp…</p>

    <template v-else-if="!wa.connected">
      <header class="header">
        <RouterLink :to="{ name: 'settings-accounts' }" class="back" aria-label="Back to accounts"><AppIcon name="back" :size="18" /></RouterLink>
        <span class="mark" aria-hidden="true">WA</span>
        <div class="who">
          <h2>WhatsApp</h2>
          <span class="line">Not connected</span>
        </div>
      </header>
      <div class="panel">
        <p>Read and answer your WhatsApp chats next to your mail, through whatsapp-mcp on this Mac. Your phone stays the WhatsApp account, and the chats stay on this Mac.</p>
        <div>
          <RouterLink :to="{ name: 'settings-whatsapp-connect' }" class="button button-primary">Connect WhatsApp</RouterLink>
        </div>
      </div>
    </template>

    <template v-else>
      <header class="header">
        <RouterLink :to="{ name: 'settings-accounts' }" class="back" aria-label="Back to accounts"><AppIcon name="back" :size="18" /></RouterLink>
        <span class="mark" aria-hidden="true">WA</span>
        <div class="who">
          <h2>WhatsApp</h2>
          <span class="line">{{ subtitle }}</span>
        </div>
        <span class="pill" :class="{ ok: pill.ok }">{{ pill.text }}</span>
      </header>

      <p class="visually-hidden" role="status">{{ importAnnouncement }}</p>
      <div v-if="wa.importState === 'reading' || wa.importState === 'stuck'" class="import" :class="{ stuck: wa.importState === 'stuck' }">
        <strong>{{ wa.importState === 'stuck' ? 'Bringing in your chats is stuck.' : `Bringing in your chats since ${importSince}.` }}</strong>
        <span v-if="importView.detail">{{ importView.detail }}</span>
      </div>
      <p v-else-if="wa.relayFailing !== null" class="import-failing">Reading WhatsApp messages failed just now. Tresso tries again in a moment.</p>

      <section class="panel rows" aria-label="Connection">
        <div class="row">
          <span class="label">Relaying Mac</span>
          <span class="value"><span class="dot ok" aria-hidden="true" />{{ device }}, this Mac</span>
        </div>
        <div class="row">
          <span class="label">whatsapp-mcp</span>
          <span class="value"><span class="dot" :class="{ ok: folderRow.ok }" aria-hidden="true" />{{ folderRow.value }}</span>
          <button type="button" class="button button-quiet outline" :disabled="wa.busy !== null" @click="wa.changeFolder()">Change folder</button>
        </div>
        <div class="row">
          <span class="label">Bridge</span>
          <span class="value"><span class="dot" :class="{ ok: bridgeRow.ok }" aria-hidden="true" />{{ bridgeRow.value }}</span>
          <button v-if="bridgeRow.action === 'start'" type="button" class="button button-quiet outline" :disabled="wa.busy !== null" @click="wa.start()">Start again</button>
          <a v-else-if="bridgeRow.action === 'close-port'" :href="CLOSE_PORT_URL" target="_blank" rel="noopener noreferrer" class="button button-quiet outline">Show how to close it</a>
          <span v-if="bridgeRow.detail" class="detail">{{ bridgeRow.detail }}</span>
          <code v-if="bridgeView.problem === 'not_built' || bridgeView.problem === 'unprotected'" class="command">{{ BUILD_COMMAND }}</code>
        </div>
        <div class="row">
          <span class="label">Linked to phone</span>
          <span class="value"><span class="dot" :class="{ ok: linkRow.ok }" aria-hidden="true" />{{ linkRow.value }}</span>
          <button type="button" class="button button-quiet outline" :aria-expanded="linkPanel" aria-controls="wa-link" @click="showLink = !showLink">Show how to link</button>
          <div v-if="linkPanel" id="wa-link" class="detail link">
            <WhatsAppLink v-if="!wa.linked" />
            <p v-else>Linked. To link another phone, remove this Mac under WhatsApp &gt; Linked devices on the phone that is linked now; a new code then shows here.</p>
          </div>
        </div>
      </section>

      <section class="panel options" aria-labelledby="wa-messages">
        <h3 id="wa-messages">Messages</h3>
        <div class="option">
          <span class="option-text">
            <label for="wa-place" class="option-label">Where messages live</label>
            <span id="wa-place-note" class="option-note">Only this Mac: chats never leave this computer. All my devices, where this Mac copies chats to your Tresso server so web and mobile show them, comes in a later version.</span>
          </span>
          <select id="wa-place" aria-describedby="wa-place-note" value="local" disabled>
            <option value="local">Only this Mac</option>
            <option value="all" disabled>All my devices</option>
          </select>
        </div>
        <div class="option">
          <span class="option-text">
            <label for="wa-groups" class="option-label">Chats to bring in</label>
            <span id="wa-groups-note" class="option-note">Group chats can be busy. Leave chats out one by one from the chat itself.</span>
          </span>
          <select id="wa-groups" ref="groupsSelect" aria-describedby="wa-groups-note" :value="groupsValue" :disabled="wa.busy !== null" @change="onGroups">
            <option value="all">Direct chats and groups</option>
            <option value="direct">Direct chats only</option>
          </select>
        </div>
        <div v-if="confirmingGroups" class="confirm" role="alertdialog" aria-labelledby="wa-groups-title" aria-describedby="wa-groups-body">
          <p id="wa-groups-title"><strong>Remove the group chats Tresso copied?</strong></p>
          <p id="wa-groups-body">They go from Tresso on this Mac. WhatsApp and the bridge keep them, and turning groups on again brings them back.</p>
          <div class="actions">
            <button type="button" class="button button-danger" :disabled="wa.busy !== null" @click="removeGroups">Remove</button>
            <button ref="groupsCancel" type="button" class="button button-quiet" @click="confirmingGroups = false">Cancel</button>
          </div>
        </div>
        <div class="option">
          <span class="option-text">
            <label for="wa-notify" class="option-label">Notify me</label>
            <span id="wa-notify-note" class="option-note">Desktop notifications for new WhatsApp messages on this Mac.</span>
          </span>
          <input id="wa-notify" type="checkbox" role="switch" class="switch" aria-describedby="wa-notify-note" :checked="wa.config?.notify === true" :disabled="wa.busy !== null" @change="setNotify" />
        </div>
      </section>

      <section v-if="leftOutRows.length > 0" class="panel left-out" aria-labelledby="wa-left-out">
        <h3 id="wa-left-out">Chats left out</h3>
        <p class="option-note">Tresso does not read these chats. WhatsApp keeps them; taking one back in brings its messages back.</p>
        <ul class="left-list">
          <li v-for="row in leftOutRows" :key="row.jid" class="left-row">
            <span class="left-name" dir="auto">{{ row.name }}</span>
            <button type="button" class="button button-quiet outline" :disabled="wa.busy !== null" @click="chats.takeBackIn(row.jid)">Take back in</button>
          </li>
        </ul>
      </section>

      <section class="panel disconnect" aria-label="Disconnect">
        <p>Disconnecting removes the WhatsApp chats Tresso copied. WhatsApp itself, the bridge and its own message store on this Mac stay as they are.</p>
        <button ref="disconnectButton" type="button" class="button button-danger" :disabled="wa.busy !== null" @click="confirmingDisconnect = true">Disconnect WhatsApp</button>
        <div v-if="confirmingDisconnect" class="confirm" role="alertdialog" aria-labelledby="wa-disconnect-title" aria-describedby="wa-disconnect-body">
          <p id="wa-disconnect-title"><strong>Disconnect WhatsApp?</strong></p>
          <p id="wa-disconnect-body">
            Tresso stops the bridge and removes the WhatsApp chats it copied to this Mac. It deletes nothing in your whatsapp-mcp folder: the bridge and its own message store stay there. Your
            phone keeps this Mac under Linked devices until you remove it there.
          </p>
          <div class="actions">
            <button type="button" class="button button-danger" :disabled="wa.busy !== null" @click="disconnect">{{ disconnecting ? 'Disconnecting…' : 'Disconnect' }}</button>
            <button ref="disconnectCancel" type="button" class="button button-quiet" :disabled="disconnecting" @click="confirmingDisconnect = false">Cancel</button>
          </div>
          <p class="waiting" role="status">{{ disconnecting ? 'Disconnecting… A reply being sent goes out first; this can take up to two minutes.' : '' }}</p>
        </div>
      </section>
    </template>

    <p v-if="wa.error && !connecting" class="form-error" role="alert">{{ wa.error }}</p>

    <ConnectWhatsApp v-if="connecting && wa.configLoaded" @close="closeConnect" @done="connectDone" />
  </section>
</template>

<style scoped>
.whatsapp {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 760px;
}
.state {
  margin: 0;
  color: var(--ink-2);
}
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-control);
  color: var(--ink-2);
}
.mark {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  background: var(--know);
  color: var(--paper);
  font-size: 13px;
  font-weight: 700;
}
.who {
  display: flex;
  flex: 1 1 260px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
}
.line {
  color: var(--ink-2);
  font-size: 14px;
  overflow-wrap: anywhere;
}
.pill {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--delegate-soft);
  color: var(--delegate);
  font-size: 12px;
  font-weight: 600;
}
.pill.ok {
  background: var(--know-soft);
  color: var(--know);
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
}
.panel p {
  margin: 0;
}
.import {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: var(--radius-card);
  background: var(--know-soft);
}
.import.stuck {
  background: var(--delegate-soft);
}
.waiting {
  margin: 0;
  color: var(--ink-2);
}
.import-failing {
  margin: 0;
  color: var(--delegate);
}
.rows {
  gap: 0;
  padding: 4px 18px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 12px 0;
}
.row + .row {
  border-top: 1px solid var(--line);
}
.label {
  flex: 0 0 180px;
  font-weight: 600;
}
.value {
  display: flex;
  flex: 1 1 240px;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--delegate);
}
.dot.ok {
  background: var(--know);
}
.button.outline {
  border: 1px solid var(--line-strong);
  color: var(--ink);
}
.detail {
  flex: 1 1 100%;
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
}
.detail.link p {
  margin: 0;
}
.command {
  flex: 1 1 100%;
  padding: 8px 12px;
  border-radius: var(--radius-control);
  background: var(--ground);
  font: 400 13px var(--font-mono);
  overflow-wrap: anywhere;
  user-select: all;
}
h3 {
  margin: 0;
  font-size: 16px;
}
.option {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.option-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.option-label {
  font-weight: 600;
}
.option-note {
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
}
select {
  flex-shrink: 0;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--paper);
  color: var(--ink);
  font: 400 14px var(--font-ui);
}
.switch {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  margin-top: 2px;
  accent-color: var(--know);
}
.left-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.left-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.left-row + .left-row {
  border-top: 1px solid var(--line);
}
.left-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  unicode-bidi: isolate;
}
.disconnect {
  flex-flow: row wrap;
  align-items: center;
}
.disconnect > p {
  flex: 1 1 320px;
  color: var(--ink-2);
}
.confirm {
  flex: 1 1 100%;
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-card);
}
.confirm p {
  margin: 0 0 8px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
@media (max-width: 600px) {
  .label {
    flex-basis: 100%;
  }
  .option {
    flex-direction: column;
  }
}
</style>
