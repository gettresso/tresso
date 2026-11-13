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
  COPY_BODY,
  COPY_TITLE,
  MODE_NOTE,
  REMOVE_BODY,
  REMOVE_TITLE,
  bridgeText,
  carriedText,
  deviceLabel,
  otherRelayText,
  serverRefusedText,
  switchText,
  importText,
  linkedAge,
  linkText,
  phoneNumber,
  relativeTime,
  shortFolder,
} from '@/components/chat/whatsappTexts'

/**
 * Settings, WhatsApp (the SettingsWhatsApp board, with the plan's corrections): the connection's health, where the
 * chats live ("Only this Mac" or "All my devices", each switch confirmed first), what comes in, Notify me, and
 * Disconnect. In "All my devices" the Relaying Mac row names the Mac that relays, and another Mac offers "Use this Mac
 * instead". /settings/whatsapp/connect shows the connect dialog over it (`?mode=all` to take the relay over from a Mac
 * not connected yet), as /settings/accounts/new does for mail. The desktop app on macOS only; the router keeps everyone
 * else out.
 */
const wa = useWhatsAppRelayStore()
const chats = useChatsStore()
const route = useRoute()
const router = useRouter()

const connecting = computed(() => route.name === 'settings-whatsapp-connect')
const showLink = ref(false)
const confirmingDisconnect = ref(false)
const confirmingGroups = ref(false)
/** The place the user picked in "Where messages live", until they confirmed or cancelled the switch. */
const confirmingMode = ref<'local' | 'all' | null>(null)
const modeSelect = ref<HTMLSelectElement | null>(null)
const modeCancel = ref<HTMLButtonElement | null>(null)
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
focusAround(
  () => confirmingMode.value !== null,
  () => modeCancel.value,
  () => modeSelect.value,
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

/** "All my devices" on this Mac. */
const allDevices = computed(() => wa.config?.mode === 'all')
/** This Mac reads its bridge's store in: "Only this Mac", or it relays the server's account. */
const readsHere = computed(() => !allDevices.value || wa.relaysHere)
/** The Relaying Mac row: this Mac, or the one that relays (with "Use this Mac instead"), or none yet. */
const relayRow = computed<{ value: string; ok: boolean; takeOver: 'relay' | 'switch' | null; detail: string | null }>(() => {
  const here = `${device.value}, this Mac`
  if (!allDevices.value) {
    // A server account relayed by another Mac: this Mac keeps its own chats; it can relay for every device instead.
    return wa.otherRelay === null
      ? { value: here, ok: true, takeOver: null, detail: null }
      : { value: here, ok: true, takeOver: 'switch', detail: `Your other devices show WhatsApp through ${otherRelayText(wa.otherRelay, now.value)}.` }
  }
  if (wa.relaysHere) {
    return { value: here, ok: true, takeOver: null, detail: null }
  }
  if (wa.otherRelay !== null) {
    return { value: otherRelayText(wa.otherRelay, now.value), ok: wa.otherRelay.online, takeOver: 'relay', detail: null }
  }
  return { value: `${device.value}, this Mac, waiting for your Tresso server`, ok: false, takeOver: null, detail: null }
})
const switching = computed(() => (wa.modeSwitch === null ? null : switchText(wa.modeSwitch.to, wa.modeSwitch.to === 'local' && wa.modeSwitch.removed)))
const refusedLine = computed(() => (allDevices.value ? serverRefusedText(wa.serverRefused) : null))
const carriedLine = computed(() => carriedText(wa.carried.length, wa.carryLost))
const modeValue = computed(() => wa.config?.mode ?? 'local')

function onMode(event: Event): void {
  const select = event.target as HTMLSelectElement
  const value = select.value === 'all' ? 'all' : 'local'
  // The switch is asked first; the select shows the saved place until then.
  select.value = modeValue.value
  if (value !== modeValue.value) {
    confirmingMode.value = value
  }
}

async function switchMode(): Promise<void> {
  const to = confirmingMode.value
  if (to !== null && (await wa.switchMode(to))) {
    confirmingMode.value = null
  }
}

/** "Use this Mac instead": in "All my devices" this Mac takes the relay over; in "Only this Mac" it switches (asked first). */
function takeOver(kind: 'relay' | 'switch'): void {
  if (kind === 'relay') {
    void wa.useThisMac()
  } else {
    confirmingMode.value = 'all'
  }
}

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

/**
 * The chats the user left out, by JID: as the copy names them, else by number (a chat whose row went). In "All my
 * devices" the server's rows say which (also those left out on another device).
 */
const leftOutRows = computed(() =>
  allDevices.value
    ? chats.leftOut.map((chat) => ({ jid: chat.jid, name: chatName(chat) }))
    : (wa.config?.leftOut ?? []).map((jid) => {
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
      <p v-if="wa.notice" class="notice" role="status">{{ wa.notice }}</p>
      <div v-if="wa.otherRelay !== null" class="panel">
        <p>
          Your WhatsApp chats are on your Tresso server, relayed by {{ deviceLabel(wa.otherRelay.name) }}. Connect whatsapp-mcp on this Mac to relay them from here instead; the other Mac then
          stops.
        </p>
        <div>
          <RouterLink :to="{ name: 'settings-whatsapp-connect', query: { mode: 'all' } }" class="button button-primary">Use this Mac instead</RouterLink>
        </div>
      </div>
      <div v-else class="panel">
        <p>Read and answer your WhatsApp chats next to your mail, through whatsapp-mcp on this Mac. Your phone stays the WhatsApp account, and the chats stay on this Mac unless you choose to copy them to your Tresso server.</p>
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

      <p class="visually-hidden" role="status">{{ readsHere ? importAnnouncement : '' }}</p>
      <p v-if="switching" class="import" role="status">{{ switching }}</p>
      <div v-if="readsHere && (wa.importState === 'reading' || wa.importState === 'stuck')" class="import" :class="{ stuck: wa.importState === 'stuck' }">
        <strong>{{ wa.importState === 'stuck' ? 'Bringing in your chats is stuck.' : `Bringing in your chats since ${importSince}.` }}</strong>
        <span v-if="importView.detail">{{ importView.detail }}</span>
      </div>
      <p v-else-if="readsHere && wa.relayFailing !== null" class="import-failing">Reading WhatsApp messages failed just now. Tresso tries again in a moment.</p>
      <p v-if="refusedLine" class="import-failing">{{ refusedLine }}</p>
      <p v-if="carriedLine" class="waiting">{{ carriedLine }}</p>

      <section class="panel rows" aria-label="Connection">
        <div class="row">
          <span class="label">Relaying Mac</span>
          <span class="value" dir="auto"><span class="dot" :class="{ ok: relayRow.ok }" aria-hidden="true" />{{ relayRow.value }}</span>
          <button v-if="relayRow.takeOver" type="button" class="button button-quiet outline" :disabled="wa.busy !== null || wa.modeSwitch !== null" @click="takeOver(relayRow.takeOver)">
            {{ wa.busy === 'take-over' ? 'Taking over…' : 'Use this Mac instead' }}
          </button>
          <span v-if="relayRow.detail" class="detail" dir="auto">{{ relayRow.detail }}</span>
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
            <span id="wa-place-note" class="option-note">{{ MODE_NOTE }}</span>
          </span>
          <select id="wa-place" ref="modeSelect" aria-describedby="wa-place-note" :value="modeValue" :disabled="wa.busy !== null || wa.modeSwitch !== null" @change="onMode">
            <option value="local">Only this Mac</option>
            <option value="all">All my devices</option>
          </select>
        </div>
        <div v-if="confirmingMode" class="confirm" role="alertdialog" aria-labelledby="wa-mode-title" aria-describedby="wa-mode-body">
          <p id="wa-mode-title"><strong>{{ confirmingMode === 'all' ? COPY_TITLE : REMOVE_TITLE }}</strong></p>
          <p id="wa-mode-body">{{ confirmingMode === 'all' ? COPY_BODY : REMOVE_BODY }}</p>
          <div class="actions">
            <button type="button" :class="confirmingMode === 'all' ? 'button button-primary' : 'button button-danger'" :disabled="wa.busy !== null" @click="switchMode">
              {{ wa.busy === 'mode' ? (confirmingMode === 'all' ? 'Copying…' : 'Removing…') : confirmingMode === 'all' ? 'Copy' : 'Remove' }}
            </button>
            <button ref="modeCancel" type="button" class="button button-quiet" :disabled="wa.busy === 'mode'" @click="confirmingMode = null">Cancel</button>
          </div>
        </div>
        <div class="option">
          <span class="option-text">
            <label for="wa-groups" class="option-label">Chats to bring in</label>
            <span id="wa-groups-note" class="option-note">
              Group chats can be busy. Leave chats out one by one from the chat itself.<template v-if="!readsHere"> Change this on the Mac that relays WhatsApp.</template>
            </span>
          </span>
          <select id="wa-groups" ref="groupsSelect" aria-describedby="wa-groups-note" :value="groupsValue" :disabled="wa.busy !== null || !readsHere" @change="onGroups">
            <option value="all">Direct chats and groups</option>
            <option value="direct">Direct chats only</option>
          </select>
        </div>
        <div v-if="confirmingGroups" class="confirm" role="alertdialog" aria-labelledby="wa-groups-title" aria-describedby="wa-groups-body">
          <p id="wa-groups-title"><strong>Remove the group chats Tresso copied?</strong></p>
          <p id="wa-groups-body">
            {{
              allDevices
                ? 'They go from your Tresso server and from every device. WhatsApp and the bridge keep them, and turning groups on again brings them back.'
                : 'They go from Tresso on this Mac. WhatsApp and the bridge keep them, and turning groups on again brings them back.'
            }}
          </p>
          <div class="actions">
            <button type="button" class="button button-danger" :disabled="wa.busy !== null" @click="removeGroups">Remove</button>
            <button ref="groupsCancel" type="button" class="button button-quiet" @click="confirmingGroups = false">Cancel</button>
          </div>
        </div>
        <div class="option">
          <span class="option-text">
            <label for="wa-notify" class="option-label">Notify me</label>
            <span id="wa-notify-note" class="option-note">
              Desktop notifications for new WhatsApp messages on this Mac.<template v-if="allDevices"> Your Tresso server keeps this setting for your other devices too.</template>
            </span>
          </span>
          <input id="wa-notify" type="checkbox" role="switch" class="switch" aria-describedby="wa-notify-note" :checked="wa.config?.notify === true" :disabled="wa.busy !== null" @change="setNotify" />
        </div>
      </section>

      <section v-if="leftOutRows.length > 0" class="panel left-out" aria-labelledby="wa-left-out">
        <h3 id="wa-left-out">Chats left out</h3>
        <p class="option-note">
          Tresso does not read these chats; WhatsApp keeps them. Taking one back in reads the bridge's store again: its messages come back as read, also those that came while it was left out, and
          new ones arrive as usual.<template v-if="!readsHere"> Take chats back in on the Mac that relays WhatsApp.</template>
        </p>
        <ul class="left-list">
          <li v-for="row in leftOutRows" :key="row.jid" class="left-row">
            <span class="left-name" dir="auto">{{ row.name }}</span>
            <button type="button" class="button button-quiet outline" :disabled="wa.busy !== null || !readsHere" @click="chats.takeBackIn(row.jid)">Take back in</button>
          </li>
        </ul>
      </section>

      <section class="panel disconnect" aria-label="Disconnect">
        <p>
          {{
            allDevices
              ? 'Disconnecting removes your WhatsApp chats from your Tresso server and from every device. WhatsApp itself, the bridge and its own message store on this Mac stay as they are.'
              : 'Disconnecting removes the WhatsApp chats Tresso copied. WhatsApp itself, the bridge and its own message store on this Mac stay as they are.'
          }}
        </p>
        <button ref="disconnectButton" type="button" class="button button-danger" :disabled="wa.busy !== null" @click="confirmingDisconnect = true">Disconnect WhatsApp</button>
        <div v-if="confirmingDisconnect" class="confirm" role="alertdialog" aria-labelledby="wa-disconnect-title" aria-describedby="wa-disconnect-body">
          <p id="wa-disconnect-title"><strong>Disconnect WhatsApp?</strong></p>
          <p v-if="allDevices" id="wa-disconnect-body">
            Tresso deletes your WhatsApp chats from your Tresso server, so web, mobile and your other Macs stop showing them, with the replies still waiting there, and stops the bridge on this Mac. It
            deletes nothing in your whatsapp-mcp folder: the bridge and its own message store stay there. Your phone keeps this Mac under Linked devices until you remove it there.
          </p>
          <p v-else id="wa-disconnect-body">
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

    <ConnectWhatsApp v-if="connecting && wa.configLoaded" :mode="route.query.mode === 'all' ? 'all' : 'local'" @close="closeConnect" @done="connectDone" />
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
.notice {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--radius-card);
  background: var(--delegate-soft);
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
