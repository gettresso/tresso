/**
 * A still copy of a card for its exit animation: inert, hidden from screen readers, without ids, and without the frames
 * that show an email's HTML. A cloned frame would load the email a second time (and a tracking pixel would count a
 * second open), so each is swapped for an empty box of its size.
 */
export function cardGhost(card: HTMLElement): HTMLElement {
  const box = card.getBoundingClientRect()
  const ghost = card.cloneNode(true) as HTMLElement
  const frames = [...card.querySelectorAll('iframe')]
  ghost.querySelectorAll('iframe').forEach((frame, index) => {
    const original = frames[index]?.getBoundingClientRect()
    const stand = document.createElement('div')
    stand.style.width = `${original?.width ?? 0}px`
    stand.style.height = `${original?.height ?? 0}px`
    frame.replaceWith(stand)
  })
  ghost.removeAttribute('id')
  ghost.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'))
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  Object.assign(ghost.style, { position: 'fixed', top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px`, margin: '0', pointerEvents: 'none', zIndex: '15' })
  return ghost
}
