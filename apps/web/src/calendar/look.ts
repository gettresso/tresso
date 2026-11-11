import { longDate, occurrenceWhen, RESPONSE_WORDS, todoBlockTimes, toWall, type Occurrence, type SyncedCalendar, type TodoBlock } from '@tresso/core'

/** The default calendar color when a calendar has none the browser understands. */
const FALLBACK = '#6E56CF'

/**
 * The paper and ink of both themes, as main.css defines them (a test holds the two together). Text on a calendar's
 * tint is mixed from these, so its contrast can be worked out here.
 */
export const THEME_COLORS = {
  light: { paper: '#ffffff', ink: '#16181d' },
  dark: { paper: '#171a20', ink: '#eceef2' },
} as const

/**
 * Text on a fill of the calendar color itself, as main.css defines --fill-text-light and --fill-text-dark (a test holds
 * them together). White and black: one of the two always reaches 4.5:1, whatever the color.
 */
export const FILL_TEXT = { light: '#ffffff', dark: '#000000' } as const

/** How much of the calendar color the tint behind event text holds (the stylesheets mix it with --paper). */
const TINT_SHARE = 0.16
/** How much of the calendar color event text holds at most; the rest is --ink. Light colors get less. */
const MAX_INK_SHARE = 65
/** Event text is small (11 to 12 px), so it needs the full contrast for body text. */
const MIN_CONTRAST = 4.5

type Rgb = readonly [number, number, number]

function parse(hex: string): Rgb {
  const digits = hex.slice(1)
  const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as unknown as Rgb
}

function mix(a: Rgb, b: Rgb, shareOfA: number): Rgb {
  return a.map((channel, index) => channel * shareOfA + b[index]! * (1 - shareOfA)) as unknown as Rgb
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

/** The largest share of the color (in steps of 5) that keeps event text readable on its tint in one theme. */
function inkShare(color: Rgb, theme: { paper: string; ink: string }): number {
  const tint = mix(color, parse(theme.paper), TINT_SHARE)
  for (let share = MAX_INK_SHARE; share > 0; share -= 5) {
    if (contrast(mix(color, parse(theme.ink), share / 100), tint) >= MIN_CONTRAST) {
      return share
    }
  }
  return 0
}

/**
 * The calendar's color as CSS custom properties: `--cal` itself for bars, dots and tints; `--cal-on` for text on a
 * fill of it (light or dark, whichever reads); `--cal-ink` for text on its tint, with as much of the color as each
 * theme allows (a pastel the provider sent would otherwise give text that cannot be read).
 */
export function calendarColor(calendar: SyncedCalendar | undefined): Record<string, string> {
  const color = calendar?.color && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(calendar.color) ? calendar.color : FALLBACK
  const rgb = parse(color)
  const on = contrast(rgb, parse(FILL_TEXT.light)) >= contrast(rgb, parse(FILL_TEXT.dark)) ? 'var(--fill-text-light)' : 'var(--fill-text-dark)'
  const light = inkShare(rgb, THEME_COLORS.light)
  const dark = inkShare(rgb, THEME_COLORS.dark)
  const ink = (share: number) => `color-mix(in srgb, var(--cal) ${share}%, var(--ink))`
  // Both shares at once, picked by --theme-light-share (100% in the light theme, 0% in the dark one, main.css): a
  // mix of 100% and 0% is the one or the other. No calc() inside color-mix, which older engines may not take.
  const text = light === dark ? ink(light) : `color-mix(in srgb, ${ink(light)} var(--theme-light-share), ${ink(dark)})`
  return { '--cal': color, '--cal-on': on, '--cal-ink': text }
}

/** Time planned for a todo takes the Do colors, the one verdict color the calendar shows; the tokens read in both themes. */
export const TODO_COLOR: Record<string, string> = {
  '--cal': 'var(--do)',
  '--cal-on': 'var(--paper)',
  '--cal-ink': `color-mix(in srgb, var(--cal) ${MAX_INK_SHARE}%, var(--ink))`,
}

/** What a screen reader hears for the time a todo is planned at. */
export function todoBlockLabel(block: TodoBlock, zone: string, now: number): string {
  const parts = [`Todo: ${block.todo.title}`, `${longDate(toWall(block.start, zone), toWall(now, zone))}, ${todoBlockTimes(block, zone)}`]
  if (block.conflict) parts.push('that time is taken')
  return parts.join(', ')
}

/** How a block looks: no reply or maybe is dashed, an event that ended today is faded. */
export function blockState(occurrence: Occurrence, now: number): { pending: boolean; past: boolean } {
  const response = occurrence.event.selfResponse
  return { pending: response === 'needs-action' || response === 'tentative', past: occurrence.end <= now }
}

/** What a screen reader hears for an event block. */
export function occurrenceLabel(occurrence: Occurrence, zone: string, calendar: SyncedCalendar | undefined, now: number): string {
  const parts = [occurrence.event.summary || 'Untitled event', occurrenceWhen(occurrence, zone, toWall(now, zone))]
  if (calendar !== undefined) parts.push(calendar.name)
  if (occurrence.event.location !== '') parts.push(occurrence.event.location)
  if (occurrence.event.selfResponse !== null) parts.push(RESPONSE_WORDS[occurrence.event.selfResponse])
  if (occurrence.recurring) parts.push('repeats')
  return parts.join(', ')
}

/** The button label of an online meeting: "Join Teams meeting", "Join Google Meet". */
export function joinLabel(provider: string): string {
  switch (provider) {
    case 'teams':
      return 'Join Teams meeting'
    case 'meet':
      return 'Join Google Meet'
    case 'zoom':
      return 'Join Zoom meeting'
    case 'webex':
      return 'Join Webex meeting'
    default:
      return 'Join meeting'
  }
}

/** Moves focus among the event blocks of a view with the arrow keys; true when it handled the key. */
export function moveFocus(event: KeyboardEvent, container: HTMLElement | null): boolean {
  if (container === null || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return false
  }
  const items = [...container.querySelectorAll<HTMLElement>('[data-occurrence]')]
  const current = items.indexOf(document.activeElement as HTMLElement)
  if (items.length === 0 || current === -1) {
    return false
  }
  const here = items[current]!
  const column = Number(here.dataset.column ?? 0)
  let target: HTMLElement | undefined
  switch (event.key) {
    case 'ArrowUp':
      target = items.slice(0, current).reverse().find((item) => Number(item.dataset.column ?? 0) === column)
      break
    case 'ArrowDown':
      target = items.slice(current + 1).find((item) => Number(item.dataset.column ?? 0) === column)
      break
    case 'ArrowLeft':
    case 'ArrowRight': {
      // The nearest event in the next day with any, at about the same time.
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      const top = Number(here.dataset.top ?? 0)
      const columns = [...new Set(items.map((item) => Number(item.dataset.column ?? 0)))].sort((a, b) => a - b)
      const next = direction === 1 ? columns.find((value) => value > column) : columns.reverse().find((value) => value < column)
      if (next !== undefined) {
        const candidates = items.filter((item) => Number(item.dataset.column ?? 0) === next)
        target = candidates.reduce((best, item) => (Math.abs(Number(item.dataset.top ?? 0) - top) < Math.abs(Number(best.dataset.top ?? 0) - top) ? item : best), candidates[0]!)
      }
      break
    }
    case 'Home':
      target = items[0]
      break
    case 'End':
      target = items[items.length - 1]
      break
  }
  if (target !== undefined) {
    for (const item of items) item.tabIndex = -1
    target.tabIndex = 0
    target.focus()
  }
  event.preventDefault()
  return true
}
