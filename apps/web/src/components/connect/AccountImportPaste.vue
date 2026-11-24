<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { readPastedAddresses, type LeftOutAddress, type PastedIssue } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { useAccountImportsStore } from '@/stores/accountImports'
import { useAccountsStore } from '@/stores/accounts'
import { checkLead, checkTitle, continueLabel, countLine, issuePill, issueText, leftOutPill, leftOutText, LIMIT, limitLabel, overLine, PASTE } from './importTexts'

/**
 * Step 1 of "Add several accounts" (the AddAccountsPaste board): paste the addresses, see what needs a look, and make
 * the list. Nothing is connected here. Addresses that are not valid or already connected are left out, an address
 * listed twice is added once; above 50 the list cannot be made.
 *
 * Back from a list ("Back to the addresses", `?from=<id>`), the box holds that list's addresses not connected yet, and
 * Continue replaces that list with the new one, so no list is left behind. Addresses the API left out after all are
 * named here as well, and Continue then opens the list made of the rest.
 */
const accounts = useAccountsStore()
const imports = useAccountImportsStore()
const route = useRoute()
const router = useRouter()

const text = ref('')
const busy = ref(false)
const failure = ref<string | null>(null)
/** The list this one replaces (back from a list), or the list made already when the API left addresses out. */
const replaces = ref<string | null>(null)
const made = ref<{ id: string; leftOut: LeftOutAddress[]; text: string } | null>(null)

const connected = computed(() => accounts.accounts.map((account) => account.emailAddress.toLowerCase()))
const read = computed(() => readPastedAddresses(text.value, connected.value))
const over = computed(() => read.value.toAdd.length > LIMIT)
const canContinue = computed(() => read.value.toAdd.length > 0 && !over.value)
/** What needs a look: what the box shows, then what the API left out of the list it made. */
const issues = computed<{ address: string; pill: string; text: string; kind: PastedIssue['kind'] }[]>(() => [
  ...read.value.issues.map((issue) => ({ address: issue.address, pill: issuePill(issue), text: issueText(issue), kind: issue.kind })),
  ...(made.value !== null && made.value.text === text.value ? made.value.leftOut : []).map((left) => ({ address: left.address, pill: leftOutPill(left), text: leftOutText(left), kind: left.reason === 'invalid' ? ('invalid' as const) : left.reason === 'duplicate' ? ('twice' as const) : ('connected' as const) })),
])

onMounted(async () => {
  if (!accounts.loaded) {
    try {
      await accounts.load()
    } catch {
      // Without the list an address connected already is not named here; the API leaves it out all the same.
    }
  }
  const from = typeof route.query.from === 'string' ? route.query.from : null
  if (from !== null) {
    try {
      const list = await imports.load(from)
      text.value = list.entries.filter((entry) => entry.state !== 'connected' && entry.state !== 'already_connected').map((entry) => entry.address).join('\n')
      replaces.value = list.id
    } catch {
      // A list that is gone leaves the box empty.
    }
  }
})

// A change to the box after the API left addresses out makes a new list on Continue, which replaces that one.
watch(text, () => {
  if (made.value !== null && made.value.text !== text.value) replaces.value = made.value.id
})

/** Makes the list of the addresses to add (in place of the one it replaces) and opens it. */
async function submit(): Promise<void> {
  if (!canContinue.value || busy.value) return
  if (made.value !== null && made.value.text === text.value) {
    await router.push({ name: 'settings-accounts-import', params: { importId: made.value.id } })
    return
  }
  busy.value = true
  failure.value = null
  try {
    const list = await imports.create(read.value.toAdd.map((address) => ({ address })))
    // The new list first, then the old one goes; should that fail, the new list opens all the same, and the old one
    // expires within a day.
    if (replaces.value !== null) {
      try {
        await imports.remove(replaces.value)
      } catch {
        // Gone already, or not removable now: nothing is lost either way.
      }
      replaces.value = null
    }
    if (list.leftOut.length > 0) {
      made.value = { id: list.id, leftOut: list.leftOut, text: text.value }
      return
    }
    await router.push({ name: 'settings-accounts-import', params: { importId: list.id } })
  } catch (e) {
    failure.value = e instanceof ApiError && Object.keys(e.violations).length > 0 ? Object.values(e.violations).join(' ') : errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="import">
    <header class="head">
      <RouterLink :to="{ name: 'settings-accounts' }" class="back" :aria-label="PASTE.back">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
      </RouterLink>
      <div class="titles">
        <h2 class="title">{{ PASTE.title }}</h2>
        <span class="lead">{{ PASTE.lead }}</span>
      </div>
    </header>

    <div class="columns">
      <section class="card paste" aria-labelledby="paste-title">
        <div class="labels">
          <label id="paste-title" for="bulk-addresses" class="label">{{ PASTE.label }}</label>
          <span id="bulk-hint" class="hint">{{ PASTE.hint }}</span>
        </div>
        <textarea id="bulk-addresses" v-model="text" class="box" :class="{ over }" aria-describedby="bulk-hint bulk-count" spellcheck="false" autocomplete="off" />
        <div class="count">
          <span id="bulk-count" role="status" class="count-line">{{ countLine(read) }}</span>
          <span class="limit" :class="{ over }">{{ limitLabel(read) }}</span>
        </div>
        <span v-if="over" role="alert" class="over-line">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>{{ overLine(read) }}
        </span>
        <span v-if="failure" role="alert" class="over-line">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>{{ failure }}
        </span>
      </section>

      <section class="card check" aria-labelledby="check-title">
        <h3 id="check-title">{{ checkTitle(read, issues.length) }}</h3>
        <span class="check-lead">{{ checkLead(read, issues.length) }}</span>
        <div v-for="(issue, index) in issues" :key="`${issue.address}-${index}`" class="issue">
          <span class="issue-head">
            <span class="issue-address">{{ issue.address }}</span>
            <span class="pill" :class="issue.kind">
              <svg v-if="issue.kind === 'connected'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
              {{ issue.pill }}</span
            >
          </span>
          <span class="issue-text">{{ issue.text }}</span>
        </div>
      </section>
    </div>

    <section class="card bar" aria-label="Continue">
      <span class="bar-note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
        <span>{{ PASTE.nothingConnected }}</span>
      </span>
      <RouterLink :to="{ name: 'settings-accounts' }" class="cancel">{{ PASTE.cancel }}</RouterLink>
      <button v-if="canContinue" type="button" class="primary" :disabled="busy" @click="submit">{{ continueLabel(read, made !== null && made.text === text ? made.leftOut.length : 0) }}</button>
      <button v-else type="button" class="off" disabled aria-disabled="true">{{ PASTE.continue }}</button>
    </section>
  </div>
</template>

<style scoped>
.import {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 4px 4px 0;
}
.back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-control);
  color: var(--ink-2);
}
.back:hover {
  background: var(--ground);
}
.titles {
  display: flex;
  flex: 1 1 300px;
  flex-direction: column;
  gap: 2px;
}
.title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
}
.lead {
  font-size: 14px;
  color: var(--ink-2);
}
.columns {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 16px;
}
.card {
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--paper);
}
.paste {
  display: flex;
  flex: 999 1 420px;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 18px 20px;
}
.labels {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.label {
  font-size: 16px;
  font-weight: 600;
}
.hint {
  font-size: 13px;
  color: var(--ink-2);
}
.box {
  box-sizing: border-box;
  height: 440px;
  padding: 10px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--paper);
  color: var(--ink);
  font: 400 13px/20px var(--font-mono);
  outline: 0;
  resize: vertical;
}
.box:focus-visible {
  border-color: var(--focus);
}
.box.over {
  border: 1.5px solid var(--danger);
}
.count {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
}
.count-line {
  flex: 1 1 260px;
  font-size: 13px;
  line-height: 19px;
  color: var(--ink);
}
.limit {
  font: 500 12px var(--font-mono);
  color: var(--ink-2);
  white-space: nowrap;
}
.limit.over,
.over-line {
  color: var(--danger);
}
.over-line {
  display: flex;
  gap: 6px;
  font-size: 13px;
  line-height: 19px;
}
.over-line svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.check {
  display: flex;
  flex: 1 1 300px;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 18px 20px;
}
h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.check-lead {
  padding-bottom: 8px;
  font-size: 13px;
  color: var(--ink-2);
}
.issue {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
}
.issue-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.issue-address {
  min-width: 0;
  font: 500 12px var(--font-mono);
  overflow-wrap: anywhere;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.pill.invalid {
  background: var(--danger-soft);
  color: var(--danger);
}
.issue-text {
  font-size: 12px;
  line-height: 17px;
  color: var(--ink-2);
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
}
.bar-note {
  display: flex;
  flex: 1 1 320px;
  gap: 10px;
  font-size: 13px;
  line-height: 19px;
  color: var(--ink);
}
.bar-note svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--ink-2);
}
.cancel {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--radius-control);
  color: var(--ink-2);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}
.cancel:hover {
  background: var(--ground);
}
.primary,
.off {
  height: 40px;
  padding: 0 16px;
  border-radius: var(--radius-control);
  font: 600 14px var(--font-ui);
}
.primary {
  border: 0;
  background: var(--ink);
  color: var(--paper);
  cursor: pointer;
}
.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 86%, var(--paper));
}
.off {
  border: 1px solid var(--line);
  background: var(--ground);
  color: var(--ink-3);
  cursor: not-allowed;
}
</style>
