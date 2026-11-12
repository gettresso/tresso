import { invoke } from '@tauri-apps/api/core'
import frameTokens from '@/assets/frame.css?raw'
import { isDesktop } from '@/platform/desktop'

/**
 * The desktop window frame (assets/frame.css): the desktop app on every system draws its sidebar as a card in a column,
 * with a collapse toggle and a title strip, after the window spec shared by the owner's Mac apps. The browser build
 * keeps its own layout; nothing of the frame reaches it.
 */
export const framed = isDesktop

/**
 * A token of frame.css in pixels (or `ms`); the frame's numbers live there only. Read when the app loads, before
 * anything is on screen, so a token that went missing must not stop the app: it is said in the console and the spec's
 * own value (`fallback`) is used. A test keeps every token present.
 */
export function frameToken(name: string, fallback: number, unit: 'px' | 'ms' = 'px', css: string = frameTokens): number {
  const match = new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)${unit};`).exec(css)
  if (match === null) {
    console.error(`frame.css has no --${name} in ${unit}; using ${fallback}${unit}`)
    return fallback
  }
  return Number(match[1])
}

/** The sidebar's width: the user drags it between these; a first launch starts at the default. */
export const SIDEBAR_MIN = frameToken('frame-sidebar-min', 190)
export const SIDEBAR_DEFAULT = frameToken('frame-sidebar-default', 220)
export const SIDEBAR_MAX = frameToken('frame-sidebar-max', 300)

/** A width the sidebar can take: whole pixels, within the limits; anything unreadable is the default. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return SIDEBAR_DEFAULT
  }
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)))
}

/** What the frame remembers on this device: the sidebar's width and whether it shows. */
export interface SidebarLayout {
  width: number
  shown: boolean
}

export const SIDEBAR_KEY = 'tresso.sidebar'

/** The layout kept on this device, or the first launch's (shown, default width) when there is none or it is unreadable. */
export function readSidebarLayout(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): SidebarLayout {
  const first = { width: SIDEBAR_DEFAULT, shown: true }
  let raw: string | null = null
  try {
    raw = storage?.getItem(SIDEBAR_KEY) ?? null
  } catch {
    return first
  }
  if (raw === null) {
    return first
  }
  try {
    const kept = JSON.parse(raw) as Partial<SidebarLayout> | null
    return {
      width: typeof kept?.width === 'number' ? clampSidebarWidth(kept.width) : SIDEBAR_DEFAULT,
      shown: typeof kept?.shown === 'boolean' ? kept.shown : true,
    }
  } catch {
    return first
  }
}

/**
 * Keeps the layout on this device, as the client keeps its other preferences (localStorage, which the desktop app keeps
 * across restarts). Without storage the layout holds until the app quits; nothing else depends on it.
 */
export function writeSidebarLayout(layout: SidebarLayout, storage: Pick<Storage, 'setItem'> | null = safeLocalStorage()): void {
  try {
    storage?.setItem(SIDEBAR_KEY, JSON.stringify(layout))
  } catch {
    // A private or full storage: the width and state still hold while the app runs.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

/** The system's selection colours as the shell reads them (accessibility.rs): null where it has none. */
export interface SelectionColors {
  light: string
  dark: string
}

const HEX = /^#[0-9a-f]{6}$/i

/**
 * Sets the selected row's colour from the user's accent colour: `--frame-accent-light` and `--frame-accent-dark` on the
 * page, which frame.css uses (falling back to macOS's blue where they are not set). Read at launch and whenever the
 * window comes back, as the setting may change while Tresso runs (the same as the transparency setting): a changed
 * accent only shows in the focused window anyway. Windows and Linux have no such colour in the shell and keep the
 * fallback.
 */
export function followSelectionAccent(shell: { invoke(command: 'selection_accent'): Promise<SelectionColors | null> } = { invoke }, root: HTMLElement = document.documentElement, target: Pick<Window, 'addEventListener'> = window): () => Promise<void> {
  const check = async () => {
    try {
      const colors = await shell.invoke('selection_accent')
      applySelectionAccent(colors, root)
    } catch (error) {
      // The row keeps the colour it has (the system's from before, or the fallback).
      console.error('Reading the accent colour failed', error)
    }
  }
  void check()
  target.addEventListener('focus', () => void check())
  return check
}

/** Sets or clears the two variables; a value that is not a plain hex colour is not set. */
export function applySelectionAccent(colors: SelectionColors | null, root: HTMLElement): void {
  for (const [name, value] of [
    ['--frame-accent-light', colors?.light],
    ['--frame-accent-dark', colors?.dark],
  ] as const) {
    if (value !== undefined && HEX.test(value)) {
      root.style.setProperty(name, value)
    } else {
      root.style.removeProperty(name)
    }
  }
}
