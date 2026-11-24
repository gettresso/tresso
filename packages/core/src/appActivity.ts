/** Wire format of /api/v1/app-activity, and the words the Apps pages make from it. */

export type AppActivityKind = 'read' | 'change' | 'send'
export type AppActivityResult = 'done' | 'refused' | 'failed'
export type AppActivityChannel = 'mcp' | 'api'
export type AppActivityPeriod = '24h' | '7d' | '30d' | '90d'

/** An app of the log: a connected app (`client`) or a personal access token (`token`). */
export interface AppActivityApp {
  /** `client:<client id>` or `token:<id>`, as connected apps and tokens carry it in `activityKey`. */
  key: string
  type: 'client' | 'token'
  /** Null once the app or the token is gone. */
  name: string | null
}

/** One thing an app did. It holds no content: only titles, kinds and ids. */
export interface AppActivityEntry {
  id: string
  occurredAt: string
  app: AppActivityApp & { connectedAppId: string | null; personalAccessTokenId: string | null }
  channel: AppActivityChannel
  /** `name` is the tool name or `METHOD /api/v1/route/{id}`; `title` says it in words. */
  action: { name: string; title: string }
  kind: AppActivityKind
  result: AppActivityResult
  reason: { code: string; label: string; sentence: string } | null
  durationMs: number
  /** Each permission the action needed, and whether the app holds it now. */
  permissions: { scope: string; label: string; held: boolean }[]
  /** `several`: repeats of this entry touched different objects, of which none is kept. */
  object: { type: string; label: string; list: boolean; id: string | null; several: boolean } | null
  /** When the last repeat happened; the same as occurredAt for an entry that happened once. */
  lastOccurredAt: string
  /** How many times the same thing happened within a minute (an hour for a refused token), counted on this entry. */
  count: number
}

export interface AppActivityPage {
  items: AppActivityEntry[]
  nextCursor: string | null
  /** The apps for the app filter: connected or with a token now, and those with entries in the period. */
  apps: AppActivityApp[]
  /** The log holds nothing at all, whatever the filters. */
  empty: boolean
}

/** A filter left out, or undefined, is not applied. */
export interface AppActivityQuery {
  period?: AppActivityPeriod | undefined
  app?: string | undefined
  kind?: AppActivityKind | undefined
  result?: AppActivityResult | undefined
  limit?: number | undefined
  cursor?: string | undefined
}

/** The query string of a page of the log; what is left out is not filtered. */
export function appActivityPath(query: AppActivityQuery): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(name, String(value))
  }
  const search = params.toString()
  return `/api/v1/app-activity${search === '' ? '' : `?${search}`}`
}

/**
 * The permissions an AI assistant can have, in the order the AI assistants page lists them, with the words of the
 * consent screen (Scope::label() and Scope::description()). The teams, webhooks and sync scopes are left out: such an
 * app cannot hold them.
 */
export const ASSISTANT_SCOPES: readonly { value: string; label: string; description: string }[] = [
  { value: 'mail:read', label: 'Read mail', description: 'Read your messages, conversations, attachments and drafts in every account.' },
  { value: 'mail:write', label: 'Organize mail', description: 'Archive, move, flag, mark as read and delete messages.' },
  { value: 'mail:send', label: 'Send mail', description: 'Send messages from your accounts, in your name.' },
  { value: 'todos:read', label: 'See todos', description: 'See your todos and when they are planned.' },
  { value: 'todos:write', label: 'Change todos', description: 'Add, complete, change and delete todos.' },
  { value: 'calendar:read', label: 'See calendar', description: 'See your calendars and events, with their guests, your notes and reminders.' },
  { value: 'calendar:write', label: 'Change calendar', description: 'Add, change and delete events and set your answers. Telling guests or organizers also needs Send mail.' },
  { value: 'settings:read', label: 'See settings', description: 'See your mail accounts, smart inboxes and other settings.' },
  { value: 'settings:write', label: 'Change settings', description: 'Change settings such as account names, smart inboxes, rules and notifications. Never how a mail account connects, access tokens or connected apps.' },
  { value: 'signatures:read', label: 'See signatures', description: 'See your email signatures.' },
  { value: 'signatures:write', label: 'Change signatures', description: 'Add, change and delete email signatures.' },
  { value: 'chat:read', label: 'Read your WhatsApp chats', description: 'Read the WhatsApp chats and messages your Mac passes on to Tresso, and the replies waiting to go out.' },
  { value: 'chat:send', label: 'Send WhatsApp messages as you', description: 'Write replies in your WhatsApp chats; your Mac sends them from your WhatsApp.' },
]

/** `a`, `a and b`, `a, b and c`. */
function words(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * What an assistant may do, in one line made from its permissions: "May read mail, change todos and signatures, and
 * change settings." Changing something includes seeing it. Areas with the same verb next to each other share it,
 * except settings, which always stand on their own. Null when every permission is switched off.
 */
export function permissionLine(scopes: readonly string[]): string | null {
  const has = (scope: string) => scopes.includes(scope)
  const phrases: { verb: string; noun: string; alone?: boolean }[] = []
  const mail = [has('mail:read') && 'read', has('mail:write') && 'organize', has('mail:send') && 'send'].filter((verb): verb is string => verb !== false)
  if (mail.length > 0) phrases.push({ verb: words(mail), noun: 'mail' })
  for (const [area, noun] of [
    ['todos', 'todos'],
    ['calendar', 'calendar'],
    ['signatures', 'signatures'],
    ['settings', 'settings'],
  ] as const) {
    if (has(`${area}:write`)) phrases.push({ verb: 'change', noun, alone: area === 'settings' })
    else if (has(`${area}:read`)) phrases.push({ verb: 'see', noun, alone: area === 'settings' })
  }
  if (has('chat:read')) phrases.push({ verb: 'read', noun: 'WhatsApp chats' })
  if (has('chat:send')) phrases.push({ verb: 'send', noun: 'WhatsApp messages' })
  if (phrases.length === 0) return null

  const merged: { verb: string; nouns: string[]; alone: boolean }[] = []
  for (const phrase of phrases) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.verb === phrase.verb && !last.alone && phrase.alone !== true) {
      last.nouns.push(phrase.noun)
    } else {
      merged.push({ verb: phrase.verb, nouns: [phrase.noun], alone: phrase.alone === true })
    }
  }
  const parts = merged.map((part) => `${part.verb} ${words(part.nouns)}`)
  const line = parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
  return `May ${line}.`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (value: number) => String(value).padStart(2, '0')

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** `2 Sep`, in the reader's time zone; with the year (`2 Sep 2025`) when `now` is given and in another year. */
export function shortDay(at: Date, now?: Date): string {
  const day = `${at.getDate()} ${MONTHS[at.getMonth()]}`
  return now !== undefined && now.getFullYear() !== at.getFullYear() ? `${day} ${at.getFullYear()}` : day
}

/** The log's time: `10:38:12` today, `19 Oct 16:40:11` before. */
export function activityTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  const time = `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
  return sameDay(at, now) ? time : `${shortDay(at)} ${time}`
}

/** Recent activity's time: `10:38` today, `19 Oct` before. */
export function recentTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  return sameDay(at, now) ? `${two(at.getHours())}:${two(at.getMinutes())}` : shortDay(at)
}

/** `84 ms`, `1.2 s`. */
export function durationText(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** `Active 4 min ago`, `Active 1 h ago`, `Idle for 21 days`; null when never used. */
export function activeText(iso: string | null, now: Date = new Date()): string | null {
  if (iso === null) return null
  const minutes = Math.max(1, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `Active ${minutes} min ago`
  if (minutes < 24 * 60) return `Active ${Math.floor(minutes / 60)} h ago`
  const days = Math.floor(minutes / (24 * 60))
  return `Idle for ${days} ${days === 1 ? 'day' : 'days'}`
}

/** The labels of the kinds and results, as the log shows them. */
export const ACTIVITY_KIND_LABELS: Record<AppActivityKind, string> = { read: 'Read', change: 'Change', send: 'Send' }
export const ACTIVITY_RESULT_LABELS: Record<AppActivityResult, string> = { done: 'Done', refused: 'Refused', failed: 'Failed' }

/** Recent activity's line: the title, and `, refused` or `, failed` after one that did not go through. */
export function recentText(entry: Pick<AppActivityEntry, 'action' | 'result'>): string {
  return entry.result === 'done' ? entry.action.title : `${entry.action.title}, ${entry.result}`
}

/** Recent activity's tool line: the name, with the reason after one that did not go through. */
export function recentTool(entry: Pick<AppActivityEntry, 'action' | 'reason'>): string {
  return entry.reason === null ? entry.action.name : `${entry.action.name} (${entry.reason.label.toLowerCase()})`
}

/** The name of an entry's app; an app or token that is gone is named so. */
export function activityAppName(app: Pick<AppActivityApp, 'type' | 'name'>): string {
  return app.name ?? (app.type === 'token' ? 'A removed token' : 'A removed app')
}

/** "Permission used": each label, with `, off for <app>` after one the app does not hold now. */
export function permissionUsed(entry: Pick<AppActivityEntry, 'permissions' | 'app'>): { label: string; scopes: string } {
  if (entry.permissions.length === 0) return { label: 'None needed', scopes: '' }
  const app = activityAppName(entry.app)
  return {
    label: entry.permissions.map((permission) => (permission.held ? permission.label : `${permission.label}, off for ${app}`)).join(' and '),
    scopes: entry.permissions.map((permission) => permission.scope).join(' '),
  }
}

/**
 * "What it touched": the kind, and the id or why there is none. "Nothing was ..." only for an action that did not go
 * through; one that went through without touching an object has no line at all (null).
 */
export function touched(entry: Pick<AppActivityEntry, 'object' | 'kind' | 'result'>): { label: string; id: string } | null {
  const nothing = { read: 'read', change: 'changed', send: 'sent' }[entry.kind]
  if (entry.object === null) return entry.result === 'done' ? null : { label: 'Nothing', id: `No id. Nothing was ${nothing}.` }
  if (entry.object.id !== null) return { label: entry.object.label, id: entry.object.id }
  if (entry.object.several) return { label: entry.object.label, id: 'Several, not kept one by one' }
  if (entry.result !== 'done') return { label: entry.object.label, id: `No id. Nothing was ${nothing}.` }
  return { label: entry.object.label, id: entry.object.list ? 'No id. A list has none.' : 'No id.' }
}

/** For an entry that happened more than once: `First at 10:38:12, last at 10:38:55`; null for once. */
export function repeatSpan(entry: Pick<AppActivityEntry, 'count' | 'occurredAt' | 'lastOccurredAt'>, now: Date = new Date()): string | null {
  return entry.count > 1 ? `First at ${activityTime(entry.occurredAt, now)}, last at ${activityTime(entry.lastOccurredAt, now)}` : null
}

/** How often an entry happened: `3 times`, or null for once. */
export function timesText(count: number): string | null {
  return count > 1 ? `${count} times` : null
}
