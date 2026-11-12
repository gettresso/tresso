<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import { useBatchesStore } from '@/stores/batches'
import { useMailStore } from '@/stores/mail'
import MailboxSidebar from '@/components/MailboxSidebar.vue'
import { sidebarPage } from '@/components/sidebarPage'
import SignInView from '@/views/SignInView.vue'
import UnsavedDraftsDialog from '@/components/UnsavedDraftsDialog.vue'
import { useSignOut } from '@/components/signOut'
import { reducedMotion } from '@/components/calendar/genie'
import AppIcon from '@/components/AppIcon.vue'
import { FRAME_STRIP, resizeCursor, useSidebarActive, widthForKey } from '@/components/frame'
import { framed, frameToken, SIDEBAR_MAX, SIDEBAR_MIN } from '@/platform/frame'
import { startGlassReporter, type GlassReporter } from '@/platform/glass'
import { vibrant } from '@/platform/vibrancy'
import { useFrameStore } from '@/stores/frame'

const auth = useAuthStore()
const mail = useMailStore()
const batches = useBatchesStore()
const route = useRoute()
const compose = useComposeStore()

/**
 * Signs out; the sidebar's button says it is under way (auth.signingOut), and a failure is said too. Drafts that never
 * reached the server are asked about first (UnsavedDraftsDialog).
 */
const signOut = useSignOut((text) => compose.notify({ text, tone: 'error' }))

const page = computed(() => sidebarPage(route))
const inBatches = computed(() => route.name === 'batches' || route.name === 'batches-thread')

// The sidebar says when the next batch comes, on every screen. Loading again is free once the schedule is known, so
// each new screen also retries a load that failed before (say while offline).
watch(
  [() => auth.isAuthenticated, () => route.fullPath],
  ([authenticated]) => authenticated && void batches.load(),
  { immediate: true },
)

// On a phone the mailboxes fold away above the screen; going somewhere folds them again.
const narrow = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 760px)') : null
const mailboxesOpen = ref(narrow === null || !narrow.matches)
const mailboxes = ref<HTMLDetailsElement | null>(null)

/** Where the fold is heading; a second tap while it moves turns it around. */
const folding = ref<{ open: boolean; animation: Animation } | null>(null)

/** Folds the mailboxes open or shut on a phone, with their height (and padding) easing instead of the screen jumping. */
async function fold(open: boolean): Promise<void> {
  const list = mailboxes.value?.querySelector<HTMLElement>('nav')
  // Turning around mid-fold starts from where the list is now, not from a full end.
  const from = folding.value === null || list === null || list === undefined ? null : { height: `${list.offsetHeight}px`, opacity: Number(getComputedStyle(list).opacity) }
  folding.value?.animation.cancel()
  folding.value = null
  if (list === null || list === undefined || typeof list.animate !== 'function' || reducedMotion() || !narrow?.matches) {
    mailboxesOpen.value = open
    return
  }
  mailboxesOpen.value = true
  await nextTick()
  const style = getComputedStyle(list)
  const shown = { height: `${list.offsetHeight}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, opacity: 1 }
  const hidden = { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 }
  list.style.overflow = 'hidden'
  const start = from === null ? (open ? hidden : shown) : { ...(open ? hidden : shown), ...from }
  const animation = list.animate([start, open ? shown : hidden], { duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
  folding.value = { open, animation }
  animation.onfinish = () => {
    list.style.overflow = ''
    folding.value = null
    mailboxesOpen.value = open
  }
}

function summaryClick(event: MouseEvent): void {
  if (narrow?.matches && !framed) {
    event.preventDefault()
    void fold(!(folding.value?.open ?? mailboxesOpen.value))
  }
}

watch(
  () => route.fullPath,
  () => {
    // The desktop frame never folds its sidebar, also in a window zoomed to a phone's width.
    if (narrow?.matches && mailboxesOpen.value && !framed) {
      void fold(false)
    }
  },
)
function widthChanged(query: MediaQueryListEvent): void {
  mailboxesOpen.value = !query.matches
}
narrow?.addEventListener('change', widthChanged)
onBeforeUnmount(() => narrow?.removeEventListener('change', widthChanged))

function toggled(event: Event): void {
  mailboxesOpen.value = (event.target as HTMLDetailsElement).open
}

/*
 * The desktop window frame (assets/frame.css, platform/frame.ts): the sidebar as a card in a column the user can widen,
 * narrow and hide, and a title strip over the screens that holds their title and toolbar. The browser keeps the layout
 * above, untouched: every binding below is empty there.
 */
const frame = useFrameStore()
const inFrame = computed(() => framed && auth.isAuthenticated)
provide(FRAME_STRIP, framed)
const sidebarActive = useSidebarActive(mailboxes)
/** While the edge is dragged the column follows the pointer at once, without the slide. */
const resizing = ref<{ pointer: number; from: number } | null>(null)

const shellClasses = computed(() => (framed ? { 'frame-shell': true, collapsed: !frame.shown, resizing: resizing.value !== null } : undefined))
const shellStyle = computed(() => (framed ? { '--frame-sidebar-width': `${frame.width}px`, '--frame-column': frame.shown ? `${frame.width}px` : '0px' } : undefined))
const sidebarAttrs = computed(() => (framed ? { id: 'frame-sidebar', class: { active: sidebarActive.value }, inert: frame.shown ? undefined : true } : {}))

// The page starts at the window's top edge while the frame shows (assets/frame.css); the sign-in screen keeps the
// window's own title area.
watchEffect(() => document.documentElement.classList.toggle('frame-shell', inFrame.value))
onBeforeUnmount(() => document.documentElement.classList.remove('frame-shell'))

/*
 * Liquid Glass behind the card (macOS 26 and later, platform/glass.ts): the card's place goes to the shell at once, when
 * the window or the card changes size, and every frame while the card slides or its edge is dragged. A hidden card,
 * the sign-in screen and "Reduce transparency" have none; the card is then drawn solid as before.
 */
const SLIDE_MS = frameToken('frame-sidebar-motion', 220, 'ms')
let glass: GlassReporter | null = null
/** Until when the card is followed while it slides out, before its glass goes. */
let slidingUntil = 0

function glassCard(): HTMLElement | null {
  const visible = frame.shown || performance.now() < slidingUntil
  if (!auth.isAuthenticated || !visible || document.documentElement.classList.contains('reduce-transparency')) {
    return null
  }
  return mailboxes.value?.querySelector<HTMLElement>('nav') ?? null
}

onMounted(() => {
  if (!vibrant) {
    return
  }
  const reporter = startGlassReporter({
    card: glassCard,
    radius: frameToken('frame-card-radius', 18),
    // The card drops its own fill only once the shell has put the glass behind it.
    onPlaced: (placed) => document.documentElement.classList.toggle('liquid-glass', placed),
  })
  glass = reporter
  // "Reduce transparency" turned on or off (platform/vibrancy.ts sets the class).
  const classes = new MutationObserver(() => reporter.report())
  classes.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => reporter.report()) : null
  const stopObserving = watch(
    mailboxes,
    (column) => {
      sizes?.disconnect()
      if (column !== null) {
        sizes?.observe(column)
      }
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    classes.disconnect()
    sizes?.disconnect()
    stopObserving()
    reporter.stop()
    glass = null
  })
})

/** The toggle: where the focus goes when the sidebar it was in is hidden. */
const toggle = ref<HTMLButtonElement | null>(null)

watch(
  () => frame.shown,
  (shown) => {
    // Hidden by the toggle, the menu or ⌃⌘S: the sidebar turns inert and its edge goes, so focus in either moves to the
    // toggle instead of falling to the page.
    const focused = document.activeElement
    if (!shown && focused !== null && (mailboxes.value?.contains(focused) || focused.closest('.frame-resize') !== null)) {
      toggle.value?.focus()
    }
    slidingUntil = performance.now() + SLIDE_MS + 50
    glass?.follow(SLIDE_MS + 50)
  },
)
// Signed in or out: the card comes or goes once the page shows it.
watch(
  () => auth.isAuthenticated,
  () => void nextTick(() => glass?.report()),
)

function resizeStart(event: PointerEvent): void {
  if (event.button !== 0) {
    return
  }
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  resizing.value = { pointer: event.clientX, from: frame.width }
  glass?.startFollowing()
}

function resizeMove(event: PointerEvent): void {
  if (resizing.value !== null) {
    frame.setWidth(resizing.value.from + event.clientX - resizing.value.pointer, false)
  }
}

function resizeEnd(): void {
  if (resizing.value !== null) {
    resizing.value = null
    frame.keep()
    glass?.stopFollowing()
  }
}

function resizeKey(event: KeyboardEvent): void {
  const width = widthForKey(frame.width, event.key)
  if (width !== null) {
    event.preventDefault()
    frame.setWidth(width)
  }
}
</script>

<template>
  <div v-if="auth.isAuthenticated" class="app" :class="shellClasses" :style="shellStyle">
    <!-- macOS: the strip above the sidebar moves the window, as the title bar it replaces did. -->
    <div v-if="framed && vibrant" class="frame-sidebar-drag" data-tauri-drag-region aria-hidden="true" />
    <button
      v-if="framed"
      type="button"
      class="frame-toggle"
      data-frame-neutral
      aria-controls="frame-sidebar"
      ref="toggle"
      :aria-expanded="frame.shown ? 'true' : 'false'"
      aria-label="Sidebar"
      :title="vibrant ? 'Show or hide the sidebar (⌃⌘S)' : 'Show or hide the sidebar'"
      @click="frame.toggle()"
    >
      <AppIcon name="sidebar" :size="24" />
    </button>
    <details ref="mailboxes" class="mailboxes" :open="mailboxesOpen || framed" @toggle="toggled">
      <summary class="mailboxes-toggle" @click="summaryClick">Mailboxes</summary>
      <MailboxSidebar
        v-bind="sidebarAttrs"
        :display-name="auth.me?.displayName ?? ''"
        :email="auth.me?.email ?? ''"
        :accounts="mail.accounts"
        :unread-counts="mail.unreadCounts"
        :mailbox="mail.mailbox"
        :smart-inboxes="mail.smartInboxes"
        :smart-inbox-counts="mail.smartInboxCounts"
        :smart-inbox="mail.smartInbox"
        :batches="inBatches"
        :next-batch="batches.nextBatchLabel"
        :page="page"
        @sign-out="signOut.request"
      />
    </details>
    <!-- The card's right edge: drag it, or use the arrow keys, Home and End, to set the sidebar's width. -->
    <div
      v-if="framed && frame.shown"
      class="frame-resize"
      data-frame-neutral
      role="separator"
      tabindex="0"
      aria-label="Sidebar width"
      aria-controls="frame-sidebar"
      aria-orientation="vertical"
      :aria-valuemin="SIDEBAR_MIN"
      :aria-valuemax="SIDEBAR_MAX"
      :aria-valuenow="frame.width"
      :aria-valuetext="`${frame.width} pixels`"
      :style="{ cursor: resizeCursor(frame.width) }"
      @pointerdown="resizeStart"
      @pointermove="resizeMove"
      @pointerup="resizeEnd"
      @pointercancel="resizeEnd"
      @lostpointercapture="resizeEnd"
      @keydown="resizeKey"
    />
    <div class="stage">
      <!--
        The title strip: the screen's title (FrameTitle) and toolbar (FrameTools) go here. It moves the window on macOS
        (and zooms it on a double click), except where a control is.
      -->
      <div v-if="framed" class="frame-strip" :data-tauri-drag-region="vibrant ? 'deep' : undefined">
        <div id="frame-title" class="frame-title" />
        <div id="frame-tools" class="frame-tools" />
      </div>
      <RouterView />
    </div>
    <UnsavedDraftsDialog
      v-if="signOut.question.value !== null"
      :count="signOut.question.value.count"
      :check-error="signOut.question.value.checkError"
      :saving="signOut.saving.value"
      :failed="signOut.saveFailed.value"
      @save="signOut.saveFirst"
      @sign-out="signOut.signOutAnyway"
      @cancel="signOut.cancel"
    />
  </div>
  <SignInView v-else />
</template>

<style scoped>
.app {
  display: grid;
  grid-template-columns: minmax(220px, 272px) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.mailboxes {
  display: contents;
}
.mailboxes-toggle {
  display: none;
}
/* The sidebar is a pane of glass over the canvas; in the macOS app the window's own vibrancy shows through instead. */
.mailboxes > :deep(nav) {
  /*
   * The details element keeps its own content box even with display: contents, so that box is the grid item and
   * the nav inside it would stop where its links end. Filling it keeps the glass down to the bottom of the window.
   */
  height: 100%;
  min-height: 0;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
  -webkit-backdrop-filter: var(--glass-material);
  backdrop-filter: var(--glass-material);
  box-shadow: inset -1px 0 0 var(--line);
}
.stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.stage > :deep(*) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /*
   * A new screen fades in while the sidebar stays put. Moving within one screen, say between conversations, keeps it.
   * Only opacity: a transform here would pin a screen's fixed panels to the screen instead of the window.
   */
  animation: screen-in var(--motion-base) var(--ease-out);
}

/*
 * The desktop window frame (assets/frame.css has every number). Each rule needs .frame-shell, which only the desktop
 * app sets: the column (inset, card, gap), the card, the toggle, the drag handle and the title strip.
 */
.app.frame-shell {
  position: relative;
  grid-template-columns: var(--frame-column) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  transition: grid-template-columns var(--frame-sidebar-motion) var(--ease-out);
}
.app.frame-shell.resizing {
  transition: none;
  user-select: none;
}
.frame-shell .mailboxes {
  display: block;
  position: relative;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  border: 0;
  background: var(--frame-window-fill);
}
.frame-shell .mailboxes-toggle {
  display: none;
}
/* The card keeps its width while the column narrows to hide it, so it slides out whole instead of squeezing. */
.frame-shell .mailboxes > :deep(nav) {
  position: absolute;
  top: var(--frame-inset);
  bottom: var(--frame-inset);
  left: var(--frame-inset);
  width: calc(var(--frame-sidebar-width) - var(--frame-inset) - var(--frame-sidebar-gap));
  height: auto;
  max-height: none;
  border-radius: var(--frame-card-radius);
  background: var(--frame-card-fill);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: var(--frame-card-edge), var(--frame-card-shadow);
  transition: transform var(--frame-sidebar-motion) var(--ease-out);
}
.frame-shell.collapsed .mailboxes > :deep(nav) {
  transform: translateX(calc(-100% - var(--frame-inset)));
  visibility: hidden;
  transition:
    transform var(--frame-sidebar-motion) var(--ease-out),
    visibility 0s linear var(--frame-sidebar-motion);
}
/* Liquid Glass (macOS 26 and later): the system draws the card under the page, so the page draws none of its own. */
html.liquid-glass:not(.reduce-transparency) .frame-shell .mailboxes > :deep(nav) {
  background: transparent;
  box-shadow: none;
}
/* macOS: above the sidebar the window moves, as in its title bar; the toggle lies on top. */
.frame-sidebar-drag {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  width: var(--frame-column);
  height: var(--frame-first-row-y);
}
/* On the line of the traffic lights, 13 from the card's right edge; at the left of the title strip when hidden. */
.frame-toggle {
  position: absolute;
  top: calc(var(--frame-toggle-y) - var(--frame-toggle-hit) / 2);
  left: 0;
  z-index: 3;
  display: grid;
  place-items: center;
  width: var(--frame-toggle-hit);
  height: var(--frame-toggle-hit);
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  transform: translateX(
    calc(var(--frame-sidebar-width) - var(--frame-sidebar-gap) - var(--frame-toggle-from-card) - var(--frame-toggle-glyph-width) / 2 - var(--frame-toggle-hit) / 2)
  );
  transition:
    transform var(--frame-sidebar-motion) var(--ease-out),
    background-color var(--motion-fast) ease;
}
.frame-toggle:hover {
  background: var(--ground);
}
.frame-shell.collapsed .frame-toggle {
  transform: translateX(calc(var(--frame-toggle-collapsed-x) - var(--frame-toggle-hit) / 2));
}
html.vibrant .frame-shell.collapsed .frame-toggle {
  transform: translateX(calc(var(--frame-toggle-collapsed-x-mac) - var(--frame-toggle-hit) / 2));
}
.frame-shell.resizing .frame-toggle {
  transition: background-color var(--motion-fast) ease;
}
/* Centred on the card's right edge, the card's height. */
.frame-resize {
  position: absolute;
  top: var(--frame-inset);
  bottom: var(--frame-inset);
  left: calc(var(--frame-sidebar-width) - var(--frame-sidebar-gap) - var(--frame-resize-handle) / 2);
  z-index: 2;
  width: var(--frame-resize-handle);
  touch-action: none;
}
.frame-resize:focus-visible {
  outline-offset: -2px;
  border-radius: var(--radius-control);
}
/* The window's material shows around the card only; the content keeps Tresso's canvas, to the window's edges. */
html.vibrant .frame-shell .stage {
  background: var(--canvas-light), var(--canvas);
}
/* 52 high, no line under it: the title from 10 right of the content's edge, the capsules ending 8 from the window's. */
.stage > .frame-strip {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: var(--frame-capsule-gap);
  min-height: var(--frame-title-height);
  padding: 0 var(--frame-inset) 0 var(--frame-title-x);
  overflow: visible;
  animation: none;
  transition: padding-left var(--frame-sidebar-motion) var(--ease-out);
}
/* Hidden sidebar: the title moves right of the toggle (and, on macOS, the traffic lights). */
.frame-shell.collapsed .stage > .frame-strip {
  padding-left: calc(var(--frame-toggle-collapsed-x) + var(--frame-toggle-hit) / 2 + var(--frame-title-x));
}
html.vibrant .frame-shell.collapsed .stage > .frame-strip {
  padding-left: calc(var(--frame-toggle-collapsed-x-mac) + var(--frame-toggle-hit) / 2 + var(--frame-title-x));
}
/* Chosen: the title keeps 160 px before the toolbar wraps below it (the toolbar never hides an action). */
.frame-title {
  flex: 1 1 160px;
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: var(--frame-title-height);
}
.frame-tools {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 0 var(--frame-capsule-gap);
  max-width: 100%;
  margin-left: auto;
}
.frame-tools:empty {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  .app.frame-shell,
  .frame-shell .mailboxes > :deep(nav),
  .frame-shell.collapsed .mailboxes > :deep(nav),
  .frame-toggle,
  .stage > .frame-strip {
    transition: none;
  }
}

@media (max-width: 760px) {
  .app {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .mailboxes {
    display: block;
    border-bottom: 1px solid var(--line);
    background: var(--ground);
  }
  .mailboxes-toggle {
    display: block;
    padding: 12px 16px;
    font-weight: 600;
    cursor: pointer;
  }
  .mailboxes[open] > :deep(nav) {
    max-height: 70vh;
  }
}
</style>
