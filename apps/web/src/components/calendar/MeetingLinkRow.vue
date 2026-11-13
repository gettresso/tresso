<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { displayLink, linkText, TEAMS_MEETING_KEPT, type Conference, type MeetingApp, type MeetingChoice, type MeetingDefault, type MeetingRow } from '@tresso/core'
import AppIcon from '@/components/AppIcon.vue'
import CopyLinkButton from '@/components/calendar/CopyLinkButton.vue'
import JoinLink from '@/components/calendar/JoinLink.vue'

/**
 * The "Meeting link" row of the event editor (build plan 5.2, the EventMeetingLink and MeetingLinkStates boards): the
 * state core's meetingRow names, with the app button and its menu, the switch, the link with Copy link and Join, and
 * the buttons of the states that need one. It only shows and reports: the editor decides what each choice does.
 */
const props = defineProps<{
  row: MeetingRow
  choices: MeetingChoice[]
  chosen: MeetingChoice | null
  defaultApp: MeetingDefault | null
  calendarName: string
  on: boolean
  /** The link the event has, or the own link the row will add; null when there is none yet. */
  link: Pick<Conference, 'provider' | 'url'> | null
  /** A Teams meeting Microsoft keeps on its event: no other app, no removal, the switch fixed. */
  locked: boolean
  /** The event has a link that "Remove meeting link" takes off when saved. */
  removable: boolean
  /** Retry or Leave without a link is on its way, or the preferences are still being read. */
  busy: boolean
  /** An error of Retry or Leave without a link. */
  error: string | null
}>()
const emit = defineEmits<{
  toggle: []
  pick: [app: MeetingApp]
  remove: []
  undo: []
  retry: []
  leave: []
  reconnect: []
  settings: []
}>()

const id = useId()
const titleId = `${id}-title`
const hintId = `${id}-hint`
const keptId = `${id}-kept`

const firstOk = computed(() => props.choices.find((choice) => choice.ok) ?? null)
const own = computed(() => props.choices.find((choice) => choice.app === 'own' && choice.ok) ?? null)
const showsApp = computed(() => ['ready', 'own', 'created'].includes(props.row.kind))
const showsSwitch = computed(() => ['off', 'no_app', 'ready', 'own', 'created', 'removed'].includes(props.row.kind))
const showsLink = computed(() => (props.row.kind === 'own' || props.row.kind === 'created') && props.link !== null)

// The app menu: opened by the app button, or by "Use another app".
const open = ref(false)
const menu = ref<HTMLElement | null>(null)
const root = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null

async function openMenu(event: Event): Promise<void> {
  opener = event.currentTarget as HTMLElement
  open.value = true
  await nextTick()
  const items = menuItems()
  ;(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
}

function closeMenu(returnFocus = true): void {
  open.value = false
  if (returnFocus) opener?.focus()
}

function menuItems(): HTMLElement[] {
  return [...(menu.value?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])]
}

function onMenuKey(event: KeyboardEvent): void {
  const items = menuItems()
  const index = items.indexOf(document.activeElement as HTMLElement)
  const focus = (next: number) => items[(next + items.length) % items.length]?.focus()
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      focus(index + 1)
      break
    case 'ArrowUp':
      event.preventDefault()
      focus(index - 1)
      break
    case 'Home':
      event.preventDefault()
      focus(0)
      break
    case 'End':
      event.preventDefault()
      focus(items.length - 1)
      break
    case 'Escape':
      // Closes the menu only, not the editor around it.
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      break
    case 'Tab':
      closeMenu(false)
      break
  }
}

function choose(choice: MeetingChoice): void {
  if (!choice.ok || props.locked) return
  closeMenu()
  refocusAfter()
  emit('pick', choice.app)
}

/**
 * A button that changes the row's state goes away with it (Retry, Leave without a link, Use ..., Undo, a pick from
 * "Use another app"): the focus then moves to the row's first control, or to the row itself, never to the page.
 */
let refocus = false
function refocusAfter(): void {
  refocus = true
}
function act<T extends unknown[]>(event: (...args: T) => void, ...args: T): void {
  refocusAfter()
  event(...args)
}
watch(
  () => [props.row.kind, props.row.title, props.busy, props.on],
  async () => {
    if (!refocus || props.busy) return
    await nextTick()
    refocus = false
    const active = document.activeElement
    if (root.value === null || (active !== null && active !== document.body && root.value.contains(active) && (active as HTMLButtonElement).disabled !== true)) return
    const target = root.value.querySelector<HTMLElement>('button:not(:disabled), a[href], [role="switch"]:not(:disabled)') ?? root.value
    target.focus()
  },
)

function removeLink(): void {
  if (props.locked || !(props.on || props.removable)) return
  closeMenu()
  emit('remove')
}

function toSettings(): void {
  closeMenu(false)
  emit('settings')
}

// A click outside closes the menu (the capture phase, as the other menus do).
function outside(event: MouseEvent): void {
  const target = event.target as Node | null
  if (open.value && target !== null && !root.value?.contains(target)) {
    open.value = false
  }
}
onMounted(() => document.addEventListener('mousedown', outside, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', outside, true))
</script>

<template>
  <div ref="root" class="meeting-row" :class="row.tone" role="group" tabindex="-1" :aria-labelledby="titleId">
    <div class="top">
      <span class="icon" aria-hidden="true">
        <svg v-if="row.icon === 'spinner'" class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round">
          <circle cx="12" cy="12" r="9" class="track" />
          <path d="M12 3a9 9 0 019 9" class="arc" />
        </svg>
        <AppIcon v-else-if="row.icon === 'warn'" name="alert" :size="18" />
        <AppIcon v-else-if="row.icon === 'error'" name="error" :size="18" />
        <AppIcon v-else name="video" :size="18" />
      </span>
      <span class="text" aria-live="polite">
        <span :id="titleId" class="title">{{ row.title }}</span>{{ ' ' }}<span :id="hintId" class="hint">{{ row.hint }}</span>
      </span>
      <button
        v-if="showsApp"
        type="button"
        class="button app"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-label="`Meeting app: ${chosen?.label ?? 'Meeting link'}`"
        :disabled="busy"
        @click="open ? closeMenu() : openMenu($event)"
      >
        {{ chosen?.label ?? 'Meeting link' }} <AppIcon name="chevron" :size="14" />
      </button>
      <button
        v-if="showsSwitch"
        type="button"
        role="switch"
        class="switch"
        :aria-checked="on && row.kind !== 'no_app'"
        :aria-labelledby="titleId"
        :aria-describedby="hintId"
        :disabled="busy || locked"
        @click="emit('toggle')"
      >
        <span class="knob" />
      </button>
    </div>

    <div v-if="showsLink && link" class="link-line">
      <span class="link" dir="ltr" :title="displayLink(link.url)">{{ linkText(link.url) }}</span>
      <CopyLinkButton :url="link.url" compact />
      <JoinLink :conference="link" compact :fallback="false" />
    </div>

    <div v-if="row.kind === 'no_app'" class="actions">
      <button type="button" class="button button-primary" @click="emit('settings')">Connect a meeting app</button>
    </div>
    <div v-else-if="row.kind === 'failed'" class="actions">
      <button type="button" class="button button-primary" :disabled="busy" @click="act(() => emit('retry'))">Retry</button>
      <button type="button" class="button" aria-haspopup="menu" :aria-expanded="open" :disabled="busy" @click="openMenu($event)">Use another app</button>
      <button type="button" class="button button-quiet" :disabled="busy" @click="act(() => emit('leave'))">Leave without a link</button>
    </div>
    <div v-else-if="row.kind === 'reconnect'" class="actions">
      <button type="button" class="button button-primary" @click="emit('reconnect')">Reconnect</button>
      <button type="button" class="button" aria-haspopup="menu" :aria-expanded="open" @click="openMenu($event)">Use another app</button>
    </div>
    <div v-else-if="row.kind === 'wrong_calendar'" class="actions">
      <button v-if="firstOk" type="button" class="button button-primary" @click="act((app: MeetingApp) => emit('pick', app), firstOk.app)">Use {{ firstOk.label }}</button>
      <button v-if="own && own.app !== firstOk?.app" type="button" class="button" @click="act(() => emit('pick', 'own'))">Use my own link</button>
    </div>
    <div v-else-if="row.kind === 'wrong_account'" class="actions">
      <button v-if="own" type="button" class="button button-primary" @click="act(() => emit('pick', 'own'))">Use my own link</button>
      <button type="button" class="button" @click="emit('settings')">Connect another app</button>
    </div>
    <div v-else-if="row.kind === 'removed'" class="actions">
      <button type="button" class="button button-quiet" @click="act(() => emit('undo'))">Undo</button>
    </div>
    <p v-if="error" class="row-error" role="alert">{{ error }}</p>

    <div v-if="open" ref="menu" class="menu" role="menu" aria-label="Meeting app" @keydown="onMenuKey">
      <p class="heading" aria-hidden="true">Make the link with</p>
      <p v-if="locked" :id="keptId" class="kept">{{ TEAMS_MEETING_KEPT }}</p>
      <button
        v-for="choice in choices"
        :key="choice.app"
        type="button"
        role="menuitemradio"
        tabindex="-1"
        class="item"
        :aria-checked="chosen?.app === choice.app && on"
        :aria-disabled="!choice.ok || locked ? 'true' : undefined"
        :aria-describedby="locked ? keptId : undefined"
        @click="choose(choice)"
      >
        <span class="mark" aria-hidden="true"><AppIcon v-if="chosen?.app === choice.app && on" name="check" :size="14" /></span>
        <span class="names">
          <span class="label">{{ choice.label }}<span v-if="choice.app === defaultApp" class="pill">Default for {{ calendarName }}</span></span>
          <span class="via">{{ choice.via }}</span>
        </span>
      </button>
      <hr aria-hidden="true" />
      <button type="button" role="menuitem" tabindex="-1" class="item danger" :aria-disabled="locked || !(on || removable) ? 'true' : undefined" :aria-describedby="locked ? keptId : undefined" @click="removeLink">Remove meeting link</button>
      <button type="button" role="menuitem" tabindex="-1" class="item" @click="toSettings">Connect another app in Settings</button>
    </div>
  </div>
</template>

<style scoped>
.meeting-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.meeting-row.warn {
  border-color: transparent;
  background: var(--delegate-soft);
}
.meeting-row.error {
  border-color: transparent;
  background: var(--danger-soft);
}
.top {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.icon {
  flex: none;
  margin-top: 1px;
  color: var(--ink);
}
.warn .icon {
  color: var(--delegate);
}
.error .icon,
.error .title,
.error .hint {
  color: var(--danger);
}
.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 13px;
}
.title {
  font-weight: 600;
}
.hint {
  color: var(--ink-2);
}
.app {
  flex: none;
  gap: 6px;
  height: 32px;
  padding: 0 8px 0 10px;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}
.switch {
  flex: none;
  display: flex;
  width: 40px;
  height: 24px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--line-strong);
  cursor: pointer;
}
.switch[aria-checked='true'] {
  justify-content: flex-end;
  background: var(--do);
}
.switch:disabled {
  opacity: 0.55;
  cursor: default;
}
.knob {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--paper);
  box-shadow: 0 1px 2px rgb(22 24 29 / 20%);
}
.link-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.link {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--ground);
  font: 400 13px/28px var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
  unicode-bidi: isolate;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.row-error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
.menu {
  position: absolute;
  top: 52px;
  right: 12px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  width: min(340px, calc(100% - 24px));
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--paper);
  box-shadow: var(--raised);
}
.heading {
  margin: 6px 10px 4px;
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.kept {
  margin: 0 10px 6px;
  color: var(--ink-2);
  font-size: 12px;
}
.item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.item:hover:not([aria-disabled='true']),
.item:focus {
  background: var(--selected);
}
.item[aria-disabled='true'] {
  color: var(--ink-3);
  cursor: default;
}
.item.danger:not([aria-disabled='true']) {
  color: var(--danger);
}
.mark {
  flex: none;
  width: 14px;
}
.names {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.pill {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font-size: 11px;
  font-weight: 500;
}
.via {
  color: var(--ink-2);
  font-size: 12px;
}
.item[aria-disabled='true'] .via {
  color: var(--ink-3);
}
hr {
  width: 100%;
  margin: 4px 0;
  border: 0;
  border-top: 1px solid var(--line);
}
.spinner {
  animation: meeting-row-spin 0.9s linear infinite;
}
.track {
  stroke: var(--line-strong);
}
.arc {
  stroke: currentcolor;
}
@keyframes meeting-row-spin {
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
