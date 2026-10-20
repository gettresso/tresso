<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { z } from 'zod'
import { firstName, handOverStatus, nudgeStands, nudgeText, type HandOverStatus, type SyncedHandOver, type SyncedOutgoingMessage } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { dayValue, pickedDue } from '@/forms/handOver'
import { provideRequiredFields } from '@/forms/required'
import { dueLabel, senderName, shortDue } from '@/mail/format'
import { useHandOversStore } from '@/stores/handOvers'
import { useMailStore } from '@/stores/mail'
import AppIcon from '@/components/AppIcon.vue'
import FieldLabel from '@/forms/FieldLabel.vue'

/** Closed hand-overs listed below the open ones; older ones stay out of the way. */
const CLOSED_SHOWN = 20

const mail = useMailStore()
const handOvers = useHandOversStore()
const route = useRoute()
const router = useRouter()

const open = computed(() => mail.handOvers.filter((handOver) => handOver.state === 'open'))
const closed = computed(() => mail.handOvers.filter((handOver) => handOver.state !== 'open').slice(0, CLOSED_SHOWN))
const overdueCount = computed(() => open.value.filter((handOver) => handOverStatus(handOver) === 'overdue').length)
const summary = computed(() => {
  if (open.value.length === 0) {
    return 'Nothing handed over right now'
  }
  const waiting = `${open.value.length} handed over`
  return overdueCount.value === 0 ? waiting : `${waiting}, ${overdueCount.value} past due`
})

/** Who sent the message that was handed over, from the copy; the hand-over itself keeps only the subject. */
const senders = ref(new Map<string, string>())
/** The latest nudge of each hand-over, to tell whether it still counts. */
const nudges = ref(new Map<string, SyncedOutgoingMessage | null>())
watch(
  () => mail.handOvers,
  async (list) => {
    const nextSenders = new Map<string, string>()
    const nextNudges = new Map<string, SyncedOutgoingMessage | null>()
    for (const handOver of list) {
      if (handOver.threadId !== null && handOver.messageId !== null) {
        const message = (await mail.thread(handOver.threadId))?.messages.find((candidate) => candidate.id === handOver.messageId)
        if (message !== undefined) {
          nextSenders.set(handOver.id, senderName(message.from))
        }
      }
      if (handOver.lastNudgeId !== null) {
        nextNudges.set(handOver.id, await mail.outgoing(handOver.lastNudgeId))
      }
    }
    senders.value = nextSenders
    nudges.value = nextNudges
  },
  { immediate: true },
)

function initials(handOver: SyncedHandOver): string {
  const words = (handOver.delegate.name?.trim() || handOver.delegate.address).split(/[\s@.]+/).filter((word) => word !== '')
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('')
}

const statusText: Record<HandOverStatus, string> = { overdue: 'Overdue', waiting: 'Waiting', replied: 'Replied', done: 'Done' }

function status(handOver: SyncedHandOver): string {
  const now = handOverStatus(handOver)
  if (now === 'waiting' && nudgeStands(handOver, nudges.value.get(handOver.id) ?? null) && handOver.nudgedAt !== null) {
    return `Nudged ${shortDue(handOver.nudgedAt)}`
  }
  return statusText[now]
}

function threadLink(handOver: SyncedHandOver) {
  return handOver.threadId === null ? null : { name: 'unified-thread', params: { threadId: handOver.threadId } }
}

/** The hand-over whose follow-up is open in the side panel. */
const nudging = computed(() => {
  const id = typeof route.query.nudge === 'string' ? route.query.nudge : null
  return open.value.find((handOver) => handOver.id === id) ?? null
})

function nudge(handOver: SyncedHandOver): void {
  void router.replace({ name: 'waiting', query: { nudge: handOver.id } })
}

function closeDraft(): void {
  void router.replace({ name: 'waiting' })
}

const followUpSchema = z.object({ text: z.string().trim().min(1, 'Write what to ask.').max(10_000, 'Use at most 10000 characters.') })
const dueSchema = z.object({
  day: z
    .string()
    .min(1, 'Pick the new due date.')
    .refine((day) => (pickedDue(day)?.getTime() ?? 0) > Date.now(), 'Pick a day that is still ahead.'),
})
provideRequiredFields(followUpSchema, dueSchema)
const { defineField, handleSubmit, errors, resetForm, isSubmitting } = useForm<z.infer<typeof followUpSchema>>({
  validationSchema: toTypedSchema(followUpSchema),
  initialValues: { text: '' },
})
const [text] = defineField('text')
const ui = reactive({ busy: false, error: null as string | null })
/** A follow-up is under way: from the first press on, while the form validates, until the server answered. */
const sending = computed(() => isSubmitting.value || ui.busy)
const account = computed(() => mail.accounts.find((candidate) => candidate.id === nudging.value?.mailAccountId) ?? null)

// Each hand-over gets a fresh suggestion when its panel opens.
watch(
  () => nudging.value?.id,
  () => {
    ui.error = null
    resetForm({ values: { text: nudging.value === null ? '' : nudgeText(nudging.value, dueLabel(nudging.value.dueAt)) } })
  },
  { immediate: true },
)

const send = handleSubmit(async (values) => {
  const handOver = nudging.value
  if (handOver === null) {
    return
  }
  ui.busy = true
  ui.error = null
  try {
    await handOvers.nudge(handOver, values.text)
    closeDraft()
  } catch (error) {
    ui.error = errorMessage(error)
  } finally {
    ui.busy = false
  }
})

const editFirst = handleSubmit(async (values) => {
  const handOver = nudging.value
  if (handOver !== null) {
    await handOvers.editFollowUp(handOver, values.text)
    closeDraft()
  }
})

async function noLongerWaiting(handOver: SyncedHandOver): Promise<void> {
  if (await handOvers.markDone(handOver)) {
    closeDraft()
  }
}

function keydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    // A second press while the first is on its way would nudge the delegate twice.
    if (!sending.value) {
      void send()
    }
  }
}

/** A new due date for the hand-over in the panel. */
const dueForm = useForm<z.infer<typeof dueSchema>>({ validationSchema: toTypedSchema(dueSchema), initialValues: { day: '' } })
const [newDueDay] = dueForm.defineField('day')
const moveDue = dueForm.handleSubmit(async (values) => {
  const at = pickedDue(values.day)
  if (nudging.value !== null && at !== null && (await handOvers.reschedule(nudging.value, at))) {
    dueForm.resetForm()
  }
})
// Today in the user's own calendar; a day whose due time passed already is refused by the schema.
const minDay = dayValue(new Date())
</script>

<template>
  <div class="shell">

    <main class="main">
      <section class="panel waiting" aria-labelledby="waiting-title">
        <header class="head">
          <h1 id="waiting-title">Waiting on</h1>
          <span class="summary">{{ summary }}</span>
        </header>

        <div class="group">
          <div class="group-head">
            <AppIcon name="delegate" class="group-icon" />
            <h2>Handed over</h2>
            <span class="group-sub">You stay in the loop until they reply</span>
          </div>
          <p v-if="open.length === 0" class="empty">Use Hand over on a conversation (H) to forward it with a note and a due date. It shows here until they reply.</p>
          <ul v-else class="rows">
            <li v-for="handOver in open" :key="handOver.id" class="row" :class="{ selected: nudging?.id === handOver.id }">
              <component :is="threadLink(handOver) ? 'RouterLink' : 'span'" :to="threadLink(handOver) ?? undefined" class="what">
                <span class="subject">{{ handOver.subject || '(no subject)' }}</span>
                <span class="from">{{ senders.get(handOver.id) ? `From ${senders.get(handOver.id)}` : handOver.note || 'Forwarded' }}</span>
              </component>
              <span class="who">
                <span class="initials" aria-hidden="true">{{ initials(handOver) }}</span>
                <span class="name">{{ senderName(handOver.delegate) }}</span>
              </span>
              <span class="due" :class="{ late: handOverStatus(handOver) === 'overdue' }">Due {{ shortDue(handOver.dueAt) }}</span>
              <span class="status" :class="handOverStatus(handOver)">{{ status(handOver) }}</span>
              <button type="button" class="button button-quiet nudge" :aria-pressed="nudging?.id === handOver.id" @click="nudge(handOver)"><AppIcon name="reply" :size="14" />Nudge</button>
            </li>
          </ul>
        </div>

        <div v-if="closed.length > 0" class="group">
          <div class="group-head">
            <h2>Closed</h2>
            <span class="group-sub">Replied, or marked done</span>
          </div>
          <ul class="rows">
            <li v-for="handOver in closed" :key="handOver.id" class="row closed">
              <component :is="threadLink(handOver) ? 'RouterLink' : 'span'" :to="threadLink(handOver) ?? undefined" class="what">
                <span class="subject">{{ handOver.subject || '(no subject)' }}</span>
                <span class="from">{{ senderName(handOver.delegate) }}</span>
              </component>
              <span class="status" :class="handOver.state">{{ statusText[handOverStatus(handOver)] }}</span>
              <button type="button" class="button button-quiet" @click="handOvers.reopen(handOver)">Wait again</button>
            </li>
          </ul>
        </div>
      </section>

      <aside class="panel followup" aria-label="Drafted follow-up">
        <template v-if="nudging">
          <div class="followup-head">
            <h2>Follow-up draft</h2>
            <button type="button" class="close" aria-label="Close draft" @click="closeDraft"><AppIcon name="close" :size="16" /></button>
          </div>
          <div class="meta">
            <span><strong>To</strong> {{ senderName(nudging.delegate) }}</span>
            <span><strong>About</strong> {{ nudging.subject || '(no subject)' }}</span>
            <span><strong>Due</strong> {{ dueLabel(nudging.dueAt) }}</span>
          </div>
          <form class="draft" novalidate @submit.prevent="!sending && send()" @keydown="keydown">
            <label class="suggested">
              <FieldLabel name="text" class="suggested-label">Suggested follow-up for {{ firstName(nudging.delegate) }}</FieldLabel>
              <textarea v-model="text" rows="8" :aria-invalid="errors.text ? 'true' : undefined" />
            </label>
            <small v-if="errors.text" class="error">{{ errors.text }}</small>
            <p v-if="ui.error" class="error" role="alert">{{ ui.error }}</p>
            <div class="buttons">
              <button type="submit" class="button button-primary" :disabled="sending">{{ sending ? 'Sending…' : 'Send follow-up' }} <kbd>Cmd Enter</kbd></button>
              <button type="button" class="button button-quiet" :disabled="sending" @click="editFirst">Edit first</button>
              <button type="button" class="button button-quiet" :disabled="sending" @click="noLongerWaiting(nudging)">No longer waiting</button>
            </div>
          </form>
          <p class="fine">
            Sent as a reply in the same conversation<template v-if="account">, from {{ account.emailAddress }}</template>. It stays in Waiting on until
            they answer.
          </p>
          <form class="move-due" novalidate @submit.prevent="moveDue">
            <label>
              <FieldLabel name="day">Give them until</FieldLabel>
              <input v-model="newDueDay" type="date" :min="minDay" :aria-invalid="dueForm.errors.value.day ? 'true' : undefined" />
            </label>
            <button type="submit" class="button button-quiet">Move the due date</button>
            <small v-if="dueForm.errors.value.day" class="error">{{ dueForm.errors.value.day }}</small>
          </form>
        </template>
        <template v-else>
          <h2>Follow-ups</h2>
          <p class="fine">Choose Nudge on a hand-over to see a drafted follow-up here. Nothing is sent until you confirm.</p>
        </template>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.main {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 16px;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 16px 16px 0;
}
.panel {
  min-width: 0;
  box-sizing: border-box;
  border-radius: 14px;
  background: var(--surface);
}
.waiting {
  flex: 1.6 1 520px;
}
.followup {
  flex: 1 1 340px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 22px 24px;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 12px;
  padding: 22px 24px 16px;
  border-bottom: 1px solid var(--line);
}
h1 {
  flex: 1;
  margin: 0;
  font: 700 28px/34px var(--font-display);
}
.summary,
.group-sub,
.fine {
  font-size: 13px;
  color: var(--ink-2);
}
.group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 24px 8px;
}
.group:last-child {
  padding-bottom: 24px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.group-icon {
  color: var(--delegate);
}
h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.followup h2 {
  font-size: 17px;
}
.empty {
  margin: 0;
  padding: 16px;
  border: 1px dashed var(--line);
  border-radius: 10px;
  color: var(--ink-2);
  font-size: 14px;
}
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  min-height: 56px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
}
.row:last-child {
  border-bottom: 0;
}
.row.selected {
  background: var(--selected);
  box-shadow: inset 3px 0 0 var(--focus);
}
.what {
  flex: 1 1 220px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: var(--ink);
  text-decoration: none;
}
.subject,
.from,
.name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subject {
  font-size: 14px;
  font-weight: 600;
}
.from {
  font-size: 12px;
  color: var(--ink-2);
}
.who {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 140px;
  min-width: 0;
  font-size: 13px;
}
.initials {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: var(--delegate-soft);
  color: var(--delegate);
  font-size: 10px;
  font-weight: 700;
}
.due {
  width: 96px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
}
.due.late {
  color: var(--danger);
}
.status {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.status.overdue {
  background: var(--danger-soft);
  color: var(--danger);
}
.status.replied {
  background: var(--know-soft);
  color: var(--know);
}
.nudge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
}
.nudge[aria-pressed='true'] {
  outline: 1px solid var(--focus);
}
.followup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--ink-2);
}
.meta strong {
  color: var(--ink);
  font-weight: 600;
}
.draft {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.suggested {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--selected);
}
.suggested-label {
  color: var(--focus);
  font-size: 13px;
  font-weight: 600;
}
textarea {
  font: 14px/22px var(--font-ui);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  resize: vertical;
}
textarea:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 4px;
}
.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
kbd {
  font: 500 11px var(--font-mono);
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface) 25%, transparent);
}
.error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
.fine {
  margin: 0;
  line-height: 18px;
}
.move-due {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.move-due label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--ink-2);
}
.move-due input {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
}

@media (max-width: 760px) {
  .main {
    padding: 16px;
  }
}
</style>
