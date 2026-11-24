<script setup lang="ts">
import { computed, nextTick, onMounted, ref, toRef, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useAccountsStore } from '@/stores/accounts'
import ConnectChecks from './ConnectChecks.vue'
import ImportPasswordForm from './ImportPasswordForm.vue'
import ProviderMark from './ProviderMark.vue'
import {
  ALREADY_HINT,
  approveHint,
  assistantNotice,
  BLOCKED_HINT,
  CANCELLED_HINT,
  checkHint,
  DONE,
  doneLine,
  doneTitle,
  EXPIRED,
  expiredCounts,
  expiredMade,
  failedHint,
  GROUPS,
  groupCount,
  keptLine,
  LIST,
  nextLabel,
  refusedHint,
  ROW_ACTIONS,
  ROW_STATES,
  runLine,
  soFar,
  stillAddLine,
  stoppedReason,
  stoppedTitle,
  STOPPED_SIGN_IN,
  FINISHING,
  summaryLine,
  summaryTitle,
  USE_ADDRESSES,
  waitingHint,
  type CheckProblem,
} from './importTexts'
import { useAccountImport, type ImportRow } from './useAccountImport'

/**
 * Step 2 of "Add several accounts" (the AddAccountsList and AddAccountsStates boards): the summary with its progress,
 * the rows grouped by how they sign in, one action per row, and the endings (all done, expired). A list an app made
 * shows only its addresses until the user chose "Use these addresses".
 */
const props = defineProps<{ importId: string }>()
const page = useAccountImport(toRef(props, 'importId'))
const accounts = useAccountsStore()
const router = useRouter()

const root = ref<HTMLElement | null>(null)
/** For screen readers: what just happened (a row that changed, a run that started or stopped). */
const announcement = ref('')

onMounted(async () => {
  await page.open()
  try {
    await accounts.loadServerRules()
  } catch {
    // Without it "None" is not offered as connection security, which only local test servers need.
  }
})

const percent = computed(() => (page.total.value === 0 ? 0 : Math.round((page.connectedCount.value / page.total.value) * 100)))
const currentRow = computed(() => page.rows.value.find((row) => row.id === page.current.value) ?? null)
const stoppedRow = computed(() => page.rows.value.find((row) => row.id === page.stopped.value) ?? null)
const addedGroups = computed(() => page.groups.value.map((group) => ({ title: GROUPS[group.group].title, count: group.added })).filter((group) => group.count > 0))

/** How the row's last server check failed, with the server it names; null when its password was refused or not checked. */
function checkProblem(row: ImportRow): { problem: CheckProblem; host: string; port: number } | null {
  const check = page.checks.value[row.id]
  if (check === undefined) return row.servers === null ? null : { problem: 'unreachable', host: row.servers.imap.host, port: row.servers.imap.port }
  const imapFailed = check.result.imap !== 'ok' && check.result.imap !== 'not_checked'
  const status = imapFailed ? check.result.imap : check.result.smtp
  const server = imapFailed ? check.imap : check.smtp
  const problem: CheckProblem = status === 'certificate' || status === 'blocked' || status === 'failed' ? status : 'unreachable'
  return { problem, host: server.host, port: server.port }
}

function action(row: ImportRow): { label: string; run: () => void; toggle: boolean } | null {
  if (!page.confirmed.value) return null
  if (row.lookupError !== null) return { label: ROW_ACTIONS.tryAgain, run: () => void page.retryLookup(row.address), toggle: false }
  const password = row.route?.kind === 'password'
  switch (row.view) {
    case 'todo':
      return password
        ? { label: page.openRow.value === row.id ? ROW_ACTIONS.close : ROW_ACTIONS.enterPassword, run: () => page.toggleForm(row.id), toggle: true }
        : { label: ROW_ACTIONS.signIn, run: () => void page.signIn(row.id), toggle: false }
    case 'signing-in':
      return password ? { label: ROW_ACTIONS.cancel, run: () => page.cancelCheck(row.id), toggle: false } : null
    case 'waiting':
      return { label: ROW_ACTIONS.openAgain, run: () => page.openAgain(row.id), toggle: false }
    case 'cancelled':
    case 'approve':
    case 'wrong':
    case 'failed':
      return password
        ? { label: page.openRow.value === row.id ? ROW_ACTIONS.close : ROW_ACTIONS.enterPassword, run: () => page.toggleForm(row.id), toggle: true }
        : { label: ROW_ACTIONS.tryAgain, run: () => void page.signIn(row.id), toggle: false }
    case 'refused':
      return { label: page.openRow.value === row.id ? ROW_ACTIONS.close : ROW_ACTIONS.enterPassword, run: () => page.toggleForm(row.id), toggle: true }
    case 'unreachable':
      return { label: ROW_ACTIONS.checkSettings, run: () => page.checkSettings(row.id), toggle: false }
    case 'skipped':
      return { label: ROW_ACTIONS.addBack, run: () => void page.addBack(row.id), toggle: false }
    default:
      return null
  }
}

function providerOf(row: ImportRow) {
  return row.route?.kind === 'oauth' ? row.route.provider : null
}

function hint(row: ImportRow): string | null {
  if (!page.confirmed.value) return null
  if (row.lookupError !== null) return row.lookupError
  const error = page.rowErrors.value[row.id]
  if (error) return error
  const provider = providerOf(row) ?? 'microsoft'
  switch (row.view) {
    case 'waiting':
      return page.blocked.value[row.id] ? BLOCKED_HINT : waitingHint(provider)
    case 'cancelled':
      return CANCELLED_HINT
    case 'approve':
      return approveHint(row.address, row.approvalUrl)
    case 'refused':
      return refusedHint(row.address)
    case 'unreachable': {
      const found = checkProblem(row)
      return found === null ? null : checkHint(found.problem, found)
    }
    case 'already':
      return ALREADY_HINT
    case 'wrong':
    case 'failed':
    case 'failed-final':
      return failedHint(row.failure, provider)
    default:
      return null
  }
}

const stoppedText = computed(() => {
  const row = stoppedRow.value
  if (row === null) return ''
  const found = row.view === 'unreachable' ? checkProblem(row) : null
  const reason = stoppedReason({ state: row.view, address: row.address, provider: providerOf(row), failure: row.failure, check: found, error: page.rowErrors.value[row.id] ?? null })
  return `${reason} ${soFar(page.connectedCount.value, page.total.value)}`
})

const statusLine = computed(() => {
  const row = currentRow.value
  if (page.mode.value === null || row === null) return LIST.idleLine
  return runLine(page.mode.value, row.address, page.mode.value === 'all' ? (page.afterCurrent.value?.address ?? null) : null)
})

// Each row that changes is read out with its new state, and a run that starts or ends with its line.
watch(
  () => page.rows.value.map((row) => `${row.id}:${row.view}`).join('|'),
  (now, before) => {
    if (before === undefined || before === '') return
    const old = new Map(before.split('|').map((part) => part.split(':') as [string, string]))
    // A row that starts waiting is said by the run line.
    const changed = page.rows.value.find((row) => old.get(row.id) !== undefined && old.get(row.id) !== row.view && row.view !== 'waiting')
    if (changed) announcement.value = `${changed.address}: ${ROW_STATES[changed.view].label}`
  },
)
watch(
  () => page.mode.value,
  (now, before) => {
    if ((now === null) !== (before === null)) announcement.value = statusLine.value
  },
)

/** Moves the focus to the first element the selector finds once the page has drawn. */
async function focus(selector: string): Promise<void> {
  await nextTick()
  root.value?.querySelector<HTMLElement>(selector)?.focus()
}

// A run that stops at a row that did not connect: the notice's first action. A row that ended with nothing running:
// "Next", so one keypress starts it.
watch(
  () => [page.mode.value, page.stopped.value] as const,
  ([mode, stopped], [beforeMode]) => {
    if (stopped !== null) void focus('.stopped button')
    else if (mode === null && beforeMode !== null) void focus('.summary .next-button')
  },
)

async function start(kind: 'next' | 'all'): Promise<void> {
  await (kind === 'next' ? page.next() : page.signInAll())
  // The button that was clicked is gone; Stop takes its place, unless the run opened a password row, whose field has
  // the focus.
  if (page.mode.value !== null && !(page.openRow.value !== null && page.openedByRun.value)) await focus('.summary .stop-button')
}

async function checkAndAdd(entryId: string, values: Parameters<typeof page.connectWithPassword>[1]): Promise<void> {
  const connected = await page.connectWithPassword(entryId, values)
  if (page.mode.value !== null || page.stopped.value !== null) return
  if (connected) await focus('.summary .next-button, .ending a')
  else await focus(`[data-row="${entryId}"] .row-action button`)
}

async function finish(): Promise<void> {
  await page.finishWithoutRest()
  await focus('.ending a')
}

async function goBack(): Promise<void> {
  await page.goBackToSkipped()
  await focus('.summary .next-button')
}

async function useAddresses(): Promise<void> {
  await page.confirm()
  await focus('.summary .next-button')
}

async function deleteList(): Promise<void> {
  if (await page.removeList()) await router.push({ name: 'settings-accounts' })
}

/** The second label of the lookup turns once the addresses are looked up. */
const lookStage = computed(() => page.lookStage.value)
</script>

<template>
  <div ref="root" class="import">
    <header class="head">
      <RouterLink :to="{ name: 'settings-accounts-import', query: { from: importId } }" class="back" :aria-label="LIST.back">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
      </RouterLink>
      <div class="titles">
        <h2 class="title">{{ LIST.title }}</h2>
        <span class="lead">{{ LIST.lead }}</span>
      </div>
    </header>

    <p v-if="page.returning.value === 'finishing'" class="returning" role="status">{{ FINISHING }}</p>
    <p v-else-if="page.returning.value === 'stopped'" class="returning" role="status">{{ STOPPED_SIGN_IN }}</p>
    <p v-if="page.error.value" class="form-error" role="alert">{{ page.error.value }}</p>

    <!-- The list is gone (expired, deleted, another user's): it replaces the summary and the list. -->
    <section v-if="page.status.value === 'missing'" class="card ending-card" aria-label="The list has expired">
      <div class="ending">
        <div class="ending-head">
          <span class="ending-mark quiet"
            ><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg
          ></span>
          <span class="ending-titles">
            <span class="ending-title">{{ EXPIRED.title }}</span>
            <span class="ending-sub">{{ page.expired.value && page.list.value ? expiredMade(page.list.value.createdAt) : EXPIRED.kept }}</span>
          </span>
        </div>
        <span v-if="page.expired.value && page.list.value" class="ending-text">{{ expiredCounts(page.connectedCount.value, page.total.value - page.connectedCount.value) }}</span>
        <div class="ending-actions">
          <RouterLink :to="{ name: 'settings-accounts-import' }" class="small primary">{{ EXPIRED.startNew }}</RouterLink>
          <RouterLink :to="{ name: 'settings-accounts' }" class="small secondary">{{ EXPIRED.back }}</RouterLink>
        </div>
      </div>
    </section>

    <template v-else-if="page.status.value === 'ready' && page.list.value">
      <!-- All done: it replaces the summary and the list. -->
      <section v-if="page.allDone.value" class="card ending-card" aria-label="All done">
        <div class="ending">
          <div class="ending-head">
            <span class="ending-mark" :class="page.addedCount.value > 0 ? 'know' : 'quiet'"
              ><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
            ></span>
            <span class="ending-titles">
              <span class="ending-title">{{ doneTitle(page.addedCount.value, page.total.value, page.skippedRows.value.length, page.alreadyCount.value) }}</span>
              <span v-if="doneLine(page.addedCount.value, page.skippedRows.value.length)" class="ending-sub">{{ doneLine(page.addedCount.value, page.skippedRows.value.length) }}</span>
            </span>
          </div>
          <div v-if="addedGroups.length > 0 || page.skippedRows.value.length > 0" class="ending-columns">
            <div v-if="addedGroups.length > 0" class="ending-column">
              <span class="column-title">{{ DONE.added }}</span>
              <span v-for="group in addedGroups" :key="group.title" class="added"
                ><span class="added-name">{{ group.title }}</span><span class="added-count">{{ group.count }}</span></span
              >
            </div>
            <div v-if="page.skippedRows.value.length > 0" class="ending-column">
              <span class="column-title">{{ DONE.skipped }}</span>
              <span v-for="row in page.skippedRows.value" :key="row.id" class="skipped">{{ row.address }}</span>
            </div>
          </div>
          <span v-if="page.skippedRows.value.length > 0" class="small-note">{{ stillAddLine(page.list.value.expiresAt) }}</span>
          <div class="ending-actions">
            <RouterLink :to="{ name: 'settings-accounts' }" class="small primary">{{ DONE.done }}</RouterLink>
            <button v-if="page.skippedRows.value.length > 0" type="button" class="small secondary" @click="goBack">{{ DONE.goBack }}</button>
          </div>
        </div>
      </section>

      <template v-else>
        <div v-if="page.createdBy.value && (page.showAssistantNotice.value || !page.confirmed.value)" role="status" class="assistant">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17.5v.01" /></svg>
          <span class="assistant-text" :title="page.createdBy.value">{{ assistantNotice(page.createdBy.value, page.list.value.createdWithToken) }}</span>
          <button v-if="!page.confirmed.value" type="button" class="small primary" @click="useAddresses">{{ USE_ADDRESSES }}</button>
          <button type="button" class="small secondary" @click="deleteList">{{ LIST.deleteList }}</button>
        </div>

        <section v-if="page.confirmed.value" class="card summary" aria-labelledby="sum-title">
          <div class="summary-head">
            <div class="summary-titles">
              <h3 id="sum-title">{{ summaryTitle(page.connectedCount.value, page.total.value) }}</h3>
              <span class="summary-line">{{ summaryLine(page.failedCount.value, page.todoCount.value) }}</span>
            </div>
            <button v-if="page.mode.value !== null" type="button" class="button-40 secondary stop-button" @click="page.stopAll()">{{ LIST.stop }}</button>
            <template v-else-if="page.nextRow.value && !page.looking.value">
              <button type="button" class="button-40 secondary next-button" @click="start('next')">{{ nextLabel(page.nextRow.value.address) }}</button>
              <button type="button" class="button-40 primary" @click="start('all')">{{ LIST.all }}</button>
            </template>
          </div>
          <div role="progressbar" class="bar" :aria-label="LIST.progressLabel" aria-valuemin="0" :aria-valuemax="page.total.value" :aria-valuenow="page.connectedCount.value">
            <div class="bar-fill" :style="{ width: `${percent}%` }" />
          </div>
          <div v-if="stoppedRow" role="alert" class="stopped">
            <div class="stopped-head">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.01" /></svg>
              <span class="stopped-texts">
                <span class="stopped-title">{{ stoppedTitle(stoppedRow.address) }}</span>
                <span class="stopped-text">{{ stoppedText }}</span>
              </span>
            </div>
            <div class="stopped-actions">
              <button type="button" class="button-32 primary" @click="page.continueWithNext()">{{ LIST.continueNext }}</button>
              <button v-if="stoppedRow.view !== 'failed-final' && stoppedRow.view !== 'already'" type="button" class="button-32 secondary" @click="page.tryAgain()">{{ LIST.tryAgain }}</button>
              <button v-if="stoppedRow.view === 'approve' && stoppedRow.approvalUrl" type="button" class="button-32 secondary" @click="page.copyApprovalLink(stoppedRow.id)">{{ LIST.copyApproval }}</button>
            </div>
          </div>
          <span v-else role="status" class="run-line">{{ statusLine }}</span>
        </section>

        <!-- A list an app made, before the user chose to use it: only its addresses. -->
        <section v-if="!page.confirmed.value" class="card group" aria-label="Addresses">
          <ul class="rows">
            <li v-for="row in page.rows.value" :key="row.id" class="row">
              <div class="row-line">
                <span class="row-address">{{ row.address }}</span>
              </div>
            </li>
          </ul>
        </section>

        <section v-else-if="page.looking.value" class="card group" aria-label="Looking up the addresses">
          <ConnectChecks :labels="[...LIST.looking]" :stage="lookStage" />
        </section>

        <template v-else>
          <section v-for="group in page.groups.value" :key="group.group" class="card group" :aria-labelledby="`bulk-${group.group}`">
            <div class="group-head">
              <ProviderMark :provider="GROUPS[group.group].mark" :size="32" :font-size="15" />
              <div class="group-titles">
                <h3 :id="`bulk-${group.group}`" class="group-title">{{ GROUPS[group.group].title }}</h3>
                <span class="group-how">{{ GROUPS[group.group].how }}</span>
              </div>
              <span class="group-count">{{ groupCount(group.done, group.rows.length) }}</span>
            </div>
            <ul class="rows">
              <li v-for="row in group.rows" :key="row.id" class="row" :data-row="row.id">
                <div class="row-line">
                  <ProviderMark :provider="GROUPS[group.group].mark" :size="24" :font-size="12" />
                  <span class="row-who">
                    <span class="row-address">{{ row.address }}</span>
                    <span v-if="hint(row)" class="row-hint">{{ hint(row) }}</span>
                  </span>
                  <span class="row-state" :class="ROW_STATES[row.view].tone">
                    <span class="row-icon" aria-hidden="true">
                      <span v-if="ROW_STATES[row.view].icon === 'dot'" class="dot" />
                      <svg v-else-if="ROW_STATES[row.view].icon === 'spin'" class="spin" width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="9" class="track" stroke-width="3" />
                        <path d="M21 12a9 9 0 00-9-9" class="arc" stroke-width="3" stroke-linecap="round" />
                      </svg>
                      <span v-else-if="ROW_STATES[row.view].icon === 'check'" class="check" :class="{ quiet: row.view === 'already' }"
                        ><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
                      ></span>
                      <svg v-else-if="ROW_STATES[row.view].icon === 'undo'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M9 14L4 9l5-5" />
                        <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
                      </svg>
                      <svg v-else-if="ROW_STATES[row.view].icon === 'alert'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v6M12 16.5v.01" />
                      </svg>
                      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg>
                    </span>
                    <span :class="{ pulse: row.view === 'waiting' }">{{ ROW_STATES[row.view].label }}</span>
                  </span>
                  <span class="row-action">
                    <button
                      v-if="action(row)"
                      type="button"
                      class="button-30"
                      :aria-label="`${action(row)!.label}: ${row.address}`"
                      :aria-expanded="action(row)!.toggle ? page.openRow.value === row.id : undefined"
                      @click="action(row)!.run()"
                    >
                      {{ action(row)!.label }}
                    </button>
                  </span>
                </div>
                <ImportPasswordForm
                  v-if="page.openRow.value === row.id && row.route?.kind === 'password'"
                  :row="row"
                  :settings-shown="page.settingsShown.value[row.id] === true"
                  :busy="row.view === 'signing-in'"
                  :allow-unencrypted="accounts.allowUnencrypted"
                  :attempt="page.attempts.value[row.id] ?? 0"
                  :focus-password="page.openedByRun.value"
                  @submit="(values) => checkAndAdd(row.id, values)"
                  @show-settings="page.showSettings(row.id)"
                />
              </li>
            </ul>
          </section>
        </template>

        <section class="card list-bar" aria-label="This list">
          <span class="list-note">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            <span>{{ keptLine(page.list.value.expiresAt) }}</span>
          </span>
          <button v-if="page.confirmed.value" type="button" class="button-36 secondary" @click="finish">{{ LIST.finish }}</button>
        </section>
      </template>
    </template>

    <span class="visually-hidden" role="status" aria-live="polite">{{ announcement }}</span>
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
.returning {
  margin: 0;
  padding: 0 4px;
  font-size: 14px;
  color: var(--ink-2);
}
.card {
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--paper);
}

/* Buttons as the boards draw them: 40, 36, 32 and 30 high, primary in ink, secondary outlined. */
.button-40,
.button-36,
.button-32,
.button-30,
.small {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  border-radius: var(--radius-control);
  font-family: var(--font-ui);
  font-weight: 600;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
}
.button-40 {
  height: 40px;
  padding: 0 16px;
  font-size: 14px;
}
.button-36 {
  height: 36px;
  padding: 0 12px;
  font-size: 13px;
}
.button-32 {
  height: 32px;
  padding: 0 12px;
  font-size: 13px;
}
.button-30 {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
  font-size: 12px;
}
.small {
  height: 36px;
  padding: 0 12px;
  font-size: 13px;
}
.primary {
  border: 0;
  background: var(--ink);
  color: var(--paper);
}
.small.primary {
  padding: 0 14px;
}
.primary:hover {
  background: color-mix(in srgb, var(--ink) 86%, var(--paper));
}
.secondary {
  border: 1px solid var(--line-strong);
  background: var(--paper);
  color: var(--ink);
}
.secondary:hover,
.button-30:hover {
  background: var(--ground);
}

.assistant {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--delegate-soft);
}
.assistant svg {
  flex-shrink: 0;
  color: var(--delegate);
}
.assistant-text {
  flex: 1 1 280px;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 20px;
  color: var(--ink);
}
.assistant .small {
  height: 32px;
}

.summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
}
.summary-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.summary-titles {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: 2px;
}
.summary h3 {
  margin: 0;
  font-size: 18px;
  line-height: 24px;
  font-weight: 600;
}
.summary-line {
  font-size: 13px;
  color: var(--ink-2);
}
.bar {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--line);
}
.bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--ink);
}
.run-line {
  font-size: 13px;
  line-height: 19px;
  color: var(--ink);
}
.stopped {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-card);
  background: var(--danger-soft);
  color: var(--danger);
}
.stopped-head {
  display: flex;
  gap: 10px;
}
.stopped-head svg {
  flex-shrink: 0;
  margin-top: 1px;
}
.stopped-texts {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stopped-title {
  font-size: 14px;
  font-weight: 600;
}
.stopped-text {
  font-size: 14px;
  line-height: 20px;
}
.stopped-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 28px;
}

.group {
  display: flex;
  flex-direction: column;
  padding: 14px 20px 6px;
}
.group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding-bottom: 12px;
}
.group-titles {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  min-width: 0;
}
.group-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.group-how {
  font-size: 12px;
  color: var(--ink-2);
}
.group-count {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
  white-space: nowrap;
}
.rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.row {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
}
.row-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  box-sizing: border-box;
  min-height: 44px;
  padding: 6px 0;
}
.row-who {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  min-width: 0;
}
.row-address {
  font-size: 14px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.row-hint {
  font-size: 12px;
  line-height: 17px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.row-state {
  display: inline-flex;
  flex: 0 0 210px;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
.row-state.muted {
  color: var(--ink-2);
}
.row-state.ink {
  color: var(--ink);
}
.row-state.know {
  color: var(--know);
}
.row-state.danger {
  color: var(--danger);
}
.row-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--line-strong);
}
.check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: var(--know-soft);
  color: var(--know);
}
.check.quiet {
  background: var(--ground);
  color: var(--ink-2);
}
.track {
  stroke: var(--line);
}
.arc {
  stroke: var(--focus);
}
.spin {
  animation: import-spin 0.9s linear infinite;
}
.pulse {
  animation: import-pulse 1.6s ease-in-out infinite;
}
.row-action {
  display: flex;
  flex: 0 0 150px;
  justify-content: flex-end;
}

.list-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
}
.list-note {
  display: flex;
  flex: 1 1 320px;
  gap: 10px;
  font-size: 13px;
  line-height: 19px;
  color: var(--ink);
}
.list-note svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--ink-2);
}

.ending-card {
  padding: 20px;
}
.ending {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}
.ending-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ending-mark {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 999px;
}
.ending-mark.know {
  background: var(--know-soft);
  color: var(--know);
}
.ending-mark.quiet {
  background: var(--ground);
  color: var(--ink-2);
}
.ending-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ending-title {
  font-size: 18px;
  line-height: 24px;
  font-weight: 600;
}
.ending-sub {
  font-size: 13px;
  line-height: 19px;
  color: var(--ink-2);
}
.ending-text {
  font-size: 14px;
  line-height: 20px;
  color: var(--ink);
}
.ending-columns {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
}
.ending-column {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 4px;
}
.column-title {
  font-size: 13px;
  font-weight: 600;
}
.added {
  display: flex;
  gap: 8px;
  font-size: 13px;
  color: var(--ink);
}
.added-name {
  flex: 1;
}
.added-count {
  font: 500 12px var(--font-mono);
  color: var(--ink-2);
}
.skipped {
  font-size: 13px;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.small-note {
  font-size: 12px;
  line-height: 17px;
  color: var(--ink-2);
}
.ending-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
@keyframes import-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes import-pulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin,
  .pulse {
    animation: none;
  }
}
</style>
