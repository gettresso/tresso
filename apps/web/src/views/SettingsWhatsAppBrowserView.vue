<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { accountSubtitle } from '@tresso/core'
import { useChatsStore } from '@/stores/chats'
import { chatName } from '@/components/chat/chatTexts'
import { deviceLabel, LEFT_OUT_KEPT, linkedAge, otherRelayText } from '@/components/chat/whatsappTexts'
import AppIcon from '@/components/AppIcon.vue'

/**
 * Settings, WhatsApp in the browser (the WhatsApp plan's WP11): what the server's chat account says, read only. The
 * browser has no bridge: connecting, the relay, the bridge, the link, where the chats live and which chats come in are
 * changed on the Mac that relays WhatsApp. Only Notify me, a setting the server keeps, can be changed here. The chats
 * left out are listed with why they cannot be taken back in here. Without a chat account in the copy the router keeps
 * this page closed, and the page goes back to Accounts when the account goes while it is open.
 */
const chats = useChatsStore()
const router = useRouter()

const account = computed(() => chats.serverAccount)
/** For "offline, last heard from 2 hours ago" and "Linked 3 days ago"; moves once a minute. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
const saving = ref(false)
const error = ref<string | null>(null)

const relay = computed(() => deviceLabel(account.value?.relayDeviceName ?? null))
/** The relaying Mac as the plan names it (`the Tresso app on <relay device name>`). */
const connectedLine = computed(() => `WhatsApp is connected through the Tresso app on ${relay.value}.`)

/** The pill next to the title: whether the relaying Mac brings messages in and sends replies now. */
const pill = computed<{ text: string; ok: boolean }>(() => {
  const current = account.value
  if (current === null) return { text: 'Not connected', ok: false }
  if (!current.relayOnline) return { text: 'Mac offline', ok: false }
  if (current.link === 'unlinked') return { text: 'Not linked', ok: false }
  if (current.bridge === 'stopped') return { text: 'Bridge stopped', ok: false }
  return { text: 'Connected', ok: true }
})

const relayRow = computed(() => {
  const current = account.value
  return current === null
    ? { value: '', ok: false }
    : { value: otherRelayText({ name: current.relayDeviceName, online: current.relayOnline, offlineSince: current.relayOfflineSince }, now.value), ok: current.relayOnline }
})
const bridgeRow = computed(() => (account.value?.bridge === 'running' ? { value: 'Running', ok: true } : { value: 'Not running', ok: false }))
const linkRow = computed(() => {
  const current = account.value
  if (current?.link === 'linked') return { value: linkedAge(current.linkedAt, now.value), ok: true }
  if (current?.link === 'unlinked') return { value: 'Not linked. Nothing comes in or goes out.', ok: false }
  return { value: 'Not known.', ok: false }
})
const groupsValue = computed(() => (account.value?.includeGroups === false ? 'Direct chats only' : 'Direct chats and groups'))
const leftOutRows = computed(() => chats.leftOut.map((chat) => ({ id: chat.id, name: chatName(chat) })))

async function setNotify(event: Event): Promise<void> {
  const box = event.target as HTMLInputElement
  const wanted = box.checked
  // The switch shows what the server holds until it answered.
  box.checked = account.value?.notify === true
  if (saving.value) {
    return
  }
  saving.value = true
  error.value = null
  try {
    await chats.setNotify(wanted)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Your Tresso server could not take this change just now. Try again.'
  } finally {
    saving.value = false
  }
}

// The account went (disconnected on the Mac, or "Only this Mac" chosen there): nothing of WhatsApp shows here then.
watch(
  () => chats.serverChecked && !chats.enabled,
  (gone) => {
    if (gone) {
      void router.replace({ name: 'settings-accounts' })
    }
  },
  { immediate: true },
)

onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 60_000)
})
onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock)
})
</script>

<template>
  <section class="whatsapp">
    <p v-if="account === null" class="state" role="status">Loading WhatsApp…</p>

    <template v-else>
      <header class="header">
        <RouterLink :to="{ name: 'settings-accounts' }" class="back" aria-label="Back to accounts"><AppIcon name="back" :size="18" /></RouterLink>
        <span class="mark" aria-hidden="true">WA</span>
        <div class="who">
          <h2>WhatsApp</h2>
          <span class="line" dir="auto">{{ accountSubtitle(account, '') }}</span>
        </div>
        <span class="pill" :class="{ ok: pill.ok }">{{ pill.text }}</span>
      </header>

      <div class="panel">
        <p dir="auto">{{ connectedLine }}</p>
        <p class="option-note">The connection, the bridge, the link to your phone and where your chats live are changed in Tresso on that Mac.</p>
      </div>

      <section class="panel rows" aria-label="Connection">
        <div class="row">
          <span class="label">Relaying Mac</span>
          <span class="value" dir="auto"><span class="dot" :class="{ ok: relayRow.ok }" aria-hidden="true" />{{ relayRow.value }}</span>
        </div>
        <div class="row">
          <span class="label">Bridge</span>
          <span class="value"><span class="dot" :class="{ ok: bridgeRow.ok }" aria-hidden="true" />{{ bridgeRow.value }}</span>
        </div>
        <div class="row">
          <span class="label">Linked to phone</span>
          <span class="value"><span class="dot" :class="{ ok: linkRow.ok }" aria-hidden="true" />{{ linkRow.value }}</span>
        </div>
        <p v-if="!account.relayOnline" class="detail">The bridge and the link are as your Mac last reported them.</p>
      </section>

      <section class="panel options" aria-labelledby="wa-messages">
        <h3 id="wa-messages">Messages</h3>
        <div class="option">
          <span class="option-text">
            <span class="option-label">Chats to bring in</span>
            <span class="option-note">Change this on the Mac that relays WhatsApp.</span>
          </span>
          <span class="option-value">{{ groupsValue }}</span>
        </div>
        <div class="option">
          <span class="option-text">
            <label for="wa-notify" class="option-label">Notify me</label>
            <span id="wa-notify-note" class="option-note">
              Push notifications on your phone for new WhatsApp messages, naming the chat only, and notifications on the Mac that relays WhatsApp. This browser shows none.
            </span>
          </span>
          <input id="wa-notify" type="checkbox" role="switch" class="switch" aria-describedby="wa-notify-note" :checked="account.notify" :disabled="saving" @change="setNotify" />
        </div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </section>

      <section v-if="leftOutRows.length > 0" class="panel left-out" aria-labelledby="wa-left-out">
        <h3 id="wa-left-out">Chats left out</h3>
        <p class="option-note">
          Tresso does not read these chats; WhatsApp keeps them. {{ LEFT_OUT_KEPT }} Take chats back in on the Mac that relays WhatsApp: only it can read its bridge again.
        </p>
        <ul class="left-list">
          <li v-for="row in leftOutRows" :key="row.id" class="left-row" dir="auto">{{ row.name }}</li>
        </ul>
      </section>
    </template>
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
.detail {
  padding: 0 0 12px;
  color: var(--ink-2);
  font-size: 13px;
  line-height: 19px;
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
.option-value {
  flex-shrink: 0;
  color: var(--ink);
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
  overflow: hidden;
  padding: 8px 0;
  white-space: nowrap;
  text-overflow: ellipsis;
  unicode-bidi: isolate;
}
.left-row + .left-row {
  border-top: 1px solid var(--line);
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
