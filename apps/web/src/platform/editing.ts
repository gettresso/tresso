import { nextTick, readonly, ref, type Ref } from 'vue'
import type { Router } from 'vue-router'

/** Input types that take no typed text: a key such as ⌘⌫ means nothing there. */
const NOT_TEXT = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])

/** What counts as a modal layer (useMessageActions' modalOpen); the followers watch these come and go. */
export const MODAL_SELECTOR = 'dialog[open], [role="alertdialog"], [role="dialog"]:not([aria-modal="false"])'

/** The compose window carries this attribute (ComposeWindow.vue): while the focus is anywhere in it, text is edited. */
export const COMPOSE_WINDOW_ATTRIBUTE = 'data-compose-window'

/**
 * Whether the focus on this element means text is being edited: a text field, a text area, editable content (the
 * composer's editor), or anything in the compose window (its buttons too: the key belongs to what is being written).
 */
export function isEditingText(element: EventTarget | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false
  }
  // Editable content by its attribute as well: an engine without isContentEditable (jsdom) still counts it.
  const editable = element.isContentEditable || element.closest('[contenteditable]:not([contenteditable="false"])') !== null
  if (editable || element.closest(`[${COMPOSE_WINDOW_ATTRIBUTE}]`) !== null || element instanceof HTMLTextAreaElement) {
    return true
  }
  return element instanceof HTMLInputElement && !NOT_TEXT.has(element.type)
}

/**
 * Counts the focus moves the followers saw. A check of the page that is not reactive itself (is a modal dialog open?)
 * reads it to be checked again after each: a dialog takes the focus when it opens and gives it back when it closes.
 */
const moves = ref(0)

/** Reads the focus move count: call it in a reactive check to have it run again once the focus moved. */
export function focusMoved(): number {
  return moves.value
}

/** The followers running, for {@link recheckEditing}. */
const followers = new Set<() => void>()

/**
 * Reads the focus again in every follower: for when the focused element left the page, which browsers do not all
 * announce with a focus event (the compose window, once its leave animation is over).
 */
export function recheckEditing(): void {
  for (const recheck of followers) {
    recheck()
  }
}

/**
 * Follows whether text is being edited, from the document's focus changes (one per focus move, none per key). `recheck`
 * reads the focus again, for when the focused element went without a focus event.
 */
export function followEditing(doc: Document): { editing: Readonly<Ref<boolean>>; recheck(): void; stop(): void } {
  const editing = ref(isEditingText(doc.activeElement))
  const recheck = () => {
    editing.value = isEditingText(doc.activeElement)
    moves.value++
  }
  // While focus leaves one element, the document's active element is not yet the next one: the event names it.
  const left = (event: FocusEvent) => {
    editing.value = isEditingText(event.relatedTarget)
    moves.value++
  }
  const entered = (event: FocusEvent) => {
    editing.value = isEditingText(event.target)
    moves.value++
  }
  doc.addEventListener('focusout', left)
  doc.addEventListener('focusin', entered)
  // A modal layer that opens or goes without moving the focus (one removed with its screen, a question answered by a
  // click that leaves the focus on the body) still has the checks that read the page run again.
  const modals = new MutationObserver((records) => {
    if (records.some(touchesModal)) {
      recheck()
    }
  })
  if (doc.body !== null) {
    modals.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'role'] })
  }
  followers.add(recheck)
  return {
    editing: readonly(editing),
    recheck,
    stop: () => {
      doc.removeEventListener('focusout', left)
      doc.removeEventListener('focusin', entered)
      modals.disconnect()
      followers.delete(recheck)
    },
  }
}

/** Whether a change of the page adds, removes, opens or closes a modal layer. */
function touchesModal(record: MutationRecord): boolean {
  if (record.type === 'attributes') {
    return record.target instanceof Element && (record.target.tagName === 'DIALOG' || record.attributeName === 'role')
  }
  const isModal = (node: Node) => node instanceof Element && (node.matches(MODAL_SELECTOR) || node.querySelector(MODAL_SELECTOR) !== null)
  return [...record.addedNodes].some(isModal) || [...record.removedNodes].some(isModal)
}

/**
 * Reads the focus again after every navigation, once the new screen is in place: a screen that goes takes its focused
 * field along, which browsers do not all announce with a focus event (the search field, left by View > Inbox).
 */
export function recheckEditingOnNavigation(router: Pick<Router, 'afterEach'>): () => void {
  return router.afterEach(() => {
    void nextTick(recheckEditing)
  })
}
