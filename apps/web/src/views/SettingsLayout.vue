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
  /** Pages with addresses of their own that still belong under this entry. */
  under?: (name: string) => boolean
  shown?: () => boolean
}

/**
 * Meeting apps and access tokens are pages under Apps (the "Settings: apps" board): their addresses stay and the
 * navigation marks Apps on them. Connected apps lead to the AI assistants and apps page.
 */
const UNDER_APPS = ['settings-meeting-apps', 'settings-access-tokens']

/**
 * The settings menu, in its order. WhatsApp's settings (the SettingsWhatsApp board) and Add several accounts belong
 * under Accounts, though their addresses are their own. Updates shows in the desktop app, Subscription where billing
 * is on.
 */
const ENTRIES: Entry[] = [
  { label: 'Accounts', name: 'settings-accounts', under: (name) => name.startsWith('settings-whatsapp') || name === 'settings-accounts-import' },
  { label: 'Signatures', name: 'settings-signatures' },
  { label: 'Smart inboxes', name: 'settings-smart-inboxes' },
  { label: 'Notifications', name: 'settings-notifications' },
  { label: 'Batched delivery', name: 'settings-batches' },
  { label: 'Daily brief', name: 'settings-brief' },
  { label: 'Calendar', name: 'settings-calendar' },
  { label: 'Apps', name: 'settings-apps', under: (name) => name.startsWith('settings-apps') || UNDER_APPS.includes(name) },
  { label: 'Updates', name: 'settings-updates', shown: () => isDesktop },
  { label: 'Subscription', name: 'settings-billing', shown: () => Boolean(billing.status?.enabled) },
]

/** The entries on screen, each with whether it is the page the user is on (one at most). */
const entries = computed(() => {
  const name = typeof route.name === 'string' ? route.name : ''
  return ENTRIES.filter((entry) => entry.shown?.() ?? true).map((entry) => ({
    ...entry,
    current: name === entry.name || (entry.under?.(name) ?? false),
  }))
})
</script>

<template>
  <div class="settings">
    <div class="group">
      <!--
        No frame title: the label above the menu says Settings, and in the desktop app the title strip above stays
        empty (and keeps moving the window).
      -->
      <nav class="nav" aria-label="Settings">
        <span class="label" aria-hidden="true">Settings</span>
        <RouterLink
          v-for="entry in entries"
          :key="entry.name"
          :to="{ name: entry.name }"
          class="item"
          :aria-current="entry.current ? 'page' : undefined"
          >{{ entry.label }}</RouterLink
        >
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
:global(.frame-shell) .settings {
  padding-top: 0;
}
/* The desktop app's title strip sits above this view in the same column: it takes the same surface, so no band shows. */
:global(:root .app.frame-shell > .stage:has(> .settings)) {
  background: var(--stage);
}
.group {
  display: flex;
  align-items: flex-start;
  gap: 40px;
  max-width: calc(184px + 40px + var(--measure));
  margin: 0 auto;
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
  padding: 0 10px;
  color: var(--ink-2);
  font-size: 12px;
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
/* The page the user is on: a quiet pill, no saturated fill. */
.item[aria-current='page'],
.item[aria-current='page']:hover {
  background: var(--pill-quiet);
}
.content {
  flex: 1 1 0;
  min-width: 0;
  max-width: var(--measure);
}
@media (prefers-reduced-motion: reduce) {
  .item {
    transition: none;
  }
}
@media (max-width: 760px) {
  .settings,
  :global(.frame-shell) .settings {
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
  .label {
    display: none;
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
