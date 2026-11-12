import { ref } from 'vue'
import { errorMessage } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'

/** How long "Try to save them first" waits for the drafts to reach the server before it asks again. */
export const SAVE_FIRST_MS = 15_000

/**
 * The user's sign-out, from the sidebar or the payment screen. A sign-out deletes the mail on this device, and with it
 * drafts that never reached the server: when there are any, the user is asked first (UnsavedDraftsDialog), with
 * `unsaved` holding their number while the question is open. `failed` is said where the button is.
 */
export function useSignOut(failed: (message: string) => void) {
  const auth = useAuthStore()
  const mail = useMailStore()
  const compose = useComposeStore()
  /** Drafts not on the server, while the question is open; null otherwise. */
  const unsaved = ref<number | null>(null)
  const saving = ref(false)
  const saveFailed = ref(false)
  /** The draft on screen, when saving its newest edits on this device failed: it is lost at the sign-out too. */
  let openUnsaved: string | null = null

  async function signOutNow(): Promise<void> {
    unsaved.value = null
    saveFailed.value = false
    try {
      await auth.signOut()
    } catch (cause) {
      failed(`Signing out did not finish: ${errorMessage(cause)}. Try again.`)
    }
  }

  function count(drafts: { id: string }[]): number {
    const ids = new Set(drafts.map((draft) => draft.id))
    if (openUnsaved !== null) ids.add(openUnsaved)
    return ids.size
  }

  /** Signs out, or asks first when drafts on this device never reached the server. */
  async function request(): Promise<void> {
    if (auth.signingOut || unsaved.value !== null) {
      return
    }
    openUnsaved = null
    const open = compose.draft?.id ?? null
    try {
      // The typing since the last autosave is in the copy too, so the question counts it.
      await compose.saveNow()
    } catch {
      openUnsaved = open
    }
    let drafts: { id: string }[]
    try {
      drafts = await mail.unsavedDrafts()
    } catch (cause) {
      // Which drafts are only here cannot be told: asking about none would delete them unannounced.
      failed(`Tresso could not check this device for unsaved drafts: ${errorMessage(cause)}. Try again.`)
      return
    }
    if (count(drafts) === 0) {
      await signOutNow()
      return
    }
    saveFailed.value = false
    unsaved.value = count(drafts)
  }

  /** "Try to save them first": uploads them, for a limited time; signs out once all are on the server. */
  async function saveFirst(): Promise<void> {
    saving.value = true
    saveFailed.value = false
    try {
      const left = count(await mail.saveUnsavedDrafts(SAVE_FIRST_MS))
      if (left === 0) {
        saving.value = false
        await signOutNow()
        return
      }
      unsaved.value = left
    } catch (cause) {
      // The drafts could not be read again: the number asked about stays as it was.
      console.error('Saving the drafts before signing out failed', cause)
    }
    saving.value = false
    saveFailed.value = true
  }

  function cancel(): void {
    unsaved.value = null
    saveFailed.value = false
  }

  return { unsaved, saving, saveFailed, request, saveFirst, signOutAnyway: signOutNow, cancel }
}
