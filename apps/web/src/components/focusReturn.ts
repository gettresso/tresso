import { watch } from 'vue'

/**
 * Gives focus back to what had it before a modal layer opened, once the layer is out of the page. While a modal
 * dialog is open (also through its leave animation) everything outside it is inert and cannot take focus, so the
 * dialog itself cannot do this when it unmounts: the caller runs `restore` once the layer has gone, from its
 * <Transition>'s after-leave.
 */
export function useFocusReturn(open: () => boolean): { restore: () => void } {
  let opener: HTMLElement | null = null
  // Before the layer is in the page ('pre' flush), so the element that opened it still has focus.
  watch(open, (isOpen) => {
    if (isOpen) {
      opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    }
  })
  return {
    restore(): void {
      const target = opener
      opener = null
      if (target?.isConnected) {
        target.focus()
      }
    },
  }
}
