import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

const GAP = 4
const MARGIN = 8

/**
 * Places an open menu against the window instead of its parent, so a scrolling list or pane never cuts it off. It opens
 * below its button, or above when the room below is too small, aligned to the button's start or end edge, and follows
 * the button when anything scrolls or the window resizes.
 */
export function useAnchoredMenu(button: Ref<HTMLElement | null>, menu: Ref<HTMLElement | null>, open: Ref<boolean>, align: 'start' | 'end' = 'start') {
  const style = ref<Record<string, string>>({ position: 'fixed', visibility: 'hidden' })
  const above = ref(false)

  function place(): void {
    const anchor = button.value?.getBoundingClientRect()
    const element = menu.value
    if (anchor === undefined || element === null) {
      return
    }
    const height = element.offsetHeight
    const width = element.offsetWidth
    const below = window.innerHeight - anchor.bottom - GAP - MARGIN
    above.value = below < height && anchor.top - GAP - MARGIN > below
    const top = above.value ? Math.max(MARGIN, anchor.top - GAP - height) : anchor.bottom + GAP
    const preferred = align === 'end' ? anchor.right - width : anchor.left
    const left = Math.min(Math.max(MARGIN, preferred), window.innerWidth - width - MARGIN)
    const room = above.value ? anchor.top - GAP - MARGIN : below
    // The menu caps its own height with min(its cap, var(--menu-room)), so it never runs off the window.
    style.value = { position: 'fixed', top: `${top}px`, left: `${left}px`, '--menu-room': `${Math.max(120, room)}px` }
  }

  function follow(): void {
    if (open.value) {
      place()
    }
  }

  watch(open, async (isOpen) => {
    if (isOpen) {
      style.value = { position: 'fixed', visibility: 'hidden' }
      await nextTick()
      place()
      window.addEventListener('scroll', follow, true)
      window.addEventListener('resize', follow)
    } else {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  })
  onBeforeUnmount(() => {
    window.removeEventListener('scroll', follow, true)
    window.removeEventListener('resize', follow)
  })

  return { style, above }
}
