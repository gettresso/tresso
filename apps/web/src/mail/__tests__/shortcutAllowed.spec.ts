import { afterEach, describe, expect, it } from 'vitest'
import { shortcutAllowed } from '@/mail/useMessageActions'

function key(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'c', bubbles: true, ...init })
  let seen: KeyboardEvent | null = null
  target.addEventListener('keydown', (received) => (seen = received as KeyboardEvent), { once: true })
  target.dispatchEvent(event)
  return seen ?? event
}

describe('single-key shortcuts', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('are allowed on the page, and not while typing', () => {
    expect(shortcutAllowed(key(document.body), false)).toBe(true)
    const field = document.body.appendChild(document.createElement('textarea'))
    expect(shortcutAllowed(key(field), false)).toBe(false)
  })

  it('are held by an alert dialog on the page, such as the confirmation to leave a chat out', () => {
    const confirm = document.body.appendChild(document.createElement('div'))
    confirm.setAttribute('role', 'alertdialog')
    const cancel = confirm.appendChild(document.createElement('button'))
    expect(shortcutAllowed(key(cancel), false)).toBe(false)
    // Wherever focus is meanwhile.
    expect(shortcutAllowed(key(document.body), false)).toBe(false)
    confirm.remove()
    expect(shortcutAllowed(key(document.body), false)).toBe(true)
  })
})
