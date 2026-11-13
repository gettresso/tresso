<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import { RouterLink, useRouter, type RouteLocationRaw } from 'vue-router'
import {
  chatMessageKey,
  chatSubtitle,
  compareChatMessageKeys,
  labelText,
  nameText,
  replyLabel,
  timeline,
  TODO_TITLE_MAX_LENGTH,
  type ChatMessageKey,
  type ChatPage,
  type SyncedChat,
  type SyncedChatMessage,
  type SyncedChatOutgoing,
  type TimelineEntry,
} from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { dayLabel } from '@/mail/format'
import { modalOpen, shortcutAllowed } from '@/mail/useMessageActions'
import { useChatsStore } from '@/stores/chats'
import { useComposeStore } from '@/stores/compose'
import { useSelectionStore } from '@/stores/selection'
import { useTodosStore } from '@/stores/todos'
import { useWhatsAppRelayStore } from '@/stores/whatsappRelay'
import AppIcon from '@/components/AppIcon.vue'
import KeyShortcut from '@/components/KeyShortcut.vue'
import LogoLoader from '@/components/LogoLoader.vue'
import MenuButton from '@/components/MenuButton.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'
import ChatBubble, { type BubbleView } from '@/components/chat/ChatBubble.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import ChatNotice from '@/components/chat/ChatNotice.vue'
import { attachText, chatName, chatNoticeKind, clockTime, composerNote as sendNoteText, desktopReplyLabel, LEAVE_OUT_BODY, LEAVE_OUT_TITLE, localBubbleMeta, mediaKindLabel, replyAnnouncement, senderLabel, senderTone } from '@/components/chat/chatTexts'
import { errorName } from '@/components/chat/whatsappTexts'
import { composing } from '@/components/chat/composition'

/**
 * A WhatsApp chat (the WhatsAppInbox and WhatsAppStates boards): the header with Do, Noted, Archive and Leave this
 * chat out, a notice when the bridge cannot bring messages in, the timeline, and the reply box. The timeline is read
 * in windows: the newest PAGE messages first, older ones as the user scrolls up (the scroll position stays where it
 * was), so a chat of thousands of messages never loads at once. Opening a chat reads it in Tresso (never in WhatsApp).
 */
const props = defineProps<{ chatId: string; backTo: RouteLocationRaw }>()

/** Messages read at a time. */
const PAGE = 50
/** The most of a new message's text the live region says. */
const INCOMING_MAX = 120
/** Within this many pixels of the top, older messages are read; of the bottom, the timeline follows new ones. */
const EDGE = 160

const chats = useChatsStore()
const wa = useWhatsAppRelayStore()
const todos = useTodosStore()
const compose = useComposeStore()
const router = useRouter()
const selection = useSelectionStore()

const chat = shallowRef<SyncedChat | null>(null)
const messages = shallowRef<SyncedChatMessage[]>([])
const outgoing = shallowRef<SyncedChatOutgoing[]>([])
const hasOlder = ref(false)
const loaded = ref(false)
const loadingOlder = ref(false)
const busy = ref(false)
const sendError = ref<string | null>(null)
const announcement = ref('')
/** The live region for incoming messages (announceIncoming). */
const incoming = ref('')
const confirmingLeave = ref(false)
const todoTitle = ref<string | null>(null)
const todoStatus = ref('')
const addingTodo = ref(false)
const scroller = ref<HTMLElement | null>(null)
const heading = ref<HTMLElement | null>(null)
const leaveCancel = ref<HTMLButtonElement | null>(null)
const todoField = ref<HTMLInputElement | null>(null)
const menu = ref<InstanceType<typeof MenuButton> | null>(null)
let unmounted = false
let loads = 0
let poll: ReturnType<typeof setInterval> | null = null
/** Each reply's state as last seen, so a change is said once. */
let replyStates = new Map<string, string>()

const name = computed(() => (chat.value === null ? '' : chatName(chat.value)))
const subtitle = computed(() => (chat.value === null ? '' : chatSubtitle(chat.value)))
const isGroup = computed(() => chat.value?.kind === 'group')
/** The bridge's notice, on the Mac that sends only: on another Mac in "All my devices" replies wait in the server's queue. */
const notice = computed(() => (chats.enabled && chats.relaysHere ? chatNoticeKind(wa.bridge) : null))
/**
 * A waiting reply is as good as being sent: this Mac's relay runs, or (another Mac in "All my devices") the relaying Mac
 * is online as the server last heard.
 */
const relayOnline = computed(() => (chats.relaysHere ? wa.relayRunning : chats.account?.relayOnline === true))
const composerNote = computed(() => (notice.value !== null || !chats.relaysHere ? null : wa.linked ? null : 'Replies can be written once the bridge is linked.'))
const sendNote = computed(() => sendNoteText(chats.relaysHere, chats.account?.relayDeviceName ?? null))
/** The line about a file attached in this chat; one attached in another chat says nothing here. */
const attachLine = computed(() => {
  const state = chats.attaching
  return state.state !== 'idle' && state.chatId === props.chatId ? attachText(state) : null
})
/** What was typed here before and not sent; the composer starts with it. */
const draft = chats.draftOf(props.chatId)

function onDraft(text: string): void {
  chats.setDraft(props.chatId, text)
  // Typing something else: the line about the last file is old news.
  chats.clearAttach(props.chatId)
}

/**
 * Replies shown with the window: all of them once the oldest message is here. Else a sent reply only after the
 * window's first message (with a minute to spare, so one whose stored copy is just above the window is not shown twice
 * meanwhile); a reply that waits, is being sent or was not sent always shows, whatever its time.
 */
const shownOutgoing = computed(() => {
  const first = messages.value[0]
  if (!hasOlder.value || first === undefined) {
    return outgoing.value
  }
  const from = chatMessageKey(first).sentAt + 60_000
  return outgoing.value.filter((row) => {
    if (row.status !== 'sent') {
      return true
    }
    const at = Date.parse(row.sentAt ?? row.createdAt)
    return Number.isNaN(at) || at >= from
  })
})

const entries = computed(() => timeline(messages.value.map(chats.named), shownOutgoing.value))

/** The bubbles with a day pill before the first of each day. */
const rows = computed(() => {
  const list: ({ kind: 'day'; key: string; label: string } | { kind: 'bubble'; bubble: BubbleView })[] = []
  let day: string | null = null
  let previous: { mine: boolean; sender: string | null; day: string | null } | null = null
  for (const entry of entries.value) {
    const label = Number.isFinite(entry.at) ? dayLabel(entry.at) : null
    if (label !== null && label !== day) {
      day = label
      list.push({ kind: 'day', key: `day-${entry.at}`, label })
    }
    const bubble = view(entry)
    const sender = entry.kind === 'message' ? (entry.message.sender?.id ?? null) : null
    bubble.grouped = previous !== null && previous.mine === bubble.mine && previous.sender === sender && previous.day === day
    if (bubble.grouped && bubble.sender !== null) {
      bubble.sender = null
    }
    previous = { mine: bubble.mine, sender, day }
    list.push({ kind: 'bubble', bubble })
  }
  return list
})

function view(entry: TimelineEntry): BubbleView {
  const time = Number.isFinite(entry.at) ? clockTime(entry.at) : ''
  if (entry.kind === 'message') {
    const message = entry.message
    const sender = isGroup.value && !message.fromMe ? { label: senderLabel(message), tone: senderTone(message.sender?.id ?? '') } : null
    const who = message.fromMe ? 'You' : isGroup.value ? senderLabel(message) : name.value
    return {
      key: message.id,
      mine: message.fromMe,
      text: message.text,
      media: message.mediaKind === null ? null : message,
      sender,
      meta: time,
      state: 'none',
      error: null,
      outgoingId: null,
      label: `${who}, ${time}`,
      grouped: false,
    }
  }
  const reply = entry.outgoing
  const unconfirmed = reply.status === 'failed' && reply.error === 'unconfirmed'
  const label = desktopReplyLabel(replyLabel(reply, relayOnline.value), chats.relaysHere)
  const meta = unconfirmed ? `${time}, not confirmed` : localBubbleMeta(time, label)
  const state = unconfirmed ? 'unconfirmed' : reply.status === 'cancelled' ? 'none' : reply.status === 'waiting' && relayOnline.value ? 'sending' : reply.status
  return {
    key: reply.id,
    mine: true,
    text: reply.text,
    media: null,
    sender: null,
    meta,
    state,
    error: reply.error,
    outgoingId: reply.id,
    label: `You, ${time}, ${unconfirmed ? 'not confirmed' : (label ?? '').toLowerCase()}`,
    grouped: false,
  }
}

/** The user sees the chat: the window has the focus. Opening a chat, new messages and focus coming back read it then. */
function readable(): boolean {
  return typeof document === 'undefined' || document.hasFocus()
}

function markReadIfSeen(): void {
  const current = chat.value
  if (loaded.value && current !== null && !current.leftOut && readable()) {
    void chats.markRead(current)
  }
}

function nearBottom(): boolean {
  const element = scroller.value
  return element === null || element.scrollHeight - element.scrollTop - element.clientHeight < EDGE
}

function toBottom(): void {
  const element = scroller.value
  if (element !== null) {
    element.scrollTop = element.scrollHeight
  }
}

function take(page: ChatPage): void {
  chat.value = page.chat
  messages.value = page.messages
  outgoing.value = page.outgoing
  hasOlder.value = page.hasOlder
  announceReplies(page.outgoing)
  lookUpNames(page.messages)
  keepPolling()
}

/** Group senders without a name: the relay may know them by now. */
function lookUpNames(list: readonly SyncedChatMessage[]): void {
  const unnamed = list.filter((message) => message.sender !== null && nameText(message.sender.name) === '').map((message) => message.sender!.id)
  if (unnamed.length > 0) {
    void wa.lookUpNames(unnamed)
  }
}

/** Says each reply's change of state once (a reply that was there when the chat opened says nothing). */
function announceReplies(rows: readonly SyncedChatOutgoing[]): void {
  const next = new Map<string, string>()
  let said: string | null = null
  for (const row of rows) {
    if (row.status === 'cancelled') {
      continue
    }
    const state = `${row.status}:${row.error ?? ''}`
    next.set(row.id, state)
    const before = replyStates.get(row.id)
    if (loaded.value && before !== state) {
      said = replyAnnouncement(row.status, row.error, relayOnline.value, chats.relaysHere)
    }
  }
  replyStates = next
  if (said !== null) {
    say(announcement, said)
  }
}

/** The latest text handed to each live region; an earlier one still waiting for its tick is dropped. */
const saying = new Map<Ref<string>, number>()

/**
 * Puts `text` in a live region so it is spoken also when it equals what the region says now: the region is emptied
 * first and given the text on the next tick (an unchanged text changes nothing in the DOM, so it would not be said).
 * A newer text for the same region before that tick replaces this one, so one event is said once.
 */
function say(region: Ref<string>, text: string): void {
  const mine = (saying.get(region) ?? 0) + 1
  saying.set(region, mine)
  region.value = ''
  void nextTick(() => {
    if (!unmounted && saying.get(region) === mine) {
      region.value = text
    }
  })
}

/** The first window: the newest messages, scrolled to the end, and the chat read. */
async function open(): Promise<void> {
  const mine = ++loads
  loaded.value = false
  replyStates = new Map()
  const page = await chats.page(props.chatId, { limit: PAGE })
  if (unmounted || mine !== loads) {
    return
  }
  if (page === null || page.chat.leftOut) {
    chat.value = page?.chat ?? null
    messages.value = []
    outgoing.value = []
    loaded.value = true
    return
  }
  take(page)
  loaded.value = true
  chats.openChatId = props.chatId
  await nextTick()
  toBottom()
  heading.value?.focus()
  markReadIfSeen()
}

/** Reloads under way. */
let reloading = 0
/** Older messages were read while a reload was under way: that reload is overtaken and runs again after both. */
let reloadAgain = false

/**
 * The window again (the chats changed): from its first message on, so nothing above moves, and never fewer messages
 * than are loaded now.
 */
async function reload(): Promise<void> {
  if (!loaded.value || chat.value === null || chat.value.leftOut) {
    return
  }
  const mine = ++loads
  reloading++
  const first = messages.value[0]
  const follow = nearBottom()
  try {
    let page: ChatPage | null
    try {
      page = await chats.page(props.chatId, { limit: Math.max(PAGE, messages.value.length + PAGE), from: first === undefined ? null : chatMessageKey(first) })
    } catch (cause) {
      // The window stays as it is; the next change of the chats reads it again.
      console.error('Reading the chat failed', errorName(cause))
      return
    } finally {
      reloading--
    }
    if (unmounted) {
      return
    }
    if (mine !== loads) {
      // Overtaken: by a later reload (which brings what this one would), or by older messages, after which it runs again.
      if (reloadAgain && !loadingOlder.value && reloading === 0) {
        reloadAgain = false
        void reload()
      }
      return
    }
    if (page === null) {
      chat.value = null
      return
    }
    const newest = messages.value[messages.value.length - 1]
    take(page)
    announceIncoming(newest === undefined ? null : chatMessageKey(newest), page.messages)
    await nextTick()
    if (follow) {
      toBottom()
    }
    markReadIfSeen()
    if (olderAgain && !loadingOlder.value) {
      olderAgain = false
      void loadOlder(true)
    }
  } finally {
    // The older read it was to repeat is owed by a reload still under way, else by none: one that failed, found the
    // chat gone or met a newer read of older messages drops it, so a later reload never reads an extra older page.
    if (reloading === 0) {
      olderAgain = false
    }
  }
}

/**
 * Says incoming messages that landed at the newest end of the window in a read after the first one: the sender and the
 * start of the text for one, how many for several. Own messages, history read in older pages and the first load say
 * nothing, nor history the relay reads in (chats.historyThrough): anything while the first import runs, and while a
 * re-read runs (the chat was just taken back in) everything sent before it began.
 */
function announceIncoming(before: ChatMessageKey | null, list: readonly SyncedChatMessage[]): void {
  const history = chats.historyThrough
  const fresh = list.filter((message) => {
    const key = chatMessageKey(message)
    return !message.fromMe && (before === null || compareChatMessageKeys(key, before) > 0) && (history === null || key.sentAt > history)
  })
  if (fresh.length === 0) {
    return
  }
  if (fresh.length > 1) {
    say(incoming, `${fresh.length} new messages`)
    return
  }
  const message = chats.named(fresh[0]!)
  const sender = isGroup.value ? senderLabel(message) : name.value
  const text = labelText(message.text) || (message.mediaKind === null ? '' : mediaKindLabel(message.mediaKind))
  const characters = [...text]
  const start = characters.length > INCOMING_MAX ? `${characters.slice(0, INCOMING_MAX - 1).join('').trimEnd()}…` : text
  say(incoming, start === '' ? sender : `${sender}: ${start}`)
}

/** Older messages before the first one, keeping what is on screen where it is. */
/** Older messages were overtaken by a reload that started while they were read: read them again once it landed. */
let olderAgain = false

/** Older messages before the first one (`retried`: the read once more after an overtaken one, which is not repeated). */
async function loadOlder(retried = false): Promise<void> {
  const first = messages.value[0]
  if (!hasOlder.value || loadingOlder.value || first === undefined) {
    return
  }
  let overtaken = false
  loadingOlder.value = true
  // A reload under way when this lands would replace the window with one from before: it is overtaken (and runs again).
  const mine = ++loads
  if (reloading > 0) {
    reloadAgain = true
  }
  try {
    let page: ChatPage | null
    try {
      page = await chats.page(props.chatId, { limit: PAGE, before: chatMessageKey(first) })
    } catch (cause) {
      // The window and its scroll position stay as they are; scrolling up or Older reads them again.
      console.error('Reading older chat messages failed', errorName(cause))
      return
    }
    if (unmounted || page === null) {
      return
    }
    if (mine !== loads) {
      overtaken = !retried
      return
    }
    const element = scroller.value
    const height = element?.scrollHeight ?? 0
    const top = element?.scrollTop ?? 0
    messages.value = [...page.messages, ...messages.value]
    hasOlder.value = page.hasOlder
    outgoing.value = page.outgoing
    lookUpNames(page.messages)
    await nextTick()
    if (element !== null) {
      element.scrollTop = top + (element.scrollHeight - height)
    }
  } finally {
    loadingOlder.value = false
    if (reloadAgain && reloading === 0 && !unmounted) {
      reloadAgain = false
      void reload()
    } else if (overtaken && !unmounted) {
      // The reload that overtook it is still under way: it reads them again when it landed; else now, once.
      if (reloading > 0) {
        olderAgain = true
      } else {
        void loadOlder(true)
      }
    }
  }
}

function onScroll(): void {
  if ((scroller.value?.scrollTop ?? 0) < EDGE) {
    void loadOlder()
  }
}

/** While a reply waits or is being sent, the window is read again now and then (the relay sends in its rounds). */
function keepPolling(): void {
  const needed = chats.needsPolling(outgoing.value)
  if (needed && poll === null) {
    poll = setInterval(() => void reload(), chats.REPLY_POLL_MS)
  } else if (!needed && poll !== null) {
    clearInterval(poll)
    poll = null
  }
}

watch(
  () => props.chatId,
  () => void open(),
  { immediate: true },
)
watch(() => chats.version, () => void reload())

async function act(work: () => Promise<void>): Promise<void> {
  if (busy.value) {
    return
  }
  busy.value = true
  try {
    await work()
  } catch (cause) {
    compose.notify({ text: errorMessage(cause), tone: 'error' })
  } finally {
    busy.value = false
  }
}

async function send(text: string): Promise<boolean> {
  sendError.value = null
  chats.clearAttach(props.chatId)
  try {
    await chats.send(props.chatId, text)
    await nextTick()
    toBottom()
    return true
  } catch (cause) {
    sendError.value = errorMessage(cause)
    return false
  }
}

function retry(id: string | null): Promise<void> {
  return act(async () => {
    if (id !== null) {
      await chats.retry(props.chatId, id)
    }
  })
}

function cancel(id: string | null): Promise<void> {
  return act(async () => {
    if (id !== null) {
      await chats.cancel(props.chatId, id)
    }
  })
}

/** Do: a todo titled `Reply to <chat>`, which the user sees and may change first; nothing else of the chat goes in. */
async function startTodo(): Promise<void> {
  todoTitle.value = `Reply to ${name.value}`.slice(0, TODO_TITLE_MAX_LENGTH)
  todoStatus.value = ''
  await nextTick()
  todoField.value?.focus()
  todoField.value?.select()
}

async function addTodo(): Promise<void> {
  const title = todoTitle.value?.trim() ?? ''
  if (title === '' || addingTodo.value) {
    return
  }
  addingTodo.value = true
  try {
    await todos.create({ title })
    todoTitle.value = null
    todoStatus.value = 'Todo added.'
    await nextTick()
    heading.value?.focus()
  } catch (cause) {
    todoStatus.value = errorMessage(cause)
  } finally {
    addingTodo.value = false
  }
}

function closeTodo(): void {
  todoTitle.value = null
  void nextTick(() => heading.value?.focus())
}

function noted(): Promise<void> {
  return act(async () => {
    if (chat.value !== null) {
      await chats.noted(chat.value)
      await router.push(props.backTo)
    }
  })
}

function archive(): Promise<void> {
  return act(async () => {
    if (chat.value !== null) {
      await chats.archive(chat.value)
      await router.push(props.backTo)
    }
  })
}

function onMenu(id: string): void {
  if (id === 'leave') {
    confirmingLeave.value = true
    void nextTick(() => leaveCancel.value?.focus())
  }
}

function cancelLeave(): void {
  confirmingLeave.value = false
  void nextTick(() => heading.value?.focus())
}

function leaveOut(): Promise<void> {
  return act(async () => {
    const current = chat.value
    if (current === null) {
      return
    }
    if (await chats.leaveChatOut(current)) {
      // MailView moves the focus to the list once the chat is gone from the route.
      confirmingLeave.value = false
      await router.push(props.backTo)
    } else if (wa.error !== null) {
      throw new Error(wa.error)
    }
  })
}

function onNotice(): void {
  if (notice.value === 'unlinked') {
    void router.push({ name: 'settings-whatsapp' })
  } else {
    void wa.start()
  }
}

/**
 * Whether the chat has the user's attention, by the mail pane's rules (ReadingPane's attentive): a chat on screen, the
 * compose window not open in front, no modal layer (modalOpen), nothing ticked in the list (the bulk bar takes the keys
 * then), and none of the pane's own menu, confirmation or todo field open.
 */
function attentive(): boolean {
  return (
    chat.value !== null &&
    !chat.value.leftOut &&
    !(compose.draft !== null && !compose.minimized) &&
    !modalOpen() &&
    !selection.active &&
    menu.value?.open !== true &&
    !confirmingLeave.value &&
    todoTitle.value === null
  )
}

// D makes a todo, K notes, E archives: only while the chat has the user's attention, not while they type, hold the key
// down or use a modifier.
function shortcut(event: KeyboardEvent): void {
  if (!shortcutAllowed(event, compose.draft !== null && !compose.minimized) || !attentive()) {
    return
  }
  const action = { d: startTodo, k: noted, e: archive }[event.key.toLowerCase()]
  if (action !== undefined) {
    event.preventDefault()
    void action()
  }
}

onMounted(() => {
  window.addEventListener('keydown', shortcut)
  window.addEventListener('focus', markReadIfSeen)
})
onBeforeUnmount(() => {
  unmounted = true
  window.removeEventListener('keydown', shortcut)
  window.removeEventListener('focus', markReadIfSeen)
  if (poll !== null) {
    clearInterval(poll)
  }
  if (chats.openChatId === props.chatId) {
    chats.openChatId = null
  }
})
</script>

<template>
  <article class="pane chat-pane" :aria-label="chat ? `WhatsApp chat with ${name}` : 'WhatsApp chat'">
    <div v-if="!loaded" class="state" role="status"><LogoLoader /> Loading the chat…</div>
    <p v-else-if="chat === null" class="state">
      This chat is not on this Mac any more. <RouterLink :to="backTo">Back to the list</RouterLink>
    </p>
    <p v-else-if="chat.leftOut" class="state">
      You left this chat out. Take it back in under <RouterLink :to="{ name: 'settings-whatsapp' }">Settings, WhatsApp</RouterLink>.
    </p>
    <template v-else>
      <div class="head">
        <RouterLink :to="backTo" class="tool back" aria-label="Back to the list" title="Back to the list"><AppIcon name="back" /></RouterLink>
        <SenderAvatar :sender="{ name, address: chat.jid }" :size="36" />
        <span class="who">
          <h2 ref="heading" class="name" tabindex="-1" dir="auto">{{ name }}</h2>
          <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>
        </span>
        <span class="pill">WhatsApp</span>
        <span class="spacer" />
        <div class="actions" role="group" aria-label="Chat actions">
          <button type="button" class="verdict do" aria-keyshortcuts="D" title="Do: make a todo to reply (D)" :disabled="busy" @click="startTodo">Do <KeyShortcut keys="D" /></button>
          <button type="button" class="verdict know" aria-keyshortcuts="K" title="Noted: mark read and archive (K)" :disabled="busy" @click="noted">Noted <KeyShortcut keys="K" /></button>
          <button type="button" class="tool" aria-keyshortcuts="E" title="Archive (E)" :disabled="busy" @click="archive"><AppIcon name="archive" label="Archive" /></button>
          <MenuButton ref="menu" label="More" menu-label="More for this chat" :items="[{ id: 'leave', label: 'Leave this chat out' }]" :disabled="busy" @choose="onMenu" />
        </div>
      </div>

      <form v-if="todoTitle !== null" class="todo" @submit.prevent="addTodo" @keydown.esc.prevent="closeTodo">
        <label for="chat-todo" class="todo-label">Todo</label>
        <input id="chat-todo" ref="todoField" v-model="todoTitle" :maxlength="TODO_TITLE_MAX_LENGTH" autocomplete="off" @keydown.enter="($event: KeyboardEvent) => composing($event) && $event.preventDefault()" />
        <button type="submit" class="button button-primary" :disabled="addingTodo || todoTitle.trim() === ''">Add</button>
        <button type="button" class="button button-quiet" @click="closeTodo">Cancel</button>
      </form>
      <p class="visually-hidden" role="status">{{ todoStatus }}</p>
      <p class="visually-hidden incoming" aria-live="polite">{{ incoming }}</p>

      <div v-if="confirmingLeave" class="confirm" role="alertdialog" aria-labelledby="chat-leave-title" aria-describedby="chat-leave-body" @keydown.esc.prevent="cancelLeave">
        <p id="chat-leave-title"><strong>{{ LEAVE_OUT_TITLE }}</strong></p>
        <p id="chat-leave-body">{{ LEAVE_OUT_BODY }}</p>
        <div class="confirm-actions">
          <button type="button" class="button button-danger" :disabled="busy" @click="leaveOut">Leave out</button>
          <button ref="leaveCancel" type="button" class="button button-quiet" :disabled="busy" @click="cancelLeave">Cancel</button>
        </div>
      </div>

      <ChatNotice v-if="notice" :kind="notice" :busy="wa.busy !== null" @act="onNotice" />

      <!-- A region, not a log: a log would read out the history as it loads; changes of a reply are said by the composer. -->
      <div ref="scroller" class="timeline" role="region" tabindex="0" aria-label="Messages" @scroll.passive="onScroll">
        <button v-if="hasOlder" type="button" class="button button-quiet older" :disabled="loadingOlder" @click="loadOlder()">
          {{ loadingOlder ? 'Loading older messages…' : 'Show older messages' }}
        </button>
        <ol class="bubbles">
          <template v-for="row in rows" :key="row.kind === 'day' ? row.key : row.bubble.key">
            <li v-if="row.kind === 'day'" class="day"><span>{{ row.label }}</span></li>
            <ChatBubble
              v-else
              :bubble="row.bubble"
              :media-state="row.bubble.media ? chats.mediaOf(row.bubble.media.id) : undefined"
              :busy="busy"
              @retry="retry(row.bubble.outgoingId)"
              @cancel="cancel(row.bubble.outgoingId)"
              @download="row.bubble.media && chat && chats.download(chat, row.bubble.media)"
              @open="row.bubble.media && chats.openFile(row.bubble.media)"
            />
          </template>
        </ol>
        <p v-if="rows.length === 0" class="empty">No messages in this chat yet.</p>
      </div>

      <ChatComposer
        :send="send"
        :label="`Reply to ${name}`"
        :disabled="!chats.canReply"
        :note="composerNote"
        :send-note="sendNote"
        :can-attach="chats.canAttach"
        :attaching="chats.attaching.state === 'sending'"
        :attach-line="attachLine"
        :announcement="announcement"
        :error="sendError"
        :draft="draft"
        @update:draft="onDraft"
        @attach="chats.attach(chat)"
      />
    </template>
  </article>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: var(--glass-edge);
}
.state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 32px 40px;
  color: var(--ink-2);
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--line);
}
.who {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-right: 8px;
}
.name {
  margin: 0;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
  unicode-bidi: isolate;
}
.name:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.subtitle {
  font-size: 12px;
  color: var(--ink-2);
}
.pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--know-soft);
  color: var(--know);
  font-size: 12px;
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
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
.tool:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.back {
  display: none;
}
@media (max-width: 1100px) {
  .back {
    display: inline-flex;
  }
}
.verdict {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.verdict.do {
  color: var(--do);
}
.verdict.know {
  color: var(--know);
}
.verdict:hover:not(:disabled) {
  background: var(--ground);
}
.verdict:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.verdict:disabled,
.tool:disabled {
  opacity: 0.5;
  cursor: default;
}
.todo {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--do-soft);
}
.todo-label {
  font-size: 13px;
  font-weight: 600;
}
.todo input {
  flex: 1 1 240px;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--paper);
  color: var(--ink);
  font: 400 14px var(--font-ui);
}
.confirm {
  margin: 12px 24px 0;
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-card);
  background: var(--paper);
}
.confirm p {
  margin: 0 0 8px;
}
.confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.timeline {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 32px 24px;
  background: var(--chat-timeline);
  overflow-anchor: none;
}
.timeline:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.older {
  display: flex;
  margin: 0 auto 8px;
}
.bubbles {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.day {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}
.day span {
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--chat-day);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.empty {
  margin: 24px 0;
  color: var(--ink-2);
  text-align: center;
}
@media (max-width: 760px) {
  .head {
    padding: 10px 16px;
  }
  .timeline {
    padding: 12px 16px;
  }
  .verdict,
  .back {
    min-height: 44px;
  }
}
</style>
