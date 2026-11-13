<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  displayLink,
  meetingLinkError,
  meetingLinkProblem,
  signInProvider,
  type MailAccount,
  type MeetingDefault,
  type MeetingPreferences,
  type MeetingPreferencesUpdate,
  type ProviderFeature,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { appPill, appRows, accountKind, defaultRows, otherRow, teamsEmpty, type AppRow, type ProviderApp } from '@/calendar/meetingSettings'
import { calendarColor } from '@/calendar/look'
import AppIcon from '@/components/AppIcon.vue'
import LogoLoader from '@/components/LogoLoader.vue'
import { useAccountsStore } from '@/stores/accounts'
import { useCalendarStore } from '@/stores/calendar'
import { useMeetingAppsStore } from '@/stores/meetingApps'

/**
 * Settings, Meeting apps (build plan 5.3, V1): Google Meet and Microsoft Teams through the mail accounts already
 * connected, the user's own room link, the app each account's events start with, and whether a guest switches the link
 * on. Every control saves at once; a failed save says why under the control and puts the old value back. Zoom and Teams
 * for other calendars need the owner first and are not offered here.
 *
 * The server replaces the defaults and the switched off apps whole, so the page reads the preferences on opening and
 * again when the window comes back to the front, and builds every change from the latest answer (the store sends one
 * change after the other).
 */
const accounts = useAccountsStore()
const calendar = useCalendarStore()
const meetingApps = useMeetingAppsStore()

const loading = ref(true)
const loadError = ref<string | null>(null)
/** Errors of single controls, by control. */
const errors = reactive<Record<string, string>>({})
/** Controls whose change is on its way: a second click on them waits for the first. */
const pending = reactive(new Set<string>())
/** The desktop app opened the provider's page in the system browser; Settings, Accounts gets the answer. */
const continueInBrowser = ref(false)

const preferences = computed(() => meetingApps.preferences)

/** Plain words for a failure: the field's own message when the server named one, and no "Failed to fetch". */
function failure(error: unknown, field: string): string {
  if (error instanceof ApiError) {
    const own = error.violations[field] ?? Object.entries(error.violations).find(([path]) => path.startsWith(`${field}[`) || path.startsWith(`${field}.`))?.[1]
    return own ?? error.message
  }
  if (error instanceof TypeError) {
    return 'Tresso could not reach the server. Check your connection and try again.'
  }
  return errorMessage(error)
}

/** The id of a control's error, for aria-describedby. */
function errorId(key: string): string {
  return `meeting-error-${key.replace(/[^a-z0-9-]/gi, '-')}`
}

onMounted(async () => {
  try {
    await Promise.all([meetingApps.reload(), accounts.load()])
    linkDraft.value = meetingApps.preferences?.ownLink ?? ''
  } catch (e) {
    loadError.value = failure(e, '')
  } finally {
    loading.value = false
  }
})

// A page left open reads the preferences again when it comes back to the front: another tab or device may have
// changed them, and the next change is built from them.
function refresh(): void {
  if (document.visibilityState === 'hidden' || loading.value) return
  meetingApps.reload().catch(() => undefined)
}
onMounted(() => {
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', refresh)
})

/**
 * Saves one change, built from the preferences as they are when it is sent. On an error the control shows why under
 * itself and `revert` puts the old value back on screen. The control keeps the focus throughout.
 */
async function save(key: string, field: string, change: MeetingPreferencesUpdate | ((current: MeetingPreferences) => MeetingPreferencesUpdate), revert: () => void = () => undefined): Promise<boolean> {
  errors[key] = ''
  pending.add(key)
  try {
    await meetingApps.update(change)
    return true
  } catch (e) {
    errors[key] = failure(e, field)
    revert()
    return false
  } finally {
    pending.delete(key)
  }
}

const cards = computed(() => {
  const prefs = preferences.value
  if (prefs === null) return []
  const make = (app: ProviderApp) => {
    const rows = appRows(app, accounts.accounts, calendar.calendars, prefs)
    return { app, rows, pill: appPill(rows), empty: app === 'meet' ? 'No Google account yet' : teamsEmpty(accounts.accounts) }
  }
  return (['meet', 'teams'] as const).filter((app) => prefs.apps.includes(app)).map(make)
})

const CARD = {
  meet: {
    name: 'Google Meet',
    line: 'Uses a Google account you already connected',
    limit: 'Makes links for events on a Google calendar. The link is created together with the calendar event.',
  },
  teams: {
    name: 'Microsoft Teams',
    line: 'Uses a Microsoft 365 account you already connected',
    limit: 'Needs a work or school account. Personal Outlook accounts cannot create Teams meetings for other apps.',
  },
} as const

function rowKey(app: ProviderApp, account: MailAccount): string {
  return `${app}:${account.id}`
}

async function signIn(key: string, account: MailAccount, features?: ProviderFeature[]): Promise<void> {
  const provider = signInProvider(account)
  if (provider === null) return
  errors[key] = ''
  pending.add(key)
  try {
    if ((await accounts.openProviderSignIn(provider, account.id, features)) === 'browser') {
      continueInBrowser.value = true
    }
  } catch (e) {
    errors[key] = failure(e, '')
  } finally {
    pending.delete(key)
  }
}

/** Connect switches the app on again in Tresso, and asks for calendar access when the account never gave it. */
async function act(app: ProviderApp, row: AppRow): Promise<void> {
  const key = rowKey(app, row.account)
  if (pending.has(key)) return
  const id = row.account.id
  const without = (current: MeetingPreferences) => current.disabled.filter((entry) => !(entry.app === app && entry.mailAccountId === id))
  if (row.action === 'Disconnect') {
    await save(key, 'disabled', (current) => ({ disabled: [...without(current), { app, mailAccountId: id }] }))
    return
  }
  if (row.action === 'Reconnect') {
    await signIn(key, row.account, row.account.calendarStatus === 'not_granted' ? ['calendar'] : undefined)
    return
  }
  const off = preferences.value?.disabled.some((entry) => entry.app === app && entry.mailAccountId === id) ?? false
  if (off && !(await save(key, 'disabled', (current) => ({ disabled: without(current) })))) {
    return
  }
  if (row.account.calendarStatus === 'not_granted') {
    await signIn(key, row.account, ['calendar'])
  }
}

function initial(account: MailAccount): string {
  return (account.emailAddress[0] ?? '?').toUpperCase()
}

// The own link: saved on blur or Enter, checked by core's rule first so a wrong link sends nothing.
const linkDraft = ref('')
const savedLink = computed(() => preferences.value?.ownLink ?? '')
/** The pointer went down on Remove: the field's blur that follows must not save what was typed first. */
let removing = false

// A link read again (another tab changed it) shows in the field, unless the user is changing it there.
watch(savedLink, (now, before) => {
  if (linkDraft.value === before) linkDraft.value = now
})

async function saveLink(): Promise<void> {
  if (removing || pending.has('ownLink') || linkDraft.value === savedLink.value) {
    if (!removing && linkDraft.value === savedLink.value) errors.ownLink = ''
    return
  }
  if (linkDraft.value !== '') {
    const problem = meetingLinkProblem(linkDraft.value)
    if (problem !== null) {
      errors.ownLink = meetingLinkError(problem)
      return
    }
  }
  const before = savedLink.value
  const typed = linkDraft.value
  await save('ownLink', 'ownLink', { ownLink: typed }, () => (linkDraft.value = before))
}

async function removeLink(): Promise<void> {
  removing = false
  const before = savedLink.value
  linkDraft.value = ''
  await save('ownLink', 'ownLink', { ownLink: '' }, () => (linkDraft.value = before))
}

// The default app per account, and for every other calendar.
const rows = computed(() => (preferences.value === null ? [] : defaultRows(accounts.accounts, calendar.calendars, preferences.value)))
const notOffered = computed(() => rows.value.flatMap((row) => row.notOffered.map((text, index) => ({ key: `${row.account.id}:${index}`, text }))))
const other = computed(() => (preferences.value === null ? { options: [], value: '' } : otherRow(preferences.value)))

async function pickDefault(row: (typeof rows.value)[number] | null, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  const value = select.value as MeetingDefault
  const previous = row === null ? other.value.value : row.value
  const key = row === null ? 'default:other' : `default:${row.account.id}`
  const change = row === null ? { defaultOther: value } : (current: MeetingPreferences) => ({ defaults: { ...current.defaults, [row.account.id]: value } })
  await save(key, row === null ? 'defaultOther' : 'defaults', change, () => (select.value = previous))
}

async function toggleGuests(event: Event): Promise<void> {
  const box = event.target as HTMLInputElement
  const value = box.checked
  await save('addWithGuests', 'addWithGuests', { addWithGuests: value }, () => (box.checked = !value))
}
</script>

<template>
  <section class="meeting-apps" aria-labelledby="meeting-apps-title">
    <header class="header">
      <div class="title-row">
        <h2 id="meeting-apps-title">Meeting apps</h2>
        <span class="auto">Saved automatically</span>
      </div>
      <p class="lead">The apps Tresso may create meeting links with, and which one each calendar uses.</p>
    </header>

    <p v-if="loading" class="state" role="status"><LogoLoader /> Loading…</p>
    <p v-else-if="loadError || !preferences" class="form-error" role="alert">{{ loadError ?? 'The meeting apps could not be loaded.' }}</p>

    <template v-else>
      <p v-if="continueInBrowser" class="hint" role="status">Continue in your browser. Tresso shows the result under Accounts once you have signed in.</p>

      <section class="block" aria-labelledby="apps-title">
        <h3 id="apps-title">Apps</h3>
        <p class="lead">Tresso creates the link when you save an event. Guests join from the invitation, no Tresso account needed.</p>

        <article v-for="card in cards" :key="card.app" class="card" :aria-labelledby="`card-${card.app}`">
          <div class="card-head">
            <span class="card-icon" aria-hidden="true"><AppIcon name="video" :size="18" /></span>
            <span class="card-name">
              <h4 :id="`card-${card.app}`">{{ CARD[card.app].name }}</h4>
              <span class="sub">{{ CARD[card.app].line }}</span>
            </span>
            <span class="pill" :class="card.pill.tone">
              <AppIcon v-if="card.pill.tone === 'ok'" name="check" :size="13" />
              <AppIcon v-else-if="card.pill.tone === 'warn'" name="alert" :size="13" />
              {{ card.pill.text }}
            </span>
          </div>
          <ul class="rows">
            <li v-if="card.rows.length === 0" class="row">
              <span class="who"><span class="address">{{ card.empty }}</span></span>
              <RouterLink :to="{ name: 'settings-accounts-new' }" class="button button-quiet">Add an account</RouterLink>
            </li>
            <li v-for="row in card.rows" :key="row.account.id" class="row">
              <span class="mark" aria-hidden="true">{{ initial(row.account) }}</span>
              <span class="who">
                <span class="address">{{ row.account.emailAddress }}</span>
                <span class="status" :class="{ warn: row.state === 'expired' }">{{ row.status }}</span>
              </span>
              <button
                type="button"
                class="button"
                :class="row.action === 'Disconnect' ? 'button-quiet' : 'button-primary'"
                :aria-label="`${row.action} ${CARD[card.app].name} for ${row.account.emailAddress}`"
                :aria-describedby="errors[rowKey(card.app, row.account)] ? errorId(rowKey(card.app, row.account)) : undefined"
                @click="act(card.app, row)"
              >
                {{ row.action }}
              </button>
              <p v-if="errors[rowKey(card.app, row.account)]" :id="errorId(rowKey(card.app, row.account))" class="error" role="alert">{{ errors[rowKey(card.app, row.account)] }}</p>
            </li>
          </ul>
          <p class="limit">{{ CARD[card.app].limit }}</p>
        </article>

        <article v-if="preferences.apps.includes('own')" class="card" aria-labelledby="card-own">
          <div class="card-head">
            <span class="card-icon" aria-hidden="true"><AppIcon name="link" :size="18" /></span>
            <span class="card-name">
              <h4 id="card-own">My own link</h4>
              <span class="sub">A fixed room link you paste</span>
            </span>
            <span class="pill" :class="savedLink ? 'ok' : 'plain'">
              <AppIcon v-if="savedLink" name="check" :size="13" />
              {{ savedLink ? 'Link set' : 'No link yet' }}
            </span>
          </div>
          <div class="field">
            <label class="label" for="own-link">Your room link</label>
            <span class="link-input">
              <input
                id="own-link"
                v-model="linkDraft"
                type="url"
                inputmode="url"
                placeholder="https://"
                dir="ltr"
                autocomplete="off"
                spellcheck="false"
                :title="savedLink ? displayLink(savedLink) : undefined"
                :aria-invalid="errors.ownLink ? 'true' : undefined"
                :aria-describedby="errors.ownLink ? errorId('ownLink') : undefined"
                @blur="saveLink"
                @keydown.enter.prevent="saveLink"
              />
              <button v-if="savedLink" type="button" class="button button-quiet" aria-label="Remove your room link" @pointerdown="removing = true" @click="removeLink">Remove</button>
            </span>
          </div>
          <p v-if="errors.ownLink" :id="errorId('ownLink')" class="error" role="alert">{{ errors.ownLink }}</p>
          <p class="limit">Works with every calendar. Every event gets this same link, so anyone who has it can enter the room.</p>
        </article>
      </section>

      <section class="block" aria-labelledby="default-title">
        <h3 id="default-title">Default app</h3>
        <p class="lead">The app a new event starts with. You can pick another one per event.</p>
        <table class="defaults">
          <thead>
            <tr>
              <th scope="col">Events in</th>
              <th scope="col">Meeting link with</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.account.id">
              <th scope="row">
                <span class="swatch" :style="calendarColor(row.calendar)" aria-hidden="true"></span>
                <span class="who">
                  <span class="address">{{ row.account.displayName }}</span>
                  <span class="status">{{ row.account.emailAddress }}, {{ accountKind(row.account, calendar.calendars) }}</span>
                </span>
              </th>
              <td>
                <label class="visually-hidden" :for="`default-${row.account.id}`">Meeting app for {{ row.account.displayName }}</label>
                <select
                  :id="`default-${row.account.id}`"
                  :value="row.value"
                  :aria-invalid="errors[`default:${row.account.id}`] ? 'true' : undefined"
                  :aria-describedby="errors[`default:${row.account.id}`] ? errorId(`default:${row.account.id}`) : undefined"
                  @change="pickDefault(row, $event)"
                >
                  <option v-if="row.value === ''" value="" disabled>Not set</option>
                  <option v-for="option in row.options" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <p v-if="errors[`default:${row.account.id}`]" :id="errorId(`default:${row.account.id}`)" class="error" role="alert">{{ errors[`default:${row.account.id}`] }}</p>
              </td>
            </tr>
            <tr>
              <th scope="row">
                <span class="swatch outline" aria-hidden="true"></span>
                <span class="who">
                  <span class="address">Every other calendar</span>
                  <span class="status">Calendars without an app of their own, such as one you add later</span>
                </span>
              </th>
              <td>
                <label class="visually-hidden" for="default-other">Meeting app for every other calendar</label>
                <select
                  id="default-other"
                  :value="other.value"
                  :aria-invalid="errors['default:other'] ? 'true' : undefined"
                  :aria-describedby="errors['default:other'] ? errorId('default:other') : undefined"
                  @change="pickDefault(null, $event)"
                >
                  <option v-if="other.value === ''" value="" disabled>Not set</option>
                  <option v-for="option in other.options" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <p v-if="errors['default:other']" :id="errorId('default:other')" class="error" role="alert">{{ errors['default:other'] }}</p>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-for="line in notOffered" :key="line.key" class="limit not-offered">{{ line.text }}</p>

        <label class="toggle">
          <input
            type="checkbox"
            role="switch"
            :checked="preferences.addWithGuests"
            :aria-invalid="errors.addWithGuests ? 'true' : undefined"
            :aria-describedby="errors.addWithGuests ? `guests-hint ${errorId('addWithGuests')}` : 'guests-hint'"
            @change="toggleGuests"
          />
          <span>
            <span class="toggle-label">Add a meeting link when I invite guests</span>
            <span id="guests-hint" class="hint">
              {{ preferences.addWithGuests ? 'The link switches on when you add the first guest. Events without guests start without one.' : 'Events start without a link. You switch it on per event.' }}
            </span>
          </span>
        </label>
        <p v-if="errors.addWithGuests" :id="errorId('addWithGuests')" class="error" role="alert">{{ errors.addWithGuests }}</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.meeting-apps {
  display: flex;
  flex-direction: column;
  gap: 24px;
  max-width: 720px;
}
.title-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.header h2 {
  margin: 0 0 6px;
  font: 700 22px/28px var(--font-display);
}
.auto {
  color: var(--ink-3);
  font-size: 13px;
}
.lead,
.state,
.hint {
  margin: 0;
  color: var(--ink-2);
  line-height: 21px;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.block h3 {
  margin: 0;
  font: 600 16px/22px var(--font-ui);
}
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--paper);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.card-icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--ground);
  color: var(--ink);
}
.card-name {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.card-name h4 {
  margin: 0;
  font: 600 14px/20px var(--font-ui);
}
.sub,
.status {
  color: var(--ink-2);
  font-size: 13px;
}
.status.warn {
  color: var(--delegate);
}
.pill {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.pill.ok {
  background: var(--know-soft);
  color: var(--know);
}
.pill.warn {
  background: var(--delegate-soft);
  color: var(--delegate);
}
.pill.plain {
  background: var(--ground);
  color: var(--ink-2);
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.mark {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--ground);
  font: 600 12px var(--font-ui);
}
.who {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.address {
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row .error {
  flex-basis: 100%;
}
.limit {
  margin: 0;
  color: var(--ink-3);
  font-size: 13px;
  line-height: 19px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label {
  font-size: 13px;
  font-weight: 600;
}
.link-input {
  display: flex;
  gap: 8px;
}
.link-input input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  unicode-bidi: isolate;
}
.defaults {
  width: 100%;
  border-collapse: collapse;
}
.defaults th,
.defaults td {
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: middle;
}
.defaults thead th {
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 600;
}
.defaults tbody th {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: normal;
}
.defaults select {
  width: 100%;
  max-width: 280px;
}
.swatch {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: var(--cal);
}
.swatch.outline {
  border: 1px dashed var(--line-strong);
  background: transparent;
}
.toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.toggle input {
  width: 18px;
  height: 18px;
  margin: 2px 0 0;
}
.toggle > span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.toggle-label {
  font-weight: 600;
}
.toggle .hint {
  font-size: 13px;
}
.error,
.form-error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
</style>
