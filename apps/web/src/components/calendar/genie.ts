const EASE = 'cubic-bezier(0.55, 0, 0.25, 1)'

export function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Whether an element is on screen: inside the window and inside every scrolling box around it. */
export function inView(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect()
  if (box.width === 0 || box.height === 0 || box.bottom <= 0 || box.right <= 0 || box.top >= window.innerHeight || box.left >= window.innerWidth) {
    return false
  }
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent)
    if (/(auto|scroll|hidden)/.test(overflowX + overflowY)) {
      const around = parent.getBoundingClientRect()
      if (box.bottom <= around.top || box.top >= around.bottom || box.right <= around.left || box.left >= around.right) {
        return false
      }
    }
  }

  return true
}

/**
 * The macOS minimize ("genie"): a dialog narrows toward an element as it falls into it, then the element pulses once to
 * say "here it is". Only opacity and transform move; the dialog's backdrop fades along. Settles when it is done.
 */
export async function genie(dialog: HTMLElement, target: HTMLElement): Promise<void> {
  if (typeof dialog.animate !== 'function') {
    return
  }
  const from = dialog.getBoundingClientRect()
  const to = target.getBoundingClientRect()
  const dx = to.left - from.left
  const dy = to.top - from.top
  const sx = to.width / from.width
  const sy = to.height / from.height
  // Halfway it is already narrow but still tall, as if sucked into the target, which gives the genie its shape.
  const midScaleX = Math.max(sx, 0.3) + (1 - Math.max(sx, 0.3)) * 0.3
  dialog.style.transformOrigin = 'top left'
  const falling = dialog.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.15}px) scale(${midScaleX}, 0.9)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0 },
    ],
    { duration: 420, easing: EASE, fill: 'forwards' },
  )
  try {
    dialog.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: EASE, fill: 'forwards', pseudoElement: '::backdrop' })
  } catch {
    // A browser that cannot animate the backdrop drops it when the dialog closes.
  }
  await falling.finished.catch(() => undefined)
  target.animate?.(
    [
      { transform: 'scale(1)', boxShadow: '0 0 0 0 rgb(35 65 214 / 0%)' },
      { transform: 'scale(1.04)', boxShadow: '0 0 0 4px rgb(35 65 214 / 28%)', offset: 0.4 },
      { transform: 'scale(1)', boxShadow: '0 0 0 0 rgb(35 65 214 / 0%)' },
    ],
    { duration: 520, easing: 'ease-out' },
  )
}
