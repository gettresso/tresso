<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { classificationReasonText, proposedTime, RESPONSE_WORDS, toInstant, type TriageDecision } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { fullTime, senderName } from '@/mail/format'
import { shortcutAllowed } from '@/mail/useMessageActions'
import { useTriage } from '@/mail/useTriage'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'
import { useCalendarStore, type MessageInvitation, type Response } from '@/stores/calendar'
import AppIcon from '@/components/AppIcon.vue'
import MessageCard from '@/components/MessageCard.vue'
import SenderAvatar from '@/components/SenderAvatar.vue'
import EventEditor, { type EditorTarget } from '@/components/calendar/EventEditor.vue'
import ResponseButtons from '@/components/calendar/ResponseButtons.vue'
import KeyShortcut from '@/components/KeyShortcut.vue'

const mail = useMailStore()
const compose = useComposeStore()
const router = useRouter()
const triage = useTriage()
const { current, conversation, progress, canUndo, saving, more } = triage
const expanded = ref(new Set<string>())
const root = ref<HTMLElement | null>(null)
const subject = ref<HTMLElement | null>(null)
const doneTitle = ref<HTMLElement | null>(null)

const thread = computed(() => conversation.value?.thread ?? null)
const messages = computed(() => conversation.value?.messages ?? [])
const newest = computed(() => messages.value[messages.value.length - 1] ?? null)
const smartInbox = computed(() => mail.smartInboxes.find((candidate) => candidate.id === thread.value?.smartInboxId) ?? null)
const reason = computed(() => classificationReasonText(thread.value?.classificationReason ?? null))
const percent = computed(() => {
  const value = progress.value
  if (value === null || value.total === 0) {
    return 0
  }
  return Math.round(((thread.value === null ? value.total : value.shown - 1) / value.total) * 100)
})
const announcement = computed(() => {
  const value = progress.value
  if (value === null) {
    return ''
  }
  if (current.value === null) {
    return value.total === 0 ? 'Nothing to triage.' : 'Triage done.'
  }
  if (thread.value === null || newest.value === null) {
    return ''
  }
  return `${value.shown} of ${value.total}: ${thread.value.subject || '(no subject)'}, from ${senderName(newest.value.from)}`
})

// Unread messages and the newest one open, as in the reading pane.
watch(conversation, (shown) => {
  const open = new Set((shown?.messages ?? []).filter((message) => !message.flags.seen).map((message) => message.id))
  const last = shown?.messages[shown.messages.length - 1]
  if (last !== undefined) {
    open.add(last.id)
  }
  expanded.value = open
})

function toggle(messageId: string): void {
  const next = new Set(expanded.value)
  if (!next.delete(messageId)) {
    next.add(messageId)
  }
  expanded.value = next
}

// Focus follows the round: to the next conversation's subject after a decision, to the summary once it is over. Only
// when it was in triage (or nowhere), never out of the compose window or anything else the user went to.
watch(
  () => (progress.value === null ? 'loading' : current.value === null ? 'done' : (thread.value?.id ?? 'next')),
  async () => {
    const before = document.activeElement
    const inTriage = before === null || before === document.body || (root.value?.contains(before) ?? false)
    await nextTick()
    if (inTriage) {
      ;(subject.value ?? doneTitle.value)?.focus()
    }
  },
)

function exit(): void {
  void router.push({ name: 'unified' })
}

const calendar = useCalendarStore()

/** The invitation the conversation carries (its newest calendar message), answerable from triage. */
const invitationMessage = computed(() => [...messages.value].reverse().find((message) => message.calendarMethod !== null) ?? null)
const invitation = ref<MessageInvitation | null>(null)
watch(
  invitationMessage,
  async (message) => {
    invitation.value = null
    if (message === null) {
      return
    }
    try {
      const found = await calendar.invitation(message.id)
      if (invitationMessage.value?.id === message.id) {
        invitation.value = found
      }
    } catch {
      // No invitation the API keeps (a counter proposal, say): triage offers the usual choices only.
    }
  },
  { immediate: true },
)
const answerable = computed(() => {
  const value = invitation.value
  return value !== null && value.canRespond && value.kind !== 'cancelled' && value.kind !== 'reply' && (value.eventId !== null || value.canApply)
})
const answering = ref(false)

/**
 * Answers the invitation and moves on: the email is handled, so it is put away as noted. An update the calendar has
 * not taken yet is applied first, as the invitation card does. Undo brings the email back; the answer stays sent.
 */
async function answer(response: Response): Promise<void> {
  const message = invitationMessage.value
  let value = invitation.value
  if (message === null || value === null || answering.value) {
    return
  }
  answering.value = true
  try {
    if (value.canApply) {
      value = await calendar.applyInvitation(message.id)
    }
    if (value.eventId === null) {
      throw new Error('it is not in your calendar yet')
    }
    await calendar.respondTo(value.eventId, response, value.recurrenceId)
    compose.notify({ text: `${value.summary || 'Invitation'}: ${RESPONSE_WORDS[response]}. Undo brings the email back; the answer stays sent.`, tone: 'info' })
    triage.decide('know')
  } catch (e) {
    compose.notify({ text: `Could not answer the invitation: ${errorMessage(e)}`, tone: 'error' })
  } finally {
    answering.value = false
  }
}

/** "Add to calendar": the editor, filled in from the email; saving it puts the email away as noted. */
const adding = ref<EditorTarget | null>(null)

function eventTitle(subject: string): string {
  return subject.replace(/^\s*((re|fw|fwd|aw|wg)\s*:\s*)+/i, '').replace(/\?+\s*$/, '').trim()
}

function addToCalendar(): void {
  const shown = thread.value
  const last = newest.value
  if (shown === null || last === null) {
    return
  }
  const zone = calendar.zone
  const found = proposedTime(`${shown.subject}\n${last.snippet}`, Date.now(), zone)
  // Without a time in the mail: the next whole hour, to move in the editor.
  const nextHour = Math.ceil((Date.now() + 1) / 3_600_000) * 3_600_000
  const start = found === null ? nextHour : toInstant(found.day + (found.minutes ?? 0) * 60_000, zone)
  const own = new Set(mail.accounts.map((account) => account.emailAddress.toLowerCase()))
  const attendees = own.has(last.from.address.toLowerCase()) ? [] : [{ address: last.from.address, name: last.from.name, role: 'required' as const }]
  adding.value = { kind: 'new', start, allDay: found !== null && found.minutes === null, prefill: { summary: eventTitle(shown.subject), attendees } }
}

function added(): void {
  adding.value = null
  triage.decide('know')
}

function reply(): void {
  if (newest.value !== null) {
    void compose.openReply(newest.value, 'reply')
  }
}

const decisions: { decision: TriageDecision; key: string; label: string; detail: string; icon: TriageDecision }[] = [
  { decision: 'do', key: 'D', label: 'Do it myself', detail: 'Makes a todo', icon: 'do' },
  { decision: 'delegate', key: 'H', label: 'Hand over', detail: 'With a note and due date', icon: 'delegate' },
  { decision: 'know', key: 'K', label: 'Just know', detail: 'Marks read, archives', icon: 'know' },
]

// D, H, K decide, Y, M, N answer an invitation, A adds to the calendar, J skips, R replies, Z undoes, Escape leaves:
// not while typing, writing, or in a menu or dialog.
function shortcut(event: KeyboardEvent): void {
  if (!shortcutAllowed(event, compose.draft !== null && !compose.minimized)) {
    return
  }
  // Only for the email on screen: while the next one still loads, deciding keys wait for it to show.
  const showing = thread.value !== null
  const keys: Record<string, (() => void) | undefined> = {
    d: showing ? () => triage.decide('do') : undefined,
    h: showing ? () => triage.decide('delegate') : undefined,
    k: showing ? () => triage.decide('know') : undefined,
    j: showing ? triage.skip : undefined,
    a: showing ? addToCalendar : undefined,
    y: showing && answerable.value ? () => void answer('accepted') : undefined,
    m: showing && answerable.value ? () => void answer('tentative') : undefined,
    n: showing && answerable.value ? () => void answer('declined') : undefined,
    r: showing ? reply : undefined,
    z: triage.undo,
    escape: exit,
  }
  const run = keys[event.key.toLowerCase()]
  if (run !== undefined) {
    event.preventDefault()
    run()
  }
}
onMounted(() => window.addEventListener('keydown', shortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', shortcut))
</script>

<template>
  <div ref="root" class="triage">
    <header class="top">
      <RouterLink :to="{ name: 'unified' }" class="exit" aria-keyshortcuts="Escape">
        <AppIcon name="back" :size="16" />Exit triage <KeyShortcut keys="Esc" />
      </RouterLink>
      <div v-if="progress && progress.total > 0" class="progress">
        <div class="bar" role="progressbar" aria-label="Triage progress" aria-valuemin="0" :aria-valuemax="progress.total" :aria-valuenow="thread ? progress.shown - 1 : progress.total">
          <div class="fill" :style="{ width: `${percent}%` }"></div>
        </div>
        <span class="position">{{ thread ? `${progress.shown} of ${progress.total}` : `${progress.total} of ${progress.total}` }}</span>
      </div>
      <div v-if="progress" class="counts">
        <span><span class="count do">{{ progress.counts.do }}</span> do</span>
        <span><span class="count delegate">{{ progress.counts.delegate }}</span> handed over</span>
        <span><span class="count know">{{ progress.counts.know }}</span> noted</span>
        <span v-if="saving" class="saving">Saving…</span>
      </div>
    </header>

    <p class="visually-hidden" role="status">{{ announcement }}</p>

    <main class="stage">
      <p v-if="!progress" class="state">Loading your mail…</p>

      <section v-else-if="current === null" class="state done" aria-labelledby="triage-done">
        <h1 id="triage-done" ref="doneTitle" tabindex="-1">{{ progress.total === 0 ? 'Nothing to triage' : more ? 'Round done' : 'All triaged' }}</h1>
        <p v-if="progress.total === 0">Every email in your inboxes already has a place.</p>
        <p v-else>
          {{ progress.counts.do }} to do, {{ progress.counts.delegate }} handed over, {{ progress.counts.know }} noted.
          <template v-if="more"> More mail waits for the next round.</template>
        </p>
        <div class="done-actions">
          <button v-if="more" type="button" class="button button-primary" @click="triage.nextRound()">Start the next round</button>
          <RouterLink :to="{ name: 'unified' }" class="button" :class="more ? 'button-quiet' : 'button-primary'">Back to the inbox</RouterLink>
          <button v-if="canUndo" type="button" class="button button-quiet" aria-keyshortcuts="Z" @click="triage.undo()">Undo the last one <KeyShortcut keys="Z" /></button>
        </div>
      </section>

      <p v-else-if="!thread || !newest" class="state">Loading the next email…</p>

      <div v-else class="column">
        <article class="card" aria-labelledby="triage-subject">
          <div class="who">
            <SenderAvatar :sender="newest.from" :size="40" />
            <span class="from">
              <span class="name">{{ senderName(newest.from) }} <span class="address">{{ newest.from.address }}</span></span>
              <span class="when">{{ fullTime(newest.receivedAt) }}</span>
            </span>
            <span v-if="smartInbox" class="smart-inbox">{{ smartInbox.name }}</span>
          </div>
          <h1 id="triage-subject" ref="subject" class="subject" tabindex="-1">{{ thread.subject || '(no subject)' }}</h1>
          <p v-if="reason" class="reason">{{ reason }}</p>
          <MessageCard v-for="message in messages" :key="message.id" :message="message" :expanded="expanded.has(message.id)" @toggle="toggle(message.id)" />
        </article>

        <section v-if="answerable && invitation" class="answer" aria-labelledby="triage-answer">
          <span id="triage-answer" class="answer-label"><AppIcon name="calendar" :size="18" />Answer {{ invitation.summary || 'the invitation' }}</span>
          <ResponseButtons :current="invitation.selfResponse" :busy="answering" shortcuts :label="`Answer ${invitation.summary}`" @respond="answer" />
        </section>

        <div class="decisions" role="group" aria-label="Decide">
          <button
            v-for="item in decisions"
            :key="item.decision"
            type="button"
            class="decision"
            :class="item.decision"
            :aria-keyshortcuts="item.key"
            @click="triage.decide(item.decision)"
          >
            <span class="decision-label"><AppIcon :name="item.icon" :size="22" />{{ item.label }}</span>
            <span class="decision-detail">{{ item.detail }} <KeyShortcut :keys="item.key" /></span>
          </button>
        </div>

        <div class="more" role="group" aria-label="More">
          <button type="button" class="hint" aria-keyshortcuts="J" @click="triage.skip()">Skip <KeyShortcut keys="J" /></button>
          <button type="button" class="hint" aria-keyshortcuts="R" @click="reply">Reply <KeyShortcut keys="R" /></button>
          <button type="button" class="hint" aria-keyshortcuts="A" @click="addToCalendar"><AppIcon name="calendar" :size="14" />Add to calendar <KeyShortcut keys="A" /></button>
          <button type="button" class="hint" :disabled="!canUndo" aria-keyshortcuts="Z" @click="triage.undo()">Undo <KeyShortcut keys="Z" /></button>
        </div>
      </div>
    </main>
    <EventEditor v-if="adding" :target="adding" @close="adding = null" @saved="added" />
  </div>
</template>

<style scoped>
.triage {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--ground);
}
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 20px 32px;
}
.exit {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-control);
  color: var(--ink-2);
  font-weight: 600;
  text-decoration: none;
}
.exit:hover {
  background: var(--surface);
  color: var(--ink);
}
.progress {
  flex: 1 1 320px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--ink);
  transition: width 200ms ease-out;
}
.position {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
  white-space: nowrap;
}
.counts {
  display: flex;
  gap: 12px;
  font-size: 13px;
  color: var(--ink-2);
}
.count {
  font-weight: 600;
}
.count.do {
  color: var(--do);
}
.count.delegate {
  color: var(--delegate);
}
.count.know {
  color: var(--know);
}
.saving {
  color: var(--ink-3);
}
.subject:focus,
.done h1:focus {
  outline: none;
}
.subject:focus-visible,
.done h1:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 4px;
}
.stage {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: 8px 24px 40px;
}
.column {
  width: 100%;
  max-width: 760px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 32px 40px;
  border-radius: var(--radius-panel);
  background: var(--surface);
  box-shadow: var(--raised);
}
.who {
  display: flex;
  align-items: center;
  gap: 12px;
}
.from {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.name {
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.address {
  font-weight: 400;
  color: var(--ink-2);
}
.when {
  font-size: 13px;
  color: var(--ink-2);
}
.smart-inbox {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.subject {
  margin: 0;
  font-family: var(--font-display);
  font-size: 28px;
  line-height: 34px;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.reason {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
}
.answer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
  animation: fade-in var(--motion-base) ease-out;
}
.answer-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.decisions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.decision {
  min-height: 88px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1.5px solid currentColor;
  border-radius: var(--radius-panel);
  background: var(--surface);
  font: 600 17px var(--font-ui);
  cursor: pointer;
}
.decision.do {
  color: var(--do);
}
.decision.delegate {
  color: var(--delegate);
}
.decision.know {
  color: var(--know);
}
.decision:hover:not(:disabled) {
  background: var(--do-soft);
}
.decision.delegate:hover:not(:disabled) {
  background: var(--delegate-soft);
}
.decision.know:hover:not(:disabled) {
  background: var(--know-soft);
}
.decision:focus-visible,
.hint:focus-visible,
.exit:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.decision:disabled,
.hint:disabled {
  opacity: 0.5;
  cursor: default;
}
.decision-label {
  display: flex;
  align-items: center;
  gap: 10px;
}
.decision-detail {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-2);
}
.more {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px 20px;
}
.hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  padding: 4px 6px;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  font: 400 13px var(--font-ui);
  cursor: pointer;
}
.hint:hover:not(:disabled) {
  color: var(--ink);
}
.state {
  align-self: center;
  max-width: 520px;
  text-align: center;
  color: var(--ink-2);
}
.done h1 {
  margin: 0 0 8px;
  font-family: var(--font-display);
  font-size: 28px;
  color: var(--ink);
}
.done-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
}

@media (max-width: 760px) {
  .top {
    padding: 12px 16px;
  }
  .stage {
    padding: 8px 16px 24px;
  }
  .card {
    padding: 20px;
  }
  .decisions {
    grid-template-columns: minmax(0, 1fr);
  }
  .decision {
    min-height: 64px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fill {
    transition: none;
  }
}
</style>
