<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <div class="settings">
    <nav class="nav" aria-label="Settings">
      <h1>Settings</h1>
      <RouterLink :to="{ name: 'settings-accounts' }" class="item">Accounts</RouterLink>
      <RouterLink :to="{ name: 'settings-signatures' }" class="item">Signatures</RouterLink>
      <RouterLink :to="{ name: 'settings-smart-inboxes' }" class="item">Smart inboxes</RouterLink>
      <RouterLink :to="{ name: 'settings-notifications' }" class="item">Notifications</RouterLink>
      <RouterLink :to="{ name: 'settings-batches' }" class="item">Batched delivery</RouterLink>
      <RouterLink :to="{ name: 'settings-brief' }" class="item">Daily brief</RouterLink>
      <RouterLink :to="{ name: 'settings-calendar' }" class="item">Calendar</RouterLink>
    </nav>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.settings {
  display: grid;
  grid-template-columns: minmax(200px, 240px) minmax(0, 1fr);
  min-height: 100%;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 20px 12px;
}
h1 {
  margin: 0 10px 12px;
  font: 700 28px/34px var(--font-display);
}
.item {
  display: flex;
  align-items: center;
  min-height: 36px;
  padding: 0 10px;
  border-radius: var(--radius-control);
  color: var(--ink);
  text-decoration: none;
  font-weight: 500;
  transition:
    background-color var(--motion-fast) ease,
    box-shadow var(--motion-fast) ease;
}
.item:hover {
  background: color-mix(in srgb, var(--surface) 60%, transparent);
}
.item.router-link-active {
  background: var(--surface);
  box-shadow: 0 1px 2px rgb(22 24 29 / 6%);
  font-weight: 600;
}
.content {
  min-width: 0;
  padding: 32px 40px;
  background: var(--surface);
  border-left: 1px solid var(--line);
}
@media (max-width: 760px) {
  .settings {
    grid-template-columns: minmax(0, 1fr);
  }
  .content {
    padding: 24px 16px;
    border-left: 0;
  }
}
</style>
