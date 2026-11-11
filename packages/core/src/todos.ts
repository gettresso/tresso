/** Wire format of /api/v1/todos and /api/v1/messages/{id}/todo, and helpers to show todos. */

import type { SyncedMessage, SyncedTodo } from './sync/types'

export type Todo = SyncedTodo

export interface NewTodo {
  title: string
  notes?: string
  /** YYYY-MM-DD. */
  dueDate?: string | null
  /** HH:MM; only with a due date. */
  dueTime?: string | null
  durationMinutes?: number | null
}

/**
 * A todo made from an email; the title defaults to its subject. Making one again returns the one it has. With
 * `perConversation`, an open todo of another email of the conversation is returned instead of making one (triage).
 */
export type MakeTodoRequest = Partial<NewTodo> & { perConversation?: boolean }

/** The answer to making a todo from an email: the todo, and whether this request made it (false: the one there was). */
export type MadeTodo = Todo & { made: boolean }

/** JSON merge patch: omitted fields stay as they are; null clears the due date, the due time or the duration. */
export interface TodoUpdate {
  title?: string
  notes?: string
  dueDate?: string | null
  dueTime?: string | null
  durationMinutes?: number | null
  done?: boolean
  position?: number
}

/** Mirrors the API's limits (Todo::TITLE_MAX_LENGTH, NOTES_MAX_LENGTH, DURATION_MAX_MINUTES). */
export const TODO_TITLE_MAX_LENGTH = 500
export const TODO_NOTES_MAX_LENGTH = 10_000
export const TODO_DURATION_MAX_MINUTES = 7 * 24 * 60

/**
 * The email of a conversation to make a todo from: the newest one someone else sent, which is what the conversation
 * asks of the user; the newest one when the user wrote them all. `messages` go oldest first; `ownAddresses` are the
 * addresses of the user's accounts.
 */
export function todoSourceMessage(messages: SyncedMessage[], ownAddresses: string[]): SyncedMessage | null {
  const own = new Set(ownAddresses.map((address) => address.toLowerCase()))
  const incoming = messages.filter((message) => !own.has(message.from.address.toLowerCase()))
  return incoming[incoming.length - 1] ?? messages[messages.length - 1] ?? null
}

/** Open todos in the user's order, then done ones, most recently done first. The same order as the API's list. */
export function compareTodos(a: Todo, b: Todo): number {
  if ((a.completedAt === null) !== (b.completedAt === null)) {
    return a.completedAt === null ? -1 : 1
  }
  if (a.completedAt !== null && b.completedAt !== null && a.completedAt !== b.completedAt) {
    return Date.parse(b.completedAt) - Date.parse(a.completedAt)
  }
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

export type TodoSection = 'overdue' | 'today' | 'thisWeek' | 'later' | 'done'

export const TODO_SECTION_LABELS: Record<TodoSection, string> = {
  overdue: 'Overdue',
  today: 'Today',
  thisWeek: 'This week',
  later: 'Later',
  done: 'Done',
}

const SECTION_ORDER: TodoSection[] = ['overdue', 'today', 'thisWeek', 'later', 'done']

/** A day as YYYY-MM-DD in the device's time zone. */
export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** A time as HH:MM in the device's time zone. */
export function localTime(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * Where a todo goes in the list: done; overdue (its day has passed, or its time today has); today; this week (up to
 * and including Sunday); or later, which also holds todos without a date.
 */
export function todoSection(todo: Todo, now: Date): TodoSection {
  if (todo.completedAt !== null) {
    return 'done'
  }
  if (todo.dueDate === null) {
    return 'later'
  }
  const today = localDate(now)
  if (todo.dueDate < today || (todo.dueDate === today && todo.dueTime !== null && todo.dueTime < localTime(now))) {
    return 'overdue'
  }
  if (todo.dueDate === today) {
    return 'today'
  }
  return todo.dueDate <= localDate(endOfWeek(now)) ? 'thisWeek' : 'later'
}

/** The todos by section, in list order; sections without todos are left out. */
export function groupTodos(todos: Todo[], now: Date): { section: TodoSection; label: string; todos: Todo[] }[] {
  const bySection = new Map<TodoSection, Todo[]>()
  for (const todo of [...todos].sort(compareTodos)) {
    const section = todoSection(todo, now)
    bySection.set(section, [...(bySection.get(section) ?? []), todo])
  }
  return SECTION_ORDER.filter((section) => bySection.has(section)).map((section) => ({ section, label: TODO_SECTION_LABELS[section], todos: bySection.get(section)! }))
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * When a todo is due, in words: "Today 17:00", "Tomorrow", "Yesterday", "Fri 24 Oct", or with the year when it is not
 * this year. A done todo says when it was done ("Done today"). Null for an open todo without a date.
 */
export function dueLabel(todo: Pick<Todo, 'dueDate' | 'dueTime' | 'completedAt'>, now: Date): string | null {
  if (todo.completedAt !== null) {
    return `Done ${dayWords(localDate(new Date(todo.completedAt)), now).toLowerCase()}`
  }
  if (todo.dueDate === null) {
    return null
  }
  const day = dayWords(todo.dueDate, now)
  return todo.dueTime === null ? day : `${day} ${todo.dueTime}`
}

function dayWords(date: string, now: Date): string {
  const offset = daysBetween(localDate(now), date)
  if (offset === 0) {
    return 'Today'
  }
  if (offset === 1) {
    return 'Tomorrow'
  }
  if (offset === -1) {
    return 'Yesterday'
  }
  const day = parseDate(date)
  const label = `${WEEKDAYS[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]}`
  return day.getFullYear() === now.getFullYear() ? label : `${label} ${day.getFullYear()}`
}

/** What the user typed in the quick-add field: the title, and the date and time found in it. */
export interface QuickAdd {
  title: string
  dueDate: string | null
  dueTime: string | null
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/**
 * Finds a day and a time in a quick-add line, like "Call Anna friday", "Send slides tomorrow 9:00" or "Pay rent 27
 * oct", and takes them out of the title. A weekday is the next one (today counts); a day of a month that has passed
 * this year is next year's. A time without a day is today's, or tomorrow's when it has passed. Only the last day and
 * time in the line count; anything else stays in the title.
 */
export function parseQuickAdd(text: string, now: Date): QuickAdd {
  let rest = ` ${text.trim()} `
  let dueDate: string | null = null
  let dueTime: string | null = null

  const time = lastMatch(rest, /\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s)/gi, (match) => match[2] !== undefined || match[3] !== undefined)
  if (time !== null) {
    const hours = toHours(Number(time[1]), time[3]?.toLowerCase())
    const minutes = Number(time[2] ?? '0')
    if (hours !== null && minutes < 60) {
      dueTime = `${pad(hours)}:${pad(minutes)}`
      rest = cut(rest, time)
    }
  }

  const monthPattern = MONTH_NAMES.map((name) => `${name.slice(0, 3)}(?:${name.slice(3)})?`).join('|')
  const dayMonth = lastMatch(rest, new RegExp(`\\s(?:on\\s+)?(?:(\\d{1,2})\\s+(${monthPattern})|(${monthPattern})\\s+(\\d{1,2}))(?=\\s)`, 'gi'))
  // Full names only: "sun" or "sat" in a title is more likely a word than a day.
  const weekday = lastMatch(rest, new RegExp(`\\s(?:on\\s+|next\\s+)?(${WEEKDAY_NAMES.join('|')})(?=\\s)`, 'gi'))
  const relative = lastMatch(rest, /\s(today|tonight|tomorrow)(?=\s)/gi)
  const found = [dayMonth, weekday, relative].filter((match) => match !== null).sort((a, b) => b.index - a.index)[0] ?? null

  if (found === dayMonth && dayMonth !== null) {
    const day = Number(dayMonth[1] ?? dayMonth[4])
    const month = monthIndex(dayMonth[2] ?? dayMonth[3] ?? '')
    const date = nextDayOfMonth(day, month, now)
    if (date !== null) {
      dueDate = date
      rest = cut(rest, dayMonth)
    }
  } else if (found === weekday && weekday !== null) {
    const target = WEEKDAY_NAMES.indexOf((weekday[1] ?? '').toLowerCase())
    dueDate = localDate(addDays(now, (target - now.getDay() + 7) % 7))
    rest = cut(rest, weekday)
  } else if (found === relative && relative !== null) {
    dueDate = localDate(addDays(now, relative[1]?.toLowerCase() === 'tomorrow' ? 1 : 0))
    rest = cut(rest, relative)
  }

  if (dueTime !== null && dueDate === null) {
    dueDate = localDate(dueTime > localTime(now) ? now : addDays(now, 1))
  }

  return { title: rest.replace(/\s+/g, ' ').trim(), dueDate, dueTime }
}

function lastMatch(text: string, pattern: RegExp, accept: (match: RegExpExecArray) => boolean = () => true): RegExpExecArray | null {
  let last: RegExpExecArray | null = null
  for (const match of text.matchAll(pattern)) {
    if (accept(match)) {
      last = match
    }
  }
  return last
}

function cut(text: string, match: RegExpExecArray): string {
  return `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`
}

function toHours(hours: number, meridiem: string | undefined): number | null {
  if (meridiem === undefined) {
    return hours < 24 ? hours : null
  }
  if (hours < 1 || hours > 12) {
    return null
  }
  return (hours % 12) + (meridiem === 'pm' ? 12 : 0)
}

function monthIndex(name: string): number {
  return MONTH_NAMES.findIndex((month) => month.startsWith(name.toLowerCase().slice(0, 3)))
}

/**
 * The next time the day comes, today included. A day that is not in every year (29 February) is looked for over a
 * leap cycle; one that is in no year (31 April) gives null.
 */
function nextDayOfMonth(day: number, month: number, now: Date): string | null {
  for (let year = now.getFullYear(); year <= now.getFullYear() + 4; year++) {
    const date = new Date(year, month, day)
    if (date.getMonth() !== month) {
      continue
    }
    if (localDate(date) >= localDate(now)) {
      return localDate(date)
    }
  }
  return null
}

function endOfWeek(now: Date): Date {
  // Weeks run Monday to Sunday.
  return addDays(now, (7 - now.getDay()) % 7)
}

function addDays(at: Date, days: number): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days)
}

function parseDate(date: string): Date {
  const [year, month, day] = ymd(date)
  return new Date(year, month, day)
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.UTC(...ymd(to)) - Date.UTC(...ymd(from))) / 86_400_000)
}

/** Year, month from 0, and day of a YYYY-MM-DD date. */
function ymd(date: string): [number, number, number] {
  const [year = NaN, month = NaN, day = NaN] = date.split('-').map(Number)
  return [year, month - 1, day]
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
