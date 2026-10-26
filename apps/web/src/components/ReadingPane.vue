<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { classificationReasonText, dueLabel, unsubscribeOffer, todoSourceMessage, type MessageAction, type SyncedMessage, type SyncedThread, type Todo, handOverStatus, openHandOversOf } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import type { AppliedAction } from '@tresso/core'
import { shortcutAllowed, useMessageActions } from '@/mail/useMessageActions'
import { shortDue, senderName } from '@/mail/format'
import { useComposeStore } from '@/stores/compose'
import { useHandOversStore } from '@/stores/handOvers'
import { useMailStore } from '@/stores/mail'
import { useSelectionStore } from '@/stores/selection'
import { useTodosStore } from '@/stores/todos'
import AppIcon from '@/components/AppIcon.vue'
import ClassificationMenu from '@/components/ClassificationMenu.vue'
import MessageCard from '@/components/MessageCard.vue'
import MenuButton from '@/components/MenuButton.vue'
import UnsubscribeAction from '@/components/UnsubscribeAction.vue'

const props = defineProps<{ threadId: string; backTo: string }>()

const mail = useMailStore()
const compose = useComposeStore()
const handOvers = useHandOversStore()
const router = useRouter()
const thread = ref<SyncedThread | null>(null)
const messages = ref<SyncedMessage[]>([])
const folders = computed(() => mail.allFolders)
const expanded = ref(new Set<string>())
const notFound = ref(false)
/**
 * The pulls done when this conversation opened. Until one more is done, a conversation that is not in the copy may
 * just not have arrived yet (a clicked notification can be quicker than the delta), so it shows as loading.
 */
const pullsAtOpen = ref(mail.pulls)
const missing = computed(() => notFound.value && mail.pulls > pullsAtOpen.value)
/** Not here, and the pull that would bring it failed (offline, the server unreachable). */
const unreachable = computed(() => notFound.value && !missing.value && mail.syncState === 'error')
/** The conversation a pull was asked for because it was not in the copy, so it is asked once. */
let pulledFor: string | null = null
const actions = useMessageActions()
const { busy, exclusive } = actions
const selection = useSelectionStore()
const moveMenu = ref<InstanceType<typeof MenuButton> | null>(null)
const todosStore = useTodosStore()
/** The todos made from this conversation's emails. */
const todos = ref<Todo[]>([])
const makingTodo = ref(false)
/** The conversation has no todo yet and nothing else is under way: the button shows, and T works, only then. */
const canMakeTodo = computed(() => todos.value.length === 0 && !busy.value && !makingTodo.value)
let unmounted = false

const flagged = computed(() => messages.value.some((message) => message.flags.flagged))
/** Who this conversation is handed over to and still waited on. */
const waitingOn = computed(() => openHandOversOf(mail.handOvers, props.threadId))
// Folders the conversation can move to: its account's, except the ones mail apps manage themselves.
const moveTargets = computed(() =>
  folders.value
    .filter((folder) => folder.mailAccountId === thread.value?.mailAccountId && folder.role !== 'drafts' && folder.role !== 'all')
    .sort((a, b) => a.displayName.localeCompare(b.displayName)),
)
// Junk gets no unsubscribe: confirming the address to a spammer only brings more.
const inSpam = computed(() => {
  const smartInboxId = thread.value?.smartInboxId
  return smartInboxId ? mail.smartInboxes.find((s) => s.id === smartInboxId)?.builtin === 'spam' : false
})
const unsubscribe = computed(() => (inSpam.value ? null : unsubscribeOffer(messages.value, mail.unsubscriptions)))

async function load(): Promise<void> {
  const threadId = props.threadId
  const [result, threadTodos] = await Promise.all([mail.thread(threadId), mail.todosOfThread(threadId)])
  notFound.value = result === null
  if (result === null && pulledFor !== threadId) {
    // Not here (yet): pull now, so it either arrives or is known to be gone.
    pulledFor = threadId
    void mail.syncNow()
  }
  thread.value = result?.thread ?? null
  messages.value = result?.messages ?? []
  todos.value = threadTodos
}

/** Makes a todo of the conversation, titled after its subject; the email keeps one todo however often this runs. */
async function makeTodo(): Promise<void> {
  const source = todoSourceMessage(messages.value, mail.accounts.map((account) => account.emailAddress))
  if (source === null || !canMakeTodo.value) {
    return
  }
  makingTodo.value = true
  try {
    await todosStore.makeFromMessage(source.id)
    if (!unmounted) {
      await load()
    }
  } catch (e) {
    compose.notify({ text: errorMessage(e), tone: 'error' })
  } finally {
    makingTodo.value = false
  }
}

watch(
  () => props.threadId,
  async (threadId) => {
    pullsAtOpen.value = mail.pulls
    await load()
    if (unmounted || threadId !== props.threadId) {
      return
    }
    // Opening a conversation reads it; actions the user takes meanwhile wait for that, so a quick "unread" goes after.
    // It starts before anything else is awaited, so no key can come in between.
    const unread = messages.value.filter((message) => !message.flags.seen).map((message) => message.id)
    if (unread.length > 0) {
      actions.after(run(unread, 'markRead'))
    }
    // Unread messages and the newest one open; read history stays folded.
    const open = new Set(unread)
    const newest = messages.value[messages.value.length - 1]
    if (newest) {
      open.add(newest.id)
    }
    expanded.value = open
  },
  { immediate: true },
)

// New mail in this thread arrives through sync, and todos made or changed elsewhere; reload so they show up.
watch(() => [mail.conversations, mail.todos], load)

function toggle(messageId: string): void {
  const next = new Set(expanded.value)
  if (!next.delete(messageId)) {
    next.add(messageId)
  }
  expanded.value = next
}

/** Archives, trashes or moves the whole conversation and goes back to the list. */
function relocate(action: 'archive' | 'trash' | 'move', folderId?: string): Promise<void> {
  return exclusive(async () => {
    if ((await actions.relocate(messages.value.map((message) => message.id), action, folders.value, folderId)) !== null) {
      await router.push(props.backTo)
    }
  })
}

async function run(messageIds: string[], action: MessageAction): Promise<AppliedAction | null> {
  const applied = await actions.run(messageIds, action)
  if (applied !== null && !unmounted) {
    await load()
  }
  return applied
}

function markUnread(): Promise<void> {
  return exclusive(async () => {
    const newest = messages.value[messages.value.length - 1]
    if (newest && (await run([newest.id], 'markUnread')) !== null) {
      await router.push(props.backTo)
    }
  })
}

function toggleFlag(): Promise<void> {
  return exclusive(async () => {
    if (flagged.value) {
      await run(
        messages.value.filter((message) => message.flags.flagged).map((message) => message.id),
        'unflag',
      )
      return
    }
    const newest = messages.value[messages.value.length - 1]
    if (newest) {
      await run([newest.id], 'flag')
    }
  })
}

function moveTo(folderId: string): void {
  void relocate('move', folderId)
}

function handOver(): Promise<void> {
  return handOvers.openForThread(props.threadId)
}

// E archives, # trashes, U marks unread, S flags, H hands over: only when the conversation has the user's attention, not while
// they type, write in the compose window, hold the key down, or have conversations selected in the list.
function shortcut(event: KeyboardEvent): void {
  if (!shortcutAllowed(event, compose.draft !== null && !compose.minimized) || thread.value === null || moveMenu.value?.open === true || selection.active || handOvers.handingOver !== null) {
    return
  }
  const action = { e: () => relocate('archive'), '#': () => relocate('trash'), u: markUnread, s: toggleFlag, t: makeTodo, h: handOver }[event.key.toLowerCase()]
  if (action !== undefined) {
    event.preventDefault()
    void action()
  }
}
onMounted(() => window.addEventListener('keydown', shortcut))
onBeforeUnmount(() => {
  unmounted = true
  window.removeEventListener('keydown', shortcut)
})
</script>

<template>
  <article class="pane" aria-label="Conversation">
    <p v-if="unreachable" class="missing" role="alert">
      This conversation could not be loaded: {{ mail.syncError }}. It opens once Tresso can sync again.
      <button type="button" class="button button-quiet" @click="mail.syncNow()">Try again</button>
    </p>
    <p v-else-if="notFound && !missing" class="state" role="status">Loading the conversation…</p>
    <p v-if="missing" class="missing">This conversation no longer exists. <RouterLink :to="backTo">Back to the inbox</RouterLink></p>
    <div v-else-if="thread" class="inner">
      <div class="actions" role="group" aria-label="Conversation actions">
        <button type="button" class="tool" :disabled="busy" aria-keyshortcuts="E" title="Archive (E)" @click="relocate('archive')"><AppIcon name="archive" label="Archive" /></button>
        <button type="button" class="tool" :disabled="busy" aria-keyshortcuts="#" title="Move to Trash (#)" @click="relocate('trash')"><AppIcon name="trash" label="Move to Trash" /></button>
        <button type="button" class="tool" :disabled="busy" aria-keyshortcuts="U" title="Mark unread (U)" @click="markUnread"><AppIcon name="unread" label="Mark unread" /></button>
        <button type="button" class="tool" :class="{ on: flagged }" :disabled="busy" :aria-pressed="flagged" aria-keyshortcuts="S" :title="flagged ? 'Remove flag (S)' : 'Flag (S)'" @click="toggleFlag">
          <AppIcon name="flag" label="Flag" />
        </button>
        <button
          v-if="todos.length === 0"
          type="button"
          class="tool make-todo"
          :disabled="!canMakeTodo"
          aria-keyshortcuts="T"
          title="Make todo (T)"
          @click="makeTodo"
        >
          <AppIcon name="todo" /> <span>Make todo</span>
        </button>
        <button type="button" class="tool labelled" aria-keyshortcuts="H" title="Hand over (H)" @click="handOver"><AppIcon name="delegate" />Hand over</button>
        <MenuButton
          ref="moveMenu"
          class="move"
          label="Move to"
          menu-label="Move to folder"
          icon="folder"
          :items="moveTargets.map((folder) => ({ id: folder.id, label: folder.displayName }))"
          :disabled="busy"
          @choose="moveTo"
        />
        <UnsubscribeAction class="unsubscribe" :offer="unsubscribe" />
      </div>
      <div class="classification">
        <ClassificationMenu
          :thread-id="thread.id"
          :subject="thread.subject"
          :smart-inbox-id="thread.smartInboxId ?? null"
          :verdict="thread.verdict ?? null"
          show-smart-inbox
        />
        <span v-if="classificationReasonText(thread.classificationReason ?? null)" class="reason">{{ classificationReasonText(thread.classificationReason ?? null) }}</span>
      </div>
      <h2 class="subject">{{ thread.subject || '(no subject)' }}</h2>
      <ul v-if="todos.length > 0" class="todos" aria-label="Todos from this conversation">
        <li v-for="todo in todos" :key="todo.id">
          <RouterLink :to="{ name: 'todo', params: { todoId: todo.id } }" class="todo" :class="{ done: todo.completedAt !== null }">
            <AppIcon name="todo" :size="15" />
            <span class="todo-title">{{ todo.title }}</span>
            <span class="todo-state">{{ dueLabel(todo, new Date()) ?? 'Open' }}</span>
          </RouterLink>
        </li>
      </ul>
      <p v-for="item in waitingOn" :key="item.id" class="handed" :class="{ late: handOverStatus(item) === 'overdue' }">
        <AppIcon name="delegate" />
        <span class="handed-text">
          Handed over to <strong>{{ senderName(item.delegate) }}</strong>, {{ handOverStatus(item) === 'overdue' ? 'was due' : 'due' }} {{ shortDue(item.dueAt) }}
        </span>
        <RouterLink :to="{ name: 'waiting', query: { nudge: item.id } }" class="handed-action">Nudge</RouterLink>
        <button type="button" class="handed-action" @click="handOvers.markDone(item)">Mark done</button>
      </p>
      <MessageCard
        v-for="message in messages"
        :key="message.id"
        :message="message"
        :expanded="expanded.has(message.id)"
        @toggle="toggle(message.id)"
      />
    </div>
  </article>
</template>

<style scoped>
.pane {
  min-height: 0;
  overflow-y: auto;
  background: var(--surface);
}
.inner {
  padding: 24px 40px 32px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-bottom: 16px;
}
.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
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
.tool:disabled {
  opacity: 0.5;
  cursor: default;
}
.move {
  margin-left: 8px;
}
.make-todo {
  margin-left: 8px;
  font-size: 13px;
  font-weight: 600;
}
.todos {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
}
.todo {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--do-soft);
  color: var(--ink);
  font-size: 13px;
  text-decoration: none;
}
.todo-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.todo-state {
  color: var(--ink-2);
}
.todo.done {
  background: transparent;
}
.todo.done .todo-title {
  color: var(--ink-3);
  text-decoration: line-through;
}
.unsubscribe {
  margin-left: auto;
}
.tool.labelled {
  font-weight: 600;
  font-size: 13px;
}
.handed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: var(--radius-control);
  background: var(--delegate-soft);
  color: var(--ink);
  font-size: 13px;
}
.handed.late {
  background: var(--danger-soft);
}
.handed-text {
  flex: 1;
  min-width: 0;
}
.handed-action {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
}
.tool.on {
  color: var(--delegate);
}
.classification {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin-bottom: 8px;
}
.reason {
  font-size: 12px;
  color: var(--ink-2);
}
.subject {
  margin: 0 0 8px;
  font-size: 26px;
  line-height: 34px;
  font-weight: 600;
}
.missing,
.state {
  padding: 32px 40px;
  color: var(--ink-2);
}
</style>
