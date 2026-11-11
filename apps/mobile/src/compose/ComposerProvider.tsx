import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { usePathname, useRouter } from 'expo-router'
import { Composer, type ComposerState, type SyncedMailAccount, type SyncedSignature } from '@tresso/core'
import { ApiError } from '@/auth/session'
import { useNotices } from '@/components/Notices'
import { useMail } from '@/mail/MailProvider'

interface ComposerContext {
  composer: Composer
  /** Writes and sends the forward of a hand-over in the background; it never opens the compose screen. */
  handOverComposer: Composer
  accounts: SyncedMailAccount[]
  signatures: SyncedSignature[]
}

const Context = createContext<ComposerContext | null>(null)

interface Loaded {
  accounts: SyncedMailAccount[]
  signatures: SyncedSignature[]
}

type Mail = ReturnType<typeof useMail>
type Notices = ReturnType<typeof useNotices>

/** What the composer reads when it is called, updated after every render (it lives as long as the provider). */
class Current {
  constructor(
    public mail: Mail,
    public notices: Notices,
    public loaded: Loaded,
    public onCompose: boolean,
  ) {}

  /** A push to the compose screen that the path does not show yet: another open does not push it again. */
  private pushing = false

  update(mail: Mail, notices: Notices, loaded: Loaded, onCompose: boolean): void {
    this.mail = mail
    this.notices = notices
    this.loaded = loaded
    this.onCompose = onCompose
    if (onCompose) {
      this.pushing = false
    }
  }

  /** Whether the compose screen should be pushed now; true once until the path shows it. */
  claimPush(): boolean {
    if (this.onCompose || this.pushing) {
      return false
    }
    this.pushing = true
    return true
  }

  /** Nothing to show (no draft open): a push that never arrived does not hold up the next one. */
  releasePush(): void {
    this.pushing = false
  }
}

function createComposer(current: Current, drafts: Mail['drafts']): Composer {
  return new Composer({
    store: () => current.mail.store(),
    drafts,
    accounts: () => current.loaded.accounts,
    signatures: () => current.loaded.signatures,
    defaultAccount: () => current.loaded.accounts[0]?.id ?? null,
    body: (messageId) => current.mail.body(messageId, false),
    send: (request) => current.mail.send(request),
    cancel: (outgoingId) => current.mail.cancelOutgoing(outgoingId),
    notify: (notice, ms) =>
      current.notices.notify(notice.action === undefined ? { text: notice.text, tone: notice.tone } : { text: notice.text, tone: notice.tone, action: notice.action }, ms),
    explain: (error) => ({ message: error instanceof Error ? error.message : String(error), violations: error instanceof ApiError ? error.violations : {} }),
    changed: () => current.mail.touch(),
    now: () => current.mail.serverNow?.() ?? Date.now(),
  })
}

/**
 * Writing mail on the phone, with the same Composer the web client uses (`packages/core/src/composer.ts`): drafts are
 * saved on the device and uploaded, a sent message waits a few seconds so it can be undone, and what became of it is
 * announced once. Whenever a draft opens, the compose screen shows it.
 */
export function ComposerProvider({ children }: { children: ReactNode }) {
  const mail = useMail()
  const notices = useNotices()
  const router = useRouter()
  const pathname = usePathname()
  const [loaded, setLoaded] = useState<Loaded>({ accounts: [], signatures: [] })

  const [current] = useState(() => new Current(mail, notices, loaded, pathname === '/compose'))
  useEffect(() => current.update(mail, notices, loaded, pathname === '/compose'))
  const [composer] = useState(() => createComposer(current, mail.drafts))
  useEffect(() => () => composer.dispose(), [composer])
  const [handOverComposer] = useState(() => createComposer(current, mail.drafts))
  useEffect(() => () => handOverComposer.dispose(), [handOverComposer])

  const { mailAccounts, signatures: loadSignatures, version, ready } = mail
  useEffect(() => {
    let current = true
    void Promise.all([mailAccounts(), loadSignatures()]).then(([accounts, signatures]) => {
      if (current) {
        setLoaded({ accounts, signatures })
      }
    })
    return () => {
      current = false
    }
  }, [mailAccounts, loadSignatures, version])

  // Whoever signs in next starts without the previous user's draft on screen; saved drafts stay in their own copy.
  const signedIn = mail.userId
  const previousUser = useRef(signedIn)
  useEffect(() => {
    if (previousUser.current !== signedIn) {
      previousUser.current = signedIn
      composer.reset()
      handOverComposer.reset()
    }
  }, [composer, handOverComposer, signedIn])

  useEffect(() => {
    let opened = composer.state.revision
    let undoable = composer.state.undoable
    let sending = composer.state.sending
    const show = () => {
      if (current.claimPush()) {
        router.push('/compose')
      }
    }
    const unsubscribe = composer.subscribe(() => {
      const { draft, revision, undoable: next, sending: nowSending, error } = composer.state
      if (draft === null) {
        current.releasePush()
      }
      // A new message, a reply, an undo or "edit and send again" opened a draft: show it.
      if (revision !== opened) {
        opened = revision
        if (draft !== null) {
          show()
        }
      }
      // A send that failed after the screen was closed: the draft and why are shown again.
      if (sending && !nowSending && draft !== null && error !== null) {
        show()
      }
      sending = nowSending
      // A message just sent waits a few seconds; until then it can be stopped and edited again.
      if (next !== null && next !== undoable) {
        current.notices.notify(
          { text: 'Sending…', tone: 'info', action: { label: 'Undo', accessibilityLabel: 'Undo sending', run: () => void composer.undo() } },
          Math.max(0, next.until - Date.now()),
        )
      }
      undoable = next
    })
    return unsubscribe
  }, [composer, current, router])

  // Every change to the copy may bring what became of a sent message.
  useEffect(() => {
    if (ready) {
      void composer.followUp()
    }
  }, [composer, ready, version])

  const value = useMemo(() => ({ composer, handOverComposer, accounts: loaded.accounts, signatures: loaded.signatures }), [composer, handOverComposer, loaded])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** The composer, what it is writing now, and the accounts and signatures to choose from. */
export function useComposer(): ComposerContext & { state: ComposerState } {
  const context = useContext(Context)
  if (context === null) {
    throw new Error('useComposer() is used outside <ComposerProvider>.')
  }
  const { composer } = context
  const state = useSyncExternalStore(
    (listener) => composer.subscribe(listener),
    () => composer.state,
  )
  return { ...context, state }
}
