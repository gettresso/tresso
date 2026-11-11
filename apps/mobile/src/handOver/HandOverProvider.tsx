import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'expo-router'
import { HandOverFlow, nudgeText, type Composer, type HandedOver, type HandOverInput, type SyncedHandOver, type SyncedMailAccount, type SyncedMessage, type SyncedSignature } from '@tresso/core'
import { useComposer } from '@/compose/ComposerProvider'
import { useNotices } from '@/components/Notices'
import { dueLabel } from '@/handOver/format'
import { useMail } from '@/mail/MailProvider'
import { HandOverWaiters } from '@/handOver/waiters'

interface HandOvers {
  /**
   * Forwards the message and records the hand-over; a notice offers Undo until the forward leaves. When someone waits
   * for the conversation (see `handOverAndWait`), they get the hand-over and give the notice instead.
   */
  handOver(message: SyncedMessage, input: HandOverInput): Promise<void>
  /**
   * Opens the hand-over screen for a message of a conversation (one the user saw) and settles once it closes: with the
   * hand-over, or null when the user closed it without handing over (triage).
   */
  handOverAndWait(threadId: string, messageId: string): Promise<HandedOver | null>
  /** The hand-over screen of a conversation closed. */
  closed(threadId: string): void
  /** Takes a hand-over back as far as it still can (see HandOverFlow.takeBack). */
  takeBack(handed: HandedOver): Promise<'undone' | 'withdrawn'>
  /** Sends the suggested follow-up right away (after the undo window). */
  nudge(handOver: SyncedHandOver): Promise<void>
  markDone(handOver: SyncedHandOver): Promise<void>
  reopen(handOver: SyncedHandOver): Promise<void>
}

const Context = createContext<HandOvers | null>(null)

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Mail = ReturnType<typeof useMail>

/** What the flow reads when it is called, updated after every render (it lives as long as the provider). */
class Latest {
  constructor(
    public mail: Mail,
    public accounts: SyncedMailAccount[],
    public signatures: SyncedSignature[],
  ) {}

  update(mail: Mail, accounts: SyncedMailAccount[], signatures: SyncedSignature[]): void {
    this.mail = mail
    this.accounts = accounts
    this.signatures = signatures
  }
}

function createFlow(latest: Latest, composer: Composer): HandOverFlow {
  return new HandOverFlow({
    composer,
    api: {
      create: (request) => latest.mail.handOverApi.create(request),
      update: (id, request) => latest.mail.handOverApi.update(id, request),
      withdraw: (id) => latest.mail.handOverApi.withdraw(id),
      nudge: (id, request) => latest.mail.handOverApi.nudge(id, request),
    },
    cancel: (outgoingId) => latest.mail.cancelOutgoing(outgoingId),
    outgoing: (outgoingId) => latest.mail.outgoing(outgoingId),
    accounts: () => latest.accounts,
    signatures: () => latest.signatures,
    sync: () => latest.mail.syncNow(),
    explain: (error) => ({ message: message(error) }),
    now: () => latest.mail.serverNow?.() ?? Date.now(),
  })
}

/**
 * Handing over and following up on the phone, with the same HandOverFlow the web client uses
 * (`packages/core/src/handOvers.ts`). Hand-overs past their due date are told about here, with the nudge a tap away.
 */
export function HandOverProvider({ children }: { children: ReactNode }) {
  const mail = useMail()
  const notices = useNotices()
  const router = useRouter()
  const { handOverComposer, accounts, signatures } = useComposer()

  // The flow lives as long as the provider; what it reads is updated after every render.
  const [latest] = useState(() => new Latest(mail, accounts, signatures))
  useEffect(() => latest.update(mail, accounts, signatures))
  const [flow] = useState(() => createFlow(latest, handOverComposer))
  const [waiters] = useState(() => new HandOverWaiters())

  const { overdue, clearOverdue } = mail
  useEffect(() => {
    const first = overdue[0]
    if (first === undefined) {
      return
    }
    clearOverdue(overdue.map((handOver) => handOver.id))
    const who = first.delegate.name?.trim() || first.delegate.address
    const text = overdue.length === 1 ? `No reply from ${who} on "${first.subject || '(no subject)'}" yet.` : `${overdue.length} hand-overs are past their due date.`
    notices.notify({ text, tone: 'info', action: { label: 'Waiting on', accessibilityLabel: 'Open Waiting on', run: () => router.push('/waiting') } }, 30_000)
  }, [overdue, clearOverdue, notices, router])

  const value = useMemo<HandOvers>(
    () => ({
      async handOver(original, input) {
        const handed = await flow.handOver(original, input)
        if (waiters.has(original.threadId)) {
          waiters.settle(original.threadId, handed)
          return
        }
        const who = input.delegate.name?.trim() || input.delegate.address
        notices.notify(
          {
            text: `Handed over to ${who}.`,
            tone: 'info',
            action: {
              label: 'Undo',
              accessibilityLabel: 'Undo the hand-over',
              run: () =>
                void flow.undo(handed).then(
                  () => notices.notify({ text: 'Not handed over.', tone: 'info' }),
                  (error: unknown) => notices.notify({ text: message(error), tone: 'error' }),
                ),
            },
          },
          Math.max(1000, handed.until - Date.now()),
        )
      },
      handOverAndWait(threadId, messageId) {
        const waiting = waiters.wait(threadId)
        router.push({ pathname: '/hand-over', params: { threadId, messageId } })
        return waiting
      },
      closed(threadId) {
        waiters.settle(threadId, null)
      },
      takeBack(handed) {
        return flow.takeBack(handed)
      },
      async nudge(handOver) {
        try {
          const nudged = await flow.nudge(handOver, nudgeText(handOver, dueLabel(handOver.dueAt)))
          notices.notify(
            {
              text: 'Follow-up on its way.',
              tone: 'info',
              action: {
                label: 'Undo',
                accessibilityLabel: 'Undo the follow-up',
                run: () =>
                  void flow.undoNudge(nudged).then(
                    () => notices.notify({ text: 'Follow-up not sent.', tone: 'info' }),
                    (error: unknown) => notices.notify({ text: message(error), tone: 'error' }),
                  ),
              },
            },
            Math.max(1000, nudged.until - Date.now()),
          )
        } catch (error) {
          notices.notify({ text: message(error), tone: 'error' })
        }
      },
      async markDone(handOver) {
        try {
          await flow.markDone(handOver)
          notices.notify({ text: 'No longer waiting on it.', tone: 'info', action: { label: 'Undo', run: () => void flow.reopen(handOver) } })
        } catch (error) {
          notices.notify({ text: message(error), tone: 'error' })
        }
      },
      async reopen(handOver) {
        try {
          await flow.reopen(handOver)
          notices.notify({ text: 'Back in Waiting on.', tone: 'info' })
        } catch (error) {
          notices.notify({ text: message(error), tone: 'error' })
        }
      },
    }),
    [flow, notices, waiters, router],
  )

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useHandOvers(): HandOvers {
  const handOvers = useContext(Context)
  if (handOvers === null) {
    throw new Error('useHandOvers() is used outside <HandOverProvider>.')
  }
  return handOvers
}
