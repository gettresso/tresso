import { nextTick, ref } from 'vue'
import { errorMessage } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'

/** How long "Try to save them first" waits for the drafts to reach the server before it asks again. */
export const SAVE_FIRST_MS = 15_000

/**
 * The question before a sign-out deletes the mail on this device: how many drafts in it never reached the server, or
 * (`count` null) that this could not be checked, and why.
 */
export interface SignOutQuestion {
  count: number | null
  checkError: string | null
}

/**
 * The user's sign-out, from the sidebar or the payment screen. A sign-out deletes the mail on this device, and with it
 * drafts that never reached the server: when there are any, or when that cannot be checked, the user is asked first
 * (UnsavedDraftsDialog), with `question` set while it is open. `failed` is said where the button is. Cancel gives the
 * focus back to the button the sign-out started from.
 */
export function useSignOut(failed: (message: string) => void) {
  const auth = useAuthStore()
  const mail = useMailStore()
  const compose = useComposeStore()
  const question = ref<SignOutQuestion | null>(null)
  const saving = ref(false)
  const saveFailed = ref(false)
  /** The draft on screen, when saving its newest edits on this device failed: it is lost at the sign-out too. */
  let openUnsaved: string | null = null
  /** What had the focus when the sign-out was asked for (the Sign out button), for after Cancel. */
  let opener: HTMLElement | null = null

  async function signOutNow(): Promise<void> {
    question.value = null
    saveFailed.value = false
    opener = null
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

  /** Signs out, or asks first when drafts on this device never reached the server (or that cannot be checked). */
  async function request(): Promise<void> {
    if (auth.signingOut || question.value !== null) {
      return
    }
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
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
      // Which drafts are only here cannot be told: signing out without a word could delete them unannounced.
      saveFailed.value = false
      question.value = { count: null, checkError: errorMessage(cause) }
      return
    }
    if (count(drafts) === 0) {
      await signOutNow()
      return
    }
    saveFailed.value = false
    question.value = { count: count(drafts), checkError: null }
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
      question.value = { count: left, checkError: null }
    } catch (cause) {
      // The drafts could not be read again: the number asked about stays as it was.
      console.error('Saving the drafts before signing out failed', cause)
    }
    saving.value = false
    saveFailed.value = true
  }

  /** Stays signed in; the focus goes back to where the sign-out was asked for once the dialog has left the page. */
  async function cancel(): Promise<void> {
    question.value = null
    saveFailed.value = false
    const target = opener
    opener = null
    await nextTick()
    if (target?.isConnected) {
      target.focus()
    }
  }

  return { question, saving, saveFailed, request, saveFirst, signOutAnyway: signOutNow, cancel }
}
