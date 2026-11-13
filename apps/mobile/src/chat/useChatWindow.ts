import { useCallback, useEffect, useRef, useState } from 'react'
import { chatMessageKey, type ChatMessageKey, type ChatPage, type SyncedChat, type SyncedChatMessage, type SyncedChatOutgoing } from '@tresso/core'

/** Messages read at a time. */
export const CHAT_PAGE = 50

export interface ChatWindow {
  /** The first read is done. */
  loaded: boolean
  /** Null once read when the chat is not on the phone. */
  chat: SyncedChat | null
  /** The messages read so far, oldest first. */
  messages: SyncedChatMessage[]
  /** Every reply of the chat as the copy has it, oldest first. */
  outgoing: SyncedChatOutgoing[]
  /** Older messages than the first one here exist. */
  hasOlder: boolean
  loadingOlder: boolean
  /** Reads the CHAT_PAGE messages before the first one here. */
  loadOlder(): void
}

interface Win {
  chat: SyncedChat | null
  messages: SyncedChatMessage[]
  outgoing: SyncedChatOutgoing[]
  hasOlder: boolean
}

const EMPTY: Win = { chat: null, messages: [], outgoing: [], hasOlder: false }

type Read = (chatId: string, options: { limit: number; before?: ChatMessageKey | null; from?: ChatMessageKey | null }) => Promise<ChatPage | null>

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/**
 * A chat read in windows, so a chat of thousands of messages never loads at once: the newest CHAT_PAGE first, older ones
 * on request (`loadOlder`, when the list reaches its top), and the window again from its first message whenever the copy
 * changed (`version`), never with fewer messages than it holds. Reads take turns, each on the window as the one before
 * left it, so an older page and a re-read never undo each other. `onPage` sees every page read (ChatActions.settle).
 */
export function useChatWindow(chatId: string, read: Read, version: number, onPage: (page: ChatPage) => void): ChatWindow {
  const [win, setWin] = useState<Win>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const current = useRef<Win>(win)
  /** The reads in turn. */
  const queue = useRef<Promise<void>>(Promise.resolve())
  /** Which chat the window is of; a read for another one lands nowhere. */
  const shownChat = useRef<string | null>(null)
  /** The version the window was last read at; a re-read for it again is skipped. */
  const readAt = useRef<number | null>(null)
  const olderQueued = useRef(false)
  const latest = useRef({ read, onPage, version })
  // First among the effects, so the reads below always see this render's values.
  useEffect(() => {
    latest.current = { read, onPage, version }
  })
  // Another chat in the same screen starts empty, before its first read lands.
  const [windowOf, setWindowOf] = useState(chatId)
  if (windowOf !== chatId) {
    setWindowOf(chatId)
    setWin(EMPTY)
    setLoaded(false)
  }

  const take = useCallback((next: Win) => {
    current.current = next
    setWin(next)
  }, [])

  const enqueue = useCallback((task: () => Promise<void>) => {
    queue.current = queue.current.then(task).catch((error: unknown) => {
      // The window stays as it is; the next change of the copy reads it again.
      console.error('Reading the chat failed', errorName(error))
    })
  }, [])

  // The first window of a chat: its newest messages.
  useEffect(() => {
    shownChat.current = chatId
    readAt.current = null
    current.current = EMPTY
    enqueue(async () => {
      const at = latest.current.version
      const page = await latest.current.read(chatId, { limit: CHAT_PAGE })
      if (shownChat.current !== chatId) {
        return
      }
      readAt.current = at
      take(page === null ? EMPTY : { chat: page.chat, messages: page.messages, outgoing: page.outgoing, hasOlder: page.hasOlder })
      if (page !== null) {
        latest.current.onPage(page)
      }
      setLoaded(true)
    })
    return () => {
      shownChat.current = null
    }
  }, [chatId, enqueue, take])

  // The copy changed: the window again, from its first message on.
  useEffect(() => {
    enqueue(async () => {
      const at = latest.current.version
      if (shownChat.current !== chatId || readAt.current === null || readAt.current === at) {
        return
      }
      const first = current.current.messages[0]
      const page = await latest.current.read(chatId, {
        limit: Math.max(CHAT_PAGE, current.current.messages.length + CHAT_PAGE),
        from: first === undefined ? null : chatMessageKey(first),
      })
      if (shownChat.current !== chatId) {
        return
      }
      readAt.current = at
      if (page === null) {
        take(EMPTY)
        return
      }
      take({ chat: page.chat, messages: page.messages, outgoing: page.outgoing, hasOlder: page.hasOlder })
      latest.current.onPage(page)
    })
  }, [chatId, version, enqueue, take])

  const loadOlder = useCallback(() => {
    if (olderQueued.current || !current.current.hasOlder) {
      return
    }
    olderQueued.current = true
    setLoadingOlder(true)
    enqueue(async () => {
      try {
        const first = current.current.messages[0]
        if (shownChat.current !== chatId || first === undefined || !current.current.hasOlder) {
          return
        }
        const page = await latest.current.read(chatId, { limit: CHAT_PAGE, before: chatMessageKey(first) })
        if (shownChat.current !== chatId || page === null) {
          return
        }
        take({ chat: page.chat, messages: [...page.messages, ...current.current.messages], outgoing: page.outgoing, hasOlder: page.hasOlder })
        latest.current.onPage(page)
      } finally {
        olderQueued.current = false
        setLoadingOlder(false)
      }
    })
  }, [chatId, enqueue, take])

  return { loaded, chat: win.chat, messages: win.messages, outgoing: win.outgoing, hasOlder: win.hasOlder, loadingOlder, loadOlder }
}
