<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { isDesktop } from '@/platform/desktop'
import { useBillingStore } from '@/stores/billing'

const billing = useBillingStore()
const route = useRoute()

interface Entry {
  label: string
  name: string
  /** Pages with addresses of their own that belong under this entry. */
  under?: readonly string[]
  shown?: () => boolean
}

/**
 * Meeting apps and access tokens are pages under Apps (the "Settings: apps" board), as are the AI assistants and the
 * activity log: their addresses stay and the navigation marks Apps on them. Connected apps lead to the AI assistants.
 */
const UNDER_APPS = ['settings-apps-assistants', 'settings-apps-activity', 'settings-meeting-apps', 'settings-access-tokens'] as const

/**
 * Pages designed wider than the reading width (their rows hold more than 720 does): on these the page may be 960
 * wide, and menu and page stay centred as one group.
 */
const WIDE = ['settings-apps', 'settings-apps-assistants', 'settings-apps-activity', 'settings-signatures', 'settings-smart-inboxes'] as const

/**
 * The settings menu, in its order. WhatsApp's settings (the SettingsWhatsApp board), adding one account and adding
 * several belong under Accounts; one smart inbox under Smart inboxes. Updates shows in the desktop app, Subscription
 * where billing is on.
 */
const ENTRIES: Entry[] = [
  { label: 'Accounts', name: 'settings-accounts', under: ['settings-accounts-new', 'settings-accounts-import', 'settings-whatsapp', 'settings-whatsapp-connect'] },
  { label: 'Signatures', name: 'settings-signatures' },
  { label: 'Smart inboxes', name: 'settings-smart-inboxes', under: ['settings-smart-inbox'] },
  { label: 'Notifications', name: 'settings-notifications' },
  { label: 'Batched delivery', name: 'settings-batches' },
  { label: 'Daily brief', name: 'settings-brief' },
  { label: 'Calendar', name: 'settings-calendar' },
  { label: 'Apps', name: 'settings-apps', under: UNDER_APPS },
  { label: 'Updates', name: 'settings-updates', shown: () => isDesktop },
  { label: 'Subscription', name: 'settings-billing', shown: () => Boolean(billing.status?.enabled) },
]

const routeName = computed(() => (typeof route.name === 'string' ? route.name : ''))

/**
 * The entries on screen. The one the user is on is `page`; the entry a sub-page belongs under is `true`, so a screen
 * reader hears it as the current section and it looks the same.
 */
const entries = computed(() =>
  ENTRIES.filter((entry) => entry.shown?.() ?? true).map((entry) => ({
    ...entry,
    current: routeName.value === entry.name ? ('page' as const) : entry.under?.includes(routeName.value) ? ('true' as const) : undefined,
  })),
)

const wide = computed(() => (WIDE as readonly string[]).includes(routeName.value))
</script>

<template>
  <div class="settings">
    <div class="group" :class="{ wide }">
      <!--
        No frame title: the heading above the menu says Settings, and in the desktop app the title strip above stays
        empty (and keeps moving the window).
      -->
      <nav class="nav" aria-label="Settings">
        <h1 class="label">Settings</h1>
        <RouterLink v-for="entry in entries" :key="entry.name" :to="{ name: entry.name }" class="item" :aria-current="entry.current">{{ entry.label }}</RouterLink>
      </nav>
      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
/*
 * One surface for all of Settings (the "Settings: accounts" board): menu and page sit together on --stage, centred as
 * one group, the page at the reading width. 52 from the top in the browser; in the desktop app the title strip is
 * those 52.
 */
.settings {
  box-sizing: border-box;
  min-height: 100%;
  padding: 52px 32px 48px;
  background: var(--stage);
}
.frame-shell .settings {
  padding-top: 0;
}
/*
 * The desktop app's title strip sits above this view in the same column: it takes the same surface, so no band shows.
 * A whole global, as the strip is AppShell's element, not this view's.
 */
:global(:root .app.frame-shell > .stage:has(> .settings)) {
  background: var(--stage);
}
.group {
  --settings-page-width: var(--measure);

  display: flex;
  align-items: flex-start;
  gap: 40px;
  max-width: calc(184px + 40px + var(--settings-page-width));
  margin: 0 auto;
}
/* A page designed wider (WIDE). */
.group.wide {
  --settings-page-width: 960px;
}
.nav {
  flex: 0 0 184px;
  display: flex;
  flex-direction: column;
}
.label {
  display: flex;
  align-items: center;
  height: 30px;
  margin: 0;
  padding: 0 10px;
  color: var(--ink-2);
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
}
.item {
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-row);
  color: var(--ink);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition: background-color var(--motion-fast) ease;
}
.item:hover {
  background: var(--ground);
}
/* The page the user is on, or the one its sub-page belongs under: a quiet pill, no saturated fill. */
.item[aria-current],
.item[aria-current]:hover {
  background: var(--pill-quiet);
}
.content {
  flex: 1 1 0;
  min-width: 0;
  max-width: var(--settings-page-width);
}
@media (prefers-reduced-motion: reduce) {
  .item {
    transition: none;
  }
}
@media (max-width: 760px) {
  .settings,
  .frame-shell .settings {
    padding: 0;
  }
  .group {
    display: block;
  }
  /* One row of links that scrolls sideways, so the page a link opens starts right under it. */
  .nav {
    flex-direction: row;
    gap: 4px;
    padding: 8px 12px;
    overflow-x: auto;
  }
  /* Out of sight but still the page's heading for a screen reader. */
  .label {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .item {
    flex: none;
    /* Touch size on a phone. */
    min-height: 44px;
  }
  .content {
    max-width: none;
    padding: 24px 16px;
  }
}
</style>
