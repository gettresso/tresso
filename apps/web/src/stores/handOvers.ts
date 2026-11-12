import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  Composer,
  followUpDraft,
  HandOverFlow,
  type HandedOver,
  type HandOverInput,
  type Nudged,
  type SyncedHandOver,
  type SyncedMessage,
} from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { dueLabel } from '@/mail/format'
import router from '@/router'
import { useAuthStore } from '@/stores/auth'
import { useComposeStore } from '@/stores/compose'
import { useMailStore } from '@/stores/mail'

/**
 * Handing conversations over and following them up in "Waiting on", on top of the shared HandOverFlow
 * (`packages/core/src/handOvers.ts`). The forward is written by a composer of its own, so handing over never touches
 * what the user is writing in the compose window.
 */
export const useHandOversStore = defineStore('handOvers', () => {
  const auth = useAuthStore()
  const mail = useMailStore()
  const compose = useComposeStore()

  const explain = (error: unknown) => ({ message: errorMessage(error), violations: error instanceof ApiError ? error.violations : {} })
  const composer = new Composer({
    store: () => mail.currentStore(),
    drafts: mail.draftSync,
    accounts: () => mail.accounts,
    signatures: () => mail.signatures,
    defaultAccount: () => mail.mailbox ?? mail.accounts[0]?.id ?? null,
    body: (messageId) => mail.body(messageId, false),
    send: (request) => mail.send(request),
    cancel: (outgoingId) => mail.cancelOutgoing(outgoingId),
    notify: (notice, ms) => compose.notify(notice, ms),
    explain,
    changed: () => {
      mail.refresh().catch((error: unknown) => console.error('Refreshing the lists failed', error))
    },
  })
  const flow = new HandOverFlow({
    composer,
    api: {
      create: (request) => auth.send<SyncedHandOver>('POST', '/api/v1/hand-overs', request),
      update: (id, request) => auth.send<SyncedHandOver>('PATCH', `/api/v1/hand-overs/${encodeURIComponent(id)}`, request),
      withdraw: (id) => auth.send<void>('DELETE', `/api/v1/hand-overs/${encodeURIComponent(id)}`),
      nudge: (id, request) => auth.send<SyncedHandOver>('POST', `/api/v1/hand-overs/${encodeURIComponent(id)}/nudge`, request),
    },
    cancel: (outgoingId) => mail.cancelOutgoing(outgoingId),
    outgoing: (outgoingId) => mail.outgoing(outgoingId),
    accounts: () => mail.accounts,
    signatures: () => mail.signatures,
    sync: () => mail.syncNow(),
    explain,
  })

  /** The message being handed over in the dialog; null while it is closed. */
  const handingOver = ref<SyncedMessage | null>(null)
  /** Who waits for the dialog's outcome (triage), and gives the notice itself; null when the dialog was opened plainly. */
  let waiter: ((handed: HandedOver | null) => void) | null = null

  function open(message: SyncedMessage): void {
    handingOver.value = message
  }

  /** The message of these a conversation is handed over by: the newest from someone else, or the newest at all. */
  function handOverMessage(messages: SyncedMessage[]): SyncedMessage | null {
    const own = new Set(mail.accounts.map((account) => account.emailAddress.toLowerCase()))
    const incoming = messages.filter((message) => !own.has(message.from.address.toLowerCase()))
    return incoming[incoming.length - 1] ?? messages[messages.length - 1] ?? null
  }

  /** Opens the dialog for a conversation. */
  async function openForThread(threadId: string): Promise<void> {
    const message = handOverMessage((await mail.thread(threadId))?.messages ?? [])
    if (message === null) {
      compose.notify({ text: 'This conversation no longer exists.', tone: 'error' })
      return
    }
    open(message)
  }

  /**
   * Opens the dialog for the messages of a conversation the user saw and settles once it closes: with the hand-over,
   * or null when the user closed it without handing over. The caller gives the notice (and its undo, see
   * {@link takeBack}).
   */
  async function handOverAndWait(messages: SyncedMessage[]): Promise<HandedOver | null> {
    const message = handOverMessage(messages)
    if (message === null) {
      throw new Error('This conversation no longer exists.')
    }
    settle(null)
    return new Promise((resolve) => {
      waiter = resolve
      open(message)
    })
  }

  function settle(handed: HandedOver | null): void {
    const waiting = waiter
    waiter = null
    waiting?.(handed)
  }

  function close(): void {
    handingOver.value = null
    settle(null)
  }

  /** Takes a hand-over back as far as it still can (see HandOverFlow.takeBack). */
  function takeBack(handed: HandedOver): Promise<'undone' | 'withdrawn'> {
    return flow.takeBack(handed)
  }

  /** Forwards and records it; the notice offers Undo until the forward leaves. Throws when it did not work. */
  async function handOver(message: SyncedMessage, input: HandOverInput): Promise<void> {
    const handed = await flow.handOver(message, input)
    if (waiter !== null) {
      handingOver.value = null
      settle(handed)
      return
    }
    close()
    const who = input.delegate.name?.trim() || input.delegate.address
    compose.notify({ text: `Handed over to ${who}.`, tone: 'info', action: { label: 'Undo', run: () => void undo(handed) } }, Math.max(1000, handed.until - Date.now()))
  }

  async function undo(handed: HandedOver): Promise<void> {
    try {
      await flow.undo(handed)
      compose.notify({ text: 'Not handed over.', tone: 'info' })
    } catch (error) {
      compose.notify({ text: errorMessage(error), tone: 'error' })
    }
  }

  async function nudge(handOver: SyncedHandOver, text: string): Promise<void> {
    const nudged = await flow.nudge(handOver, text)
    compose.notify({ text: 'Follow-up on its way.', tone: 'info', action: { label: 'Undo', run: () => void undoNudge(nudged) } }, Math.max(1000, nudged.until - Date.now()))
  }

  async function undoNudge(nudged: Nudged): Promise<void> {
    try {
      await flow.undoNudge(nudged)
      compose.notify({ text: 'Follow-up not sent.', tone: 'info' })
    } catch (error) {
      compose.notify({ text: errorMessage(error), tone: 'error' })
    }
  }

  /** "Edit first": the follow-up opens in the compose window as a reply to the delegate. */
  async function editFollowUp(handOver: SyncedHandOver, text: string): Promise<void> {
    const forward = handOver.forwardId === null ? null : await mail.outgoing(handOver.forwardId)
    compose.openPrepared(followUpDraft(handOver, text, forward?.subject ?? null))
  }

  /** Runs a change and says what went wrong, if anything. */
  async function change(run: () => Promise<unknown>, done: string): Promise<boolean> {
    try {
      await run()
      compose.notify({ text: done, tone: 'info' })
      return true
    } catch (error) {
      compose.notify({ text: errorMessage(error), tone: 'error' })
      return false
    }
  }

  function markDone(handOver: SyncedHandOver): Promise<boolean> {
    return change(() => flow.markDone(handOver), 'No longer waiting on it.')
  }

  function reopen(handOver: SyncedHandOver): Promise<boolean> {
    return change(() => flow.reopen(handOver), 'Back in Waiting on.')
  }

  function reschedule(handOver: SyncedHandOver, dueAt: Date): Promise<boolean> {
    return change(() => flow.reschedule(handOver, dueAt), `Now due ${dueLabel(dueAt.toISOString())}.`)
  }

  // Hand-overs past their due date without a reply: told in the app, with the nudge one click away.
  watch(
    () => mail.overdue,
    (overdue) => {
      if (overdue.length === 0) {
        return
      }
      for (const handOver of mail.takeOverdue()) {
        const who = handOver.delegate.name?.trim() || handOver.delegate.address
        compose.notify(
          {
            text: `No reply from ${who} on "${handOver.subject || '(no subject)'}" yet.`,
            tone: 'info',
            action: { label: 'Nudge', run: () => void router.push({ name: 'waiting', query: { nudge: handOver.id } }) },
          },
          30_000,
        )
      }
    },
  )

  /** Lets go of the hand-over on screen and what was being written for it, before another user's copy opens. */
  function reset(): void {
    composer.reset()
    close()
  }

  watch(
    () => auth.isAuthenticated,
    (authenticated) => {
      if (!authenticated) {
        reset()
      }
    },
  )

  return { reset, handingOver, open, openForThread, handOverAndWait, takeBack, close, handOver, nudge, editFollowUp, markDone, reopen, reschedule }
})
