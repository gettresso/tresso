<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { verdictLabel, type SenderRule, type SyncedSmartInbox } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useBatchesStore } from '@/stores/batches'
import { useMailStore } from '@/stores/mail'
import { useSmartInboxesStore } from '@/stores/smartInboxes'
import AppIcon from '@/components/AppIcon.vue'
import SmartInboxMark from '@/components/SmartInboxMark.vue'
import VerdictChip from '@/components/VerdictChip.vue'
import LogoLoader from '@/components/LogoLoader.vue'

const store = useSmartInboxesStore()
const mail = useMailStore()
const batches = useBatchesStore()

const groups = computed(() => [
  { label: 'Built in', rows: store.smartInboxes.filter((s) => s.builtin !== null) },
  { label: 'Your own', rows: store.smartInboxes.filter((s) => s.builtin === null) },
])

const rules = ref<SenderRule[] | null>(null)
const rulesError = ref<string | null>(null)
const forgetting = ref<string | null>(null)

const BUILTIN_DESCRIPTIONS: Record<NonNullable<SyncedSmartInbox['builtin']>, string> = {
  todo: 'Mail that asks you to act',
  informational: 'Good to know, nothing to do',
  notification: 'Automated messages from apps and services',
  advertise: 'Newsletters, offers and other bulk mail',
  spam: 'Junk, phishing and scams',
}

function description(smartInbox: SyncedSmartInbox): string {
  if (smartInbox.builtin !== null) {
    return BUILTIN_DESCRIPTIONS[smartInbox.builtin]
  }
  const count = smartInbox.includeSenders.length

  return smartInbox.instructions.trim() || (count === 1 ? '1 sender included' : `${count} senders included`)
}

function smartInboxName(id: string): string {
  return store.smartInboxes.find((s) => s.id === id)?.name ?? 'a deleted smart inbox'
}

async function loadRules(): Promise<void> {
  rulesError.value = null
  try {
    rules.value = await store.senderRules()
  } catch (e) {
    rulesError.value = errorMessage(e)
  }
}

async function forget(rule: SenderRule): Promise<void> {
  forgetting.value = rule.id
  rulesError.value = null
  try {
    await store.forgetSenderRule(rule.id)
    rules.value = rules.value?.filter((candidate) => candidate.id !== rule.id) ?? null
  } catch (e) {
    rulesError.value = errorMessage(e)
  } finally {
    forgetting.value = null
  }
}

onMounted(() => {
  void loadRules()
  void batches.load()
})
</script>

<template>
  <section class="smart-inboxes">
    <header class="header">
      <div>
        <h2>Smart inboxes</h2>
        <p>Smart inboxes group your mail across all accounts. The verdict decides what happens to mail that lands there.</p>
      </div>
      <RouterLink :to="{ name: 'settings-smart-inbox', params: { smartInboxId: 'new' } }" class="button button-primary">New smart inbox</RouterLink>
    </header>

    <p v-if="!mail.ready" class="state" role="status"><LogoLoader /> Loading smart inboxes…</p>

    <table v-else class="table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Verdict</th>
          <th scope="col">Batch delivery</th>
          <th scope="col"><span class="visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <template v-for="group in groups" :key="group.label">
        <tbody v-if="group.rows.length > 0">
          <tr class="group-row">
            <th scope="rowgroup" colspan="4">{{ group.label }}</th>
          </tr>
          <tr v-for="smartInbox in group.rows" :key="smartInbox.id">
            <td>
              <span class="name-cell">
                <SmartInboxMark :smart-inbox="smartInbox" />
                <span class="name-text">
                  <span class="name">{{ smartInbox.name }}<span v-if="smartInbox.builtin" class="tag">Built in</span></span>
                  <span class="description">{{ description(smartInbox) }}</span>
                </span>
              </span>
            </td>
            <td><VerdictChip :verdict="smartInbox.verdict" /></td>
            <td class="batched">
              <AppIcon v-if="smartInbox.batchDelivery" name="clock" :size="16" label="In batches" />
              <span v-else class="visually-hidden">As it comes</span>
            </td>
            <td class="actions">
              <RouterLink :to="{ name: 'settings-smart-inbox', params: { smartInboxId: smartInbox.id } }" class="button button-quiet" :aria-label="`Edit ${smartInbox.name}`">
                Edit
              </RouterLink>
            </td>
          </tr>
        </tbody>
      </template>
    </table>
    <p class="hint">
      Changes apply to new mail and the last 30 days.
      <template v-if="batches.timesLabel">Batch delivery holds mail and delivers it at {{ batches.timesLabel }}.</template>
      <RouterLink :to="{ name: 'settings-batches' }">Change batch times</RouterLink>
    </p>

    <section class="remembered" aria-labelledby="remembered-title">
      <h3 id="remembered-title">Remembered senders</h3>
      <p class="hint">When you move a conversation, Tresso remembers it for the sender. Forget one to let the rules decide again.</p>
      <p v-if="rulesError" class="form-error" role="alert">{{ rulesError }}</p>
      <p v-if="rules === null && !rulesError" class="state" role="status"><LogoLoader /> Loading…</p>
      <p v-else-if="rules !== null && rules.length === 0" class="state">Nothing remembered yet.</p>
      <ul v-else-if="rules !== null" class="rules">
        <li v-for="rule in rules" :key="rule.id" class="rule">
          <span class="sender">{{ rule.sender }}</span>
          <span class="target">
            {{ smartInboxName(rule.smartInboxId) }}<template v-if="rule.verdict">, {{ verdictLabel(rule.verdict) }}</template>
          </span>
          <button type="button" class="button button-quiet" :disabled="forgetting === rule.id" :aria-label="`Forget ${rule.sender}`" @click="forget(rule)">
            Forget
          </button>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.smart-inboxes {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 880px;
}
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
h2 {
  margin: 0 0 4px;
  font-size: 20px;
  line-height: 28px;
}
h3 {
  margin: 0;
  font-size: 16px;
}
.header p,
.state,
.hint {
  margin: 0;
  color: var(--ink-2);
}
.hint {
  font-size: 13px;
}
.header .button {
  text-decoration: none;
}
.table {
  width: 100%;
  border-collapse: collapse;
}
.table thead th {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
  text-align: left;
}
.group-row th {
  padding: 16px 12px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-3);
  text-align: left;
}
.table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
.name-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}
.name-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.name {
  font-weight: 600;
}
.tag {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font-size: 11px;
  font-weight: 600;
}
.description {
  font-size: 12px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}
.batched {
  color: var(--ink-2);
}
.actions {
  text-align: right;
}
.actions .button {
  text-decoration: none;
}
.remembered {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}
.rules {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}
.rule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 6px 8px 6px 14px;
  border-bottom: 1px solid var(--line);
}
.rule:last-child {
  border-bottom: 0;
}
.sender {
  font: 400 13px var(--font-mono);
}
.target {
  flex: 1;
  color: var(--ink-2);
}
@media (max-width: 760px) {
  .description {
    max-width: 200px;
  }
}
</style>
