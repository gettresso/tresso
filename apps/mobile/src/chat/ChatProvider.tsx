import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { chatOnlyHere, uuidV7, type ChatMessageKey, type ChatPage, type ChatSummary, type SyncedChatAccount } from '@tresso/core'
import { useAuth } from '@/auth/AuthProvider'
import { ChatActions } from '@/chat/chatActions'
import { phoneChatApi } from '@/chat/chatApi'
import { useMail } from '@/mail/MailProvider'
import { todoApi } from '@/mail/todoApi'

/** Chats the Unified Inbox lists at most, as many as its mail (MailProvider's LIST_LIMIT). */
export const CHAT_LIST_LIMIT = 200

export interface Chats {
  /**
   * The user's WhatsApp account on the server ("All my devices": a Mac relays it); null when there is none, also when
   * WhatsApp is set to "Only this Mac". Without it the phone shows nothing of WhatsApp.
   */
  account: SyncedChatAccount | null
  /** The copy was read for the account at least once since it opened; until then `account` null means nothing yet. */
  accountRead: boolean
  /** The account's chats the Unified Inbox shows (not archived, not left out), newest first; empty without an account. */
  inbox: ChatSummary[]
  /** A window of a chat (MailStore.chatPage); null when the chat is not on the phone. */
  page(chatId: string, options: { limit: number; before?: ChatMessageKey | null; from?: ChatMessageKey | null }): Promise<ChatPage | null>
  actions: ChatActions
  /** Goes up whenever the replies under way change (see ChatActions.shown). */
  revision: number
  /** What was typed into a chat and not sent; kept in memory while the app runs, '' when nothing. */
  draftOf(chatId: string): string
  setDraft(chatId: string, text: string): void
  /** Makes a todo with this title (the chat's `Reply to <name>`, which the user saw and may have changed). */
  createTodo(title: string): Promise<void>
}

const ChatContext = createContext<Chats | null>(null)

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/** Whether an account is the server's WhatsApp account (never one kept only on a desktop). */
export function serverWhatsApp(accounts: readonly SyncedChatAccount[]): SyncedChatAccount | null {
  return accounts.find((account) => account.channel === 'whatsapp' && !chatOnlyHere(account.id)) ?? null
}

/**
 * The user's WhatsApp chats on the phone, read from the copy the delta keeps (the chat lists of the sync), and what the
 * user does in them (ChatActions over the chat endpoints). The phone only ever sees chats the server holds.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const mail = useMail()
  const { store, version, userId, touch, syncNow } = mail
  const [account, setAccount] = useState<SyncedChatAccount | null>(null)
  /** The store the account was last read from: `accountRead` is true only for the one open now. */
  const [readFrom, setReadFrom] = useState<object | null>(null)
  const [inbox, setInbox] = useState<ChatSummary[]>([])
  const [revision, setRevision] = useState(0)
  const drafts = useRef(new Map<string, string>())

  const actions = useMemo(
    () =>
      new ChatActions({
        store,
        api: phoneChatApi((path, init) => auth.session.api(path, init)),
        // The server's time: a reply id is a UUIDv7 the server takes only when it was made about now by its clock.
        now: () => auth.session.serverNow(),
        newId: (at) => uuidV7(at),
        changed: touch,
        onError: (what, error) => console.error(what, errorName(error)),
      }),
    [store, auth.session, touch],
  )
  useEffect(() => actions.subscribe(() => setRevision((value) => value + 1)), [actions])

  // Another user, or none: nothing typed or under way stays behind.
  useEffect(() => {
    drafts.current.clear()
    actions.clear()
  }, [userId, actions])

  useEffect(() => {
    let current = true
    const copy = store()
    void (async () => {
      try {
        const found = copy === null ? null : serverWhatsApp(await copy.chatAccounts())
        const chats = copy === null || found === null ? [] : (await copy.chats({ inboxOnly: true, limit: CHAT_LIST_LIMIT })).filter((summary) => summary.chat.chatAccountId === found.id)
        if (current) {
          setAccount(found)
          setInbox(chats)
          setReadFrom(copy)
          // WhatsApp went (the account removed, or set to "Only this Mac"): what was typed into its chats goes along.
          if (found === null) {
            drafts.current.clear()
          }
        }
      } catch (error) {
        console.error('Reading the chats failed', errorName(error))
      }
    })()
    return () => {
      current = false
    }
  }, [store, version])

  const page = useCallback(
    async (chatId: string, options: { limit: number; before?: ChatMessageKey | null; from?: ChatMessageKey | null }) => {
      const copy = store()
      return copy === null ? null : copy.chatPage(chatId, options)
    },
    [store],
  )
  const draftOf = useCallback((chatId: string) => drafts.current.get(chatId) ?? '', [])
  const setDraft = useCallback((chatId: string, text: string) => {
    if (text === '') {
      drafts.current.delete(chatId)
    } else {
      drafts.current.set(chatId, text)
    }
  }, [])
  const todos = useMemo(() => todoApi((path, init) => auth.session.api(path, init)), [auth.session])
  const createTodo = useCallback(
    async (title: string) => {
      await todos.create({ title })
      await syncNow()
    },
    [todos, syncNow],
  )

  // Read for the copy open now (a copy that is not open yet, or another user's, has not been read).
  const accountRead = readFrom !== null && readFrom === store()
  const value = useMemo<Chats>(
    () => ({ account, accountRead, inbox, page, actions, revision, draftOf, setDraft, createTodo }),
    [account, accountRead, inbox, page, actions, revision, draftOf, setDraft, createTodo],
  )
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChats(): Chats {
  const chats = useContext(ChatContext)
  if (chats === null) {
    throw new Error('useChats() is used outside <ChatProvider>.')
  }
  return chats
}
