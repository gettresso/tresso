import { reducedMotion } from '@/components/calendar/genie'

const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)'
/** More rows than this arriving at once (a page of older mail, a first sync) just appear: a wave would be noise. */
const MOST_AT_ONCE = 4

let entering = 0
let resetQueued = false

/** The box around the content, which folds along with the height (or a padded row would stop at its padding). */
function box(element: HTMLElement): Keyframe {
  const style = getComputedStyle(element)
  return { paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginTop: style.marginTop, marginBottom: style.marginBottom }
}
const FOLDED: Keyframe = { paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' }

function animatable(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && typeof element.animate === 'function' && !reducedMotion()
}

/**
 * For <TransitionGroup :css="false">: a row that leaves fades and folds shut, so the rows below glide up into its place
 * instead of jumping.
 */
export function collapseLeave(element: Element, done: () => void, shift = 12): void {
  if (!animatable(element)) {
    done()
    return
  }
  const height = element.offsetHeight
  const open = box(element)
  element.style.overflow = 'hidden'
  element.style.boxSizing = 'border-box'
  const folding = element.animate(
    [
      { ...open, height: `${height}px`, opacity: 1, transform: 'none' },
      { ...open, height: `${height}px`, opacity: 0, transform: `translateX(${shift}px)`, offset: 0.45 },
      { ...FOLDED, height: '0px', opacity: 0, transform: `translateX(${shift}px)` },
    ],
    { duration: 260, easing: EASE },
  )
  folding.onfinish = done
  folding.oncancel = done
}

/** A row that arrives (new mail) opens up and fades in; many at once just appear. */
export function expandEnter(element: Element, done: () => void): void {
  entering += 1
  if (!resetQueued) {
    resetQueued = true
    queueMicrotask(() => {
      entering = 0
      resetQueued = false
    })
  }
  if (!animatable(element) || entering > MOST_AT_ONCE) {
    done()
    return
  }
  const height = element.offsetHeight
  const open = box(element)
  element.style.overflow = 'hidden'
  const opening = element.animate(
    [
      { ...FOLDED, height: '0px', opacity: 0 },
      { ...open, height: `${height}px`, opacity: 0, offset: 0.5 },
      { ...open, height: `${height}px`, opacity: 1 },
    ],
    { duration: 280, easing: EASE },
  )
  const finish = () => {
    element.style.overflow = ''
    done()
  }
  opening.onfinish = finish
  opening.oncancel = finish
}
