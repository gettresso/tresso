<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  addedByText,
  canJoin,
  conferenceLabel,
  CREATING_HINT,
  displayLink,
  failureHint,
  linkText,
  MEETING_PENDING_MS,
  requestState,
  requestTitle,
  type ConferenceRequest,
  type SyncedCalendarEvent,
} from '@tresso/core'
import AppIcon from '@/components/AppIcon.vue'
import CopyLinkButton from '@/components/calendar/CopyLinkButton.vue'
import JoinLink from '@/components/calendar/JoinLink.vue'

/**
 * The meeting link of an event in the popover (the EventPopoverMeetingLink board): the app and the link cut in the
 * middle, Join (Shift J) and Copy link, the dial-in number, who added the link on an event someone else organizes,
 * and a link that was asked for: "Making the Teams link" while the provider makes it, and on an event the user
 * organizes the red "Could not make the Teams link" once it failed or took longer than two minutes. Retrying and
 * leaving without a link belong to the editor's row. Renders nothing for an event without a link or a request.
 */
const props = defineProps<{
  event: SyncedCalendarEvent
  /**
   * The link asked for on the series: the master row carries it, also when `event` is an occurrence that was moved
   * (an override row, whose own `conferenceRequest` is always null).
   */
  request: ConferenceRequest | null
  /** The user's saved own link, which reads "My own link"; null until the settings know it. */
  ownLink: string | null
  /** The server's time as the client knows it, in epoch ms: `requestedAt` is the server's. */
  clock: () => number
}>()

const conference = computed(() => props.event.conference)
const joinable = computed(() => conference.value !== null && canJoin(conference.value))
const organizes = computed(() => props.event.selfResponse === null)

const addedBy = computed(() => {
  const organizer = props.event.organizer
  if (conference.value === null || organizes.value || organizer === null) {
    return null
  }
  return addedByText(conference.value, props.ownLink, organizer.name?.trim() || organizer.address)
})

/**
 * The time the request's state is read at. Taken again when the event changes, and once more when a pending request
 * turns two minutes old, so "Making" becomes "Could not make" on screen without anything else changing.
 */
const now = ref(props.clock())
let timer: ReturnType<typeof setTimeout> | null = null

const request = computed(() => props.request)
const state = computed(() => requestState({ conference: props.event.conference, conferenceRequest: request.value }, now.value))

function stopTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function watchAge(): void {
  stopTimer()
  now.value = props.clock()
  const pending = request.value
  if (pending === null || state.value !== 'creating') {
    return
  }
  // At most two minutes ahead: a requestedAt far in the future (a clock that is off) would overflow setTimeout, which
  // then fires at once and again and again.
  const left = Date.parse(pending.requestedAt) + MEETING_PENDING_MS - now.value
  timer = setTimeout(watchAge, Math.min(Math.max(0, left), MEETING_PENDING_MS) + 250)
}

watch(() => [props.event.conference, props.request], watchAge, { immediate: true })
onBeforeUnmount(stopTimer)
</script>

<template>
  <div v-if="conference" class="meeting">
    <div class="head">
      <AppIcon :name="joinable ? 'video' : 'link'" :size="18" />
      <span class="names">
        <span class="app">{{ conferenceLabel(conference, ownLink) }}</span>
        <span class="url" dir="ltr" :title="displayLink(conference.url)">{{ linkText(conference.url) }}</span>
      </span>
    </div>
    <div class="actions">
      <JoinLink v-if="joinable" class="join" :conference="conference" variant="primary" short :fallback="false" />
      <CopyLinkButton :url="conference.url" />
    </div>
    <p v-if="!joinable" class="note">Tresso does not open this link. Check where it leads before you use it.</p>
  </div>
  <p v-if="conference?.dialIn" class="hint">Dial in: {{ conference.dialIn }}</p>
  <p v-if="addedBy" class="hint">{{ addedBy }}</p>
  <div v-if="request" class="request" role="status">
    <p v-if="state === 'creating'" class="creating">
      <svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" class="track" />
        <path d="M12 3a9 9 0 019 9" class="arc" />
      </svg>
      <span class="text">
        <span class="title">{{ requestTitle(request, now) }}</span>{{ ' ' }}<span class="sub">{{ CREATING_HINT }}</span>
      </span>
    </p>
    <p v-else-if="state === 'failed' && organizes" class="failed">
      <AppIcon name="error" :size="18" />
      <span class="text">
        <span class="title">{{ requestTitle(request, now) }}</span>{{ ' ' }}<span class="sub">{{ failureHint(request, now) }}</span>
      </span>
    </p>
  </div>
</template>

<style scoped>
p {
  margin: 0;
}
.meeting {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
  background: var(--ground);
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ink);
}
.head svg {
  flex: none;
}
.names {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.app {
  font-size: 13px;
  font-weight: 600;
}
.url {
  unicode-bidi: isolate;
  overflow: hidden;
  color: var(--ink-2);
  font: 400 12px var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.join {
  flex: 1;
}
.note,
.hint {
  color: var(--ink-2);
  font-size: 13px;
}
.creating,
.failed {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
}
.creating {
  color: var(--ink);
}
.failed {
  padding: 12px;
  border-radius: 10px;
  background: var(--danger-soft);
  color: var(--danger);
}
.failed svg,
.spinner {
  flex: none;
}
.text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.title {
  font-weight: 600;
}
.creating .sub {
  color: var(--ink-2);
}
.spinner {
  animation: meeting-spin 0.9s linear infinite;
}
.track {
  stroke: var(--line-strong);
}
.arc {
  stroke: currentcolor;
}
@keyframes meeting-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2.4s;
  }
}
</style>
