import { describe, expect, it, vi } from 'vitest'
import { backdropClose } from '@/components/backdropClose'

/** A dialog box from (100, 100) to (500, 400), with a field inside it. */
function dialogBox() {
  const dialog = document.createElement('dialog')
  const field = document.createElement('input')
  dialog.append(field)
  document.body.append(dialog)
  dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300, x: 100, y: 100, toJSON: () => ({}) })
  return { dialog, field }
}

function on(target: Element, type: 'pointerdown' | 'click', x: number, y: number, close: ReturnType<typeof backdropClose>, dialog: HTMLElement): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })
  Object.defineProperty(event, 'target', { value: target })
  Object.defineProperty(event, 'currentTarget', { value: dialog })
  if (type === 'pointerdown') {
    close.onPointerdown(event as PointerEvent)
  } else {
    close.onClick(event)
  }
}

describe('backdropClose', () => {
  it('closes on a click on the backdrop, outside the box', () => {
    const { dialog } = dialogBox()
    const close = vi.fn<() => void>()
    const backdrop = backdropClose(close)

    on(dialog, 'pointerdown', 20, 20, backdrop, dialog)
    on(dialog, 'click', 20, 20, backdrop, dialog)

    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps it open for clicks inside, and for a press inside that lets go outside', () => {
    const { dialog, field } = dialogBox()
    const close = vi.fn<() => void>()
    const backdrop = backdropClose(close)

    on(field, 'pointerdown', 200, 200, backdrop, dialog)
    on(field, 'click', 200, 200, backdrop, dialog)
    // Selecting text in the field and letting go past the edge.
    on(field, 'pointerdown', 200, 200, backdrop, dialog)
    on(dialog, 'click', 20, 20, backdrop, dialog)
    // The dialog's own padding is inside its box.
    on(dialog, 'pointerdown', 102, 102, backdrop, dialog)
    on(dialog, 'click', 102, 102, backdrop, dialog)

    expect(close).not.toHaveBeenCalled()
  })
})
