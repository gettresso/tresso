<script setup lang="ts">
import { computed, ref } from 'vue'
import { canJoin, displayLink, joinLabel, linkText, type Conference } from '@tresso/core'
import { JOIN_FAILED, openMeeting } from '@/calendar/join'
import { isDesktop } from '@/platform/desktop'
import AppIcon from '@/components/AppIcon.vue'
import CopyLinkButton from '@/components/calendar/CopyLinkButton.vue'
import KeyShortcut from '@/components/KeyShortcut.vue'

/**
 * The Join button of an event's meeting: "Join with Microsoft Teams", from core's `joinLabel`. In the browser a new
 * tab without opener or referrer; on the desktop the user's browser, through the shell. A link core's `canJoin`
 * refuses gets no button: it is shown as text with Copy link, unless `copyOnly` is false because the caller shows the
 * link itself (the popover).
 */
const props = withDefaults(
  defineProps<{
    conference: Pick<Conference, 'provider' | 'url'>
    variant?: 'primary' | 'quiet'
    /** 30 px high, for a row in a list. */
    compact?: boolean
    /** "Join" with the Shift J keycap on the button; the full label stays its name. */
    short?: boolean
    /** For a link that cannot be joined: show it with Copy link (lists), or nothing (the caller shows it). */
    fallback?: boolean
  }>(),
  { variant: 'quiet', compact: false, short: false, fallback: true },
)

const joinable = computed(() => canJoin(props.conference))
const label = computed(() => joinLabel(props.conference.provider))
const failed = ref(false)

function join(event: MouseEvent): void {
  failed.value = false
  if (!isDesktop) {
    // The anchor opens the new tab itself (target, rel and referrerpolicy below).
    return
  }
  event.preventDefault()
  openMeeting(props.conference.url).catch(() => (failed.value = true))
}
</script>

<template>
  <span v-if="joinable || fallback" class="join-link">
    <a
      v-if="joinable"
      class="button"
      :class="[variant === 'primary' ? 'button-primary' : 'button-quiet', { compact }]"
      :href="conference.url"
      target="_blank"
      rel="noopener noreferrer"
      referrerpolicy="no-referrer"
      :aria-label="short ? label : undefined"
      :aria-keyshortcuts="short ? 'Shift+J' : undefined"
      @click="join"
    >
      <AppIcon name="video" :size="15" />
      <template v-if="short">Join <KeyShortcut keys="Shift+J" /></template>
      <template v-else>{{ label }}</template>
    </a>
    <template v-else>
      <span class="link-text"><AppIcon name="link" :size="14" /> <span class="link" dir="ltr" :title="displayLink(conference.url)">{{ linkText(conference.url, 32) }}</span></span>
      <CopyLinkButton :url="conference.url" :compact="compact" />
    </template>
    <span v-if="failed" class="join-failed" role="alert">{{ JOIN_FAILED }}</span>
  </span>
</template>

<style scoped>
.join-link {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.button {
  flex: 1;
  gap: 6px;
}
.compact {
  height: 30px;
}
.link-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--ink-2);
  font: 400 12px var(--font-mono);
  white-space: nowrap;
}
.link {
  unicode-bidi: isolate;
}
.join-failed {
  flex-basis: 100%;
  color: var(--danger);
  font-size: 13px;
}
</style>
