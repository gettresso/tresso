/**
 * Closes a modal dialog element when the user clicks its backdrop. A click on the backdrop lands on the dialog element
 * itself, outside its box; it only counts when the press also started there, so selecting text in a field and letting
 * go outside the dialog closes nothing.
 */
export function backdropClose(close: () => void) {
  let pressedOutside = false

  function outside(event: MouseEvent): boolean {
    const dialog = event.currentTarget as HTMLElement
    if (event.target !== dialog) {
      return false
    }
    const box = dialog.getBoundingClientRect()
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
  }

  return {
    onPointerdown(event: PointerEvent): void {
      pressedOutside = outside(event)
    },
    onClick(event: MouseEvent): void {
      if (pressedOutside && outside(event)) {
        close()
      }
      pressedOutside = false
    },
  }
}
