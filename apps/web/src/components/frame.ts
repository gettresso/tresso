import type { InjectionKey } from 'vue'
import { SIDEBAR_MAX, SIDEBAR_MIN } from '@/platform/frame'

/**
 * Provided by the desktop shell (AppShell) while it shows its title strip: views then put their title and toolbar
 * actions in it (FrameTitle, FrameTools). Elsewhere, and always in the browser, they stay where they are.
 */
export const FRAME_STRIP: InjectionKey<boolean> = Symbol('frame strip')

/** Where FrameTitle and FrameTools put what they hold (AppShell's title strip). */
export const FRAME_TITLE_TARGET = '#frame-title'
export const FRAME_TOOLS_TARGET = '#frame-tools'

/** How far one press of an arrow key moves the sidebar's edge. Chosen. */
export const RESIZE_STEP = 10

/**
 * The width a key on the drag handle asks for (the separator pattern): the arrows move the edge, Home and End take it
 * to the narrowest and widest. Null for any other key.
 */
export function widthForKey(width: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(SIDEBAR_MIN, width - RESIZE_STEP)
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(SIDEBAR_MAX, width + RESIZE_STEP)
    case 'Home':
      return SIDEBAR_MIN
    case 'End':
      return SIDEBAR_MAX
    default:
      return null
  }
}

/**
 * The cursor over the drag handle, as macOS shows it: both ways in between, only the way it can still go at a limit.
 */
export function resizeCursor(width: number): string {
  if (width <= SIDEBAR_MIN) {
    return 'e-resize'
  }
  if (width >= SIDEBAR_MAX) {
    return 'w-resize'
  }
  return 'col-resize'
}
