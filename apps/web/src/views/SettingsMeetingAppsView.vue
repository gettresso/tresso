<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  defaultMeetingApp,
  displayLink,
  meetingChoices,
  meetingLinkError,
  meetingLinkProblem,
  signInProvider,
  type MailAccount,
  type MeetingDefault,
  type MeetingPreferences,
  type MeetingPreferencesUpdate,
  type ProviderFeature,
} from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { appPill, appRows, accountKind, defaultRows, otherOptions, type AppRow, type ProviderApp } from '@/calendar/meetingSettings'
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
 */
const accounts = useAccountsStore()
const calendar = useCalendarStore()
const meetingApps = useMeetingAppsStore()

const loading = ref(true)
const loadError = ref<string | null>(null)
/** Errors of single controls, by control. */
const errors = reactive<Record<string, string>>({})
const busy = ref<string | null>(null)
/** The desktop app opened the provider's page in the system browser; Settings, Accounts gets the answer. */
const continueInBrowser = ref(false)

const preferences = computed(() => meetingApps.preferences)

onMounted(async () => {
  try {
    await Promise.all([meetingApps.ensureLoaded(), accounts.load()])
    linkDraft.value = meetingApps.preferences?.ownLink ?? ''
  } catch (e) {
    loadError.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})

/** Saves one change; on an error the control shows it and `revert` puts the old value back on screen. */
async function save(key: string, patch: MeetingPreferencesUpdate, revert: () => void = () => undefined): Promise<boolean> {
  errors[key] = ''
  busy.value = key
  try {
    await meetingApps.update(patch)
    return true
  } catch (e) {
    errors[key] = errorMessage(e)
    revert()
    return false
  } finally {
    busy.value = null
  }
}

const cards = computed(() => {
  const prefs = preferences.value
  if (prefs === null) return []
  const make = (app: ProviderApp) => {
    const rows = appRows(app, accounts.accounts, calendar.calendars, prefs)
    return { app, rows, pill: appPill(rows) }
  }
  return (['meet', 'teams'] as const).filter((app) => prefs.apps.includes(app)).map(make)
})

const CARD = {
  meet: {
    name: 'Google Meet',
    line: 'Uses a Google account you already connected',
    limit: 'Makes links for events on a Google calendar. The link is created together with the calendar event.',
    empty: 'No Google account yet',
  },
  teams: {
    name: 'Microsoft Teams',
    line: 'Uses a Microsoft 365 account you already connected',
    limit: 'Needs a work or school account. Personal Outlook accounts cannot create Teams meetings for other apps.',
    empty: 'No Microsoft 365 account yet',
  },
} as const

function rowKey(app: ProviderApp, account: MailAccount): string {
  return `${app}:${account.id}`
}

async function signIn(key: string, account: MailAccount, features?: ProviderFeature[]): Promise<void> {
  const provider = signInProvider(account)
  if (provider === null) return
  errors[key] = ''
  busy.value = key
  try {
    if ((await accounts.openProviderSignIn(provider, account.id, features)) === 'browser') {
      continueInBrowser.value = true
    }
  } catch (e) {
    errors[key] = errorMessage(e)
  } finally {
    busy.value = null
  }
}

/** Connect switches the app on again in Tresso, and asks for calendar access when the account never gave it. */
async function act(app: ProviderApp, row: AppRow): Promise<void> {
  const prefs = preferences.value
  if (prefs === null) return
  const key = rowKey(app, row.account)
  const others = prefs.disabled.filter((entry) => !(entry.app === app && entry.mailAccountId === row.account.id))
  if (row.action === 'Disconnect') {
    await save(key, { disabled: [...others, { app, mailAccountId: row.account.id }] })
    return
  }
  if (row.action === 'Reconnect') {
    await signIn(key, row.account, row.account.calendarStatus === 'not_granted' ? ['calendar'] : undefined)
    return
  }
  if (others.length !== prefs.disabled.length && !(await save(key, { disabled: others }))) {
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

async function saveLink(): Promise<void> {
  if (busy.value === 'ownLink' || linkDraft.value === savedLink.value) {
    errors.ownLink = ''
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
  await save('ownLink', { ownLink: linkDraft.value }, () => (linkDraft.value = before))
}

async function removeLink(): Promise<void> {
  const before = savedLink.value
  linkDraft.value = ''
  await save('ownLink', { ownLink: '' }, () => (linkDraft.value = before))
}

// The default app per account, and for every other calendar.
const rows = computed(() => (preferences.value === null ? [] : defaultRows(accounts.accounts, calendar.calendars, preferences.value)))
const notOffered = computed(() => rows.value.flatMap((row) => row.notOffered))
const otherChoices = computed(() => (preferences.value === null ? [] : otherOptions(meetingChoices(undefined, null, preferences.value))))

/** What a row's select shows: the saved choice, else what applies anyway; empty when that is not one of its options. */
function shownValue(row: (typeof rows.value)[number], prefs: MeetingPreferences): string {
  const value = row.saved ?? defaultMeetingApp(row.calendar, row.account, prefs) ?? 'none'
  return row.options.some((option) => option.value === value) ? value : ''
}

const otherValue = computed(() => {
  const prefs = preferences.value
  if (prefs === null) return ''
  const value = prefs.defaultOther ?? (prefs.ownLink !== null && meetingLinkProblem(prefs.ownLink) === null ? 'own' : 'none')
  return otherChoices.value.some((option) => option.value === value) ? value : ''
})

async function pickDefault(row: (typeof rows.value)[number] | null, event: Event): Promise<void> {
  const prefs = preferences.value
  if (prefs === null) return
  const select = event.target as HTMLSelectElement
  const value = select.value as MeetingDefault
  const previous = row === null ? otherValue.value : shownValue(row, prefs)
  const patch: MeetingPreferencesUpdate = row === null ? { defaultOther: value } : { defaults: { ...prefs.defaults, [row.account.id]: value } }
  await save(row === null ? 'default:other' : `default:${row.account.id}`, patch, () => (select.value = previous))
}

async function toggleGuests(event: Event): Promise<void> {
  const box = event.target as HTMLInputElement
  const value = box.checked
  await save('addWithGuests', { addWithGuests: value }, () => (box.checked = !value))
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
              <span class="who"><span class="address">{{ CARD[card.app].empty }}</span></span>
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
                :disabled="busy !== null"
                :aria-label="`${row.action} ${CARD[card.app].name} for ${row.account.emailAddress}`"
                @click="act(card.app, row)"
              >
                {{ row.action }}
              </button>
              <p v-if="errors[rowKey(card.app, row.account)]" class="error" role="alert">{{ errors[rowKey(card.app, row.account)] }}</p>
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
          <label class="field" for="own-link">
            <span class="label">Your room link</span>
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
                :aria-describedby="errors.ownLink ? 'own-link-error' : undefined"
                @blur="saveLink"
                @keydown.enter.prevent="saveLink"
              />
              <button v-if="savedLink" type="button" class="button button-quiet" :disabled="busy !== null" @click="removeLink">Remove</button>
            </span>
          </label>
          <p v-if="errors.ownLink" id="own-link-error" class="error" role="alert">{{ errors.ownLink }}</p>
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
                  <span class="status">{{ row.account.emailAddress }}, {{ accountKind(row.account) }}</span>
                </span>
              </th>
              <td>
                <label class="visually-hidden" :for="`default-${row.account.id}`">Meeting app for {{ row.account.displayName }}</label>
                <select :id="`default-${row.account.id}`" :value="shownValue(row, preferences)" :disabled="busy !== null" @change="pickDefault(row, $event)">
                  <option v-if="shownValue(row, preferences) === ''" value="" disabled>Not set</option>
                  <option v-for="option in row.options" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <p v-if="errors[`default:${row.account.id}`]" class="error" role="alert">{{ errors[`default:${row.account.id}`] }}</p>
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
                <select id="default-other" :value="otherValue" :disabled="busy !== null" @change="pickDefault(null, $event)">
                  <option v-if="otherValue === ''" value="" disabled>Not set</option>
                  <option v-for="option in otherChoices" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <p v-if="errors['default:other']" class="error" role="alert">{{ errors['default:other'] }}</p>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-for="line in notOffered" :key="line" class="limit not-offered">{{ line }}</p>

        <label class="toggle">
          <input type="checkbox" role="switch" :checked="preferences.addWithGuests" :disabled="busy !== null" aria-describedby="guests-hint" @change="toggleGuests" />
          <span>
            <span class="toggle-label">Add a meeting link when I invite guests</span>
            <span id="guests-hint" class="hint">
              {{ preferences.addWithGuests ? 'The link switches on when you add the first guest. Events without guests start without one.' : 'Events start without a link. You switch it on per event.' }}
            </span>
          </span>
        </label>
        <p v-if="errors.addWithGuests" class="error" role="alert">{{ errors.addWithGuests }}</p>
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
