import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import { SIDEBAR_MAX, SIDEBAR_MIN } from '@/platform/frame'

/**
 * Provided by the desktop shell (AppShell) while it shows its title strip: views then put their title and toolbar
 * actions in it (FrameTitle, FrameTools). Elsewhere, and always in the browser, they stay where they are.
 */
export const FRAME_STRIP: InjectionKey<boolean> = Symbol('frame strip')

/** Where FrameTitle and FrameTools put what they hold (AppShell's title strip). */
export const FRAME_TITLE_TARGET = '#frame-title'
export const FRAME_TOOLS_TARGET = '#frame-tools'

/** A drag handle's or a toggle's own element: using it leaves the sidebar's focus as it was (useSidebarActive). */
export const FRAME_NEUTRAL = 'data-frame-neutral'

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

/**
 * Whether the sidebar is where the user works now, as a Mac app's sidebar is when it is the first responder: the last
 * click or focus went into it (a click counts too, as WebKit does not focus a link it clicks), and the window is in
 * front. Its selected row then takes the accent colour; otherwise the grey. The toggle and the drag handle change
 * nothing.
 */
export function useSidebarActive(sidebar: Ref<HTMLElement | null>, target: Document = document, view: Window = window): ComputedRef<boolean> {
  const inside = ref(false)
  const windowActive = ref(target.hasFocus())

  function moved(event: Event): void {
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest(`[${FRAME_NEUTRAL}]`)) {
      return
    }
    inside.value = element !== null && sidebar.value !== null && sidebar.value.contains(element)
  }
  const focused = () => (windowActive.value = true)
  const blurred = () => (windowActive.value = false)

  onMounted(() => {
    target.addEventListener('pointerdown', moved, true)
    target.addEventListener('focusin', moved)
    view.addEventListener('focus', focused)
    view.addEventListener('blur', blurred)
  })
  onBeforeUnmount(() => {
    target.removeEventListener('pointerdown', moved, true)
    target.removeEventListener('focusin', moved)
    view.removeEventListener('focus', focused)
    view.removeEventListener('blur', blurred)
  })

  return computed(() => inside.value && windowActive.value)
}
