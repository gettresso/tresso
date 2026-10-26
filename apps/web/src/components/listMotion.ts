import { reducedMotion } from '@/components/calendar/genie'

const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)'
/** More rows than this moving at once (a page of older mail, a bulk archive) just appear or go: a wave would be noise. */
const MOST_AT_ONCE = 4

type Move = { element: HTMLElement; done: () => void; shift: number }
let leaving: Move[] = []
let entering: Move[] = []
let queued = false

/** The box around the content, which folds along with the height (or a padded row would stop at its padding). */
function box(element: HTMLElement): Keyframe {
  const style = getComputedStyle(element)
  return { paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginTop: style.marginTop, marginBottom: style.marginBottom }
}
const FOLDED: Keyframe = { paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' }

function fold({ element, done, shift }: Move): void {
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

function unfold({ element, done }: Move): void {
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

function run(moves: Move[], animate: (move: Move) => void): void {
  const moving = !reducedMotion() && moves.length <= MOST_AT_ONCE
  for (const move of moves) {
    if (moving && typeof move.element.animate === 'function') {
      animate(move)
    } else {
      move.done()
    }
  }
}

/**
 * The rows that start to move in one tick are judged together: a few fold, many (a bulk archive, a page of older mail)
 * all just go or appear, so a big change is never a wave of rows nor half animated.
 */
function queue(): void {
  if (queued) {
    return
  }
  queued = true
  queueMicrotask(() => {
    queued = false
    const going = leaving
    const coming = entering
    leaving = []
    entering = []
    run(going, fold)
    run(coming, unfold)
  })
}

/**
 * For <TransitionGroup :css="false">: a row that leaves fades and folds shut, so the rows below glide up into its place
 * instead of jumping.
 */
export function collapseLeave(element: Element, done: () => void, shift = 12): void {
  if (!(element instanceof HTMLElement)) {
    done()
    return
  }
  leaving.push({ element, done, shift })
  queue()
}

/** For <TransitionGroup :css="false">: a row that arrives (new mail) opens up and fades in. */
export function expandEnter(element: Element, done: () => void): void {
  if (!(element instanceof HTMLElement)) {
    done()
    return
  }
  entering.push({ element, done, shift: 0 })
  queue()
}
