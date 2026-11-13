import {
  cancelLocalReply,
  chatApiFailure,
  queueLocalReply,
  replyText,
  retryLocalReply,
  setLocalChatState,
  uuidV7,
  type ChatApi,
  type ChatPage,
  type MailStore,
  type SyncedChat,
  type SyncedChatOutgoing,
} from '@tresso/core'

/** Tresso's own state of a chat (never WhatsApp's): read through, out of the inbox through, left out. */
export interface ChatStateChange {
  readThrough?: string
  /** Null puts the chat back in the inbox. */
  archivedThrough?: string | null
  leftOut?: boolean
}

/**
 * What the user does in a chat, on one of two sides: the copy alone ("Only this Mac", the `wa:` rows the relay sends
 * from) or the server ("All my devices": the reply queue and the chat's state there, which every device gets through
 * the delta). The chat screens call these and never care which side they are on.
 */
export interface ChatActions {
  /**
   * Queues a reply (checked and trimmed by core's replyText). `id`: the id of an earlier try whose outcome was not known
   * (ChatActionError `unsure`), so the same reply is queued once whatever became of that try; a new UUIDv7 otherwise.
   */
  send(chatId: string, text: string, id?: string): Promise<SyncedChatOutgoing>
  /** Cancels a reply that waits or was not sent; one going out cannot be. */
  cancel(chatId: string, id: string): Promise<void>
  /** Try again: a reply that was not sent waits again. */
  retry(chatId: string, id: string): Promise<void>
  setState(chatId: string, change: ChatStateChange): Promise<SyncedChat>
}

export type ChatActionErrorCode =
  | 'empty'
  | 'too_long'
  | 'control'
  | 'no_chat'
  | 'left_out'
  | 'not_found'
  | 'already_going_out'
  | 'not_failed'
  | 'cancelled'
  | 'too_many'
  | 'no_access'
  | 'refused'
  | 'offline'
  | 'failed'
  | 'unsure'
  | 'maybe_queued'
  | 'wait'
  | 'other_number'

const TEXTS: Record<ChatActionErrorCode, string> = {
  empty: 'The reply is empty.',
  too_long: 'The reply is longer than 4096 characters.',
  control: 'The reply cannot contain control characters.',
  no_chat: 'The chat is not on this device.',
  left_out: 'The chat is left out.',
  not_found: 'The chat or reply is no longer on your Tresso server.',
  already_going_out: 'The reply is already going out.',
  not_failed: 'Only a reply that was not sent can be tried again.',
  cancelled: 'This reply was cancelled.',
  too_many: 'Too many WhatsApp replies at once. Wait a few minutes, then try again.',
  no_access: 'This session of Tresso may not change WhatsApp chats. Sign out and in again.',
  refused: 'Your Tresso server did not take this change.',
  offline: 'Tresso could not reach your Tresso server. Try again.',
  failed: 'Your Tresso server could not take this change just now. Try again.',
  unsure: 'Tresso could not tell whether your Tresso server took this reply; it may already be queued. Sending it again sends it once.',
  maybe_queued: 'This reply may already be queued or cancelled. Check the chat before you write it again.',
  wait: 'Your Tresso server asked Tresso to wait. Try again in a few minutes.',
  other_number:
    'This Mac is linked to another WhatsApp number than your Tresso server holds. Disconnect WhatsApp on the server first, or link this Mac to the same number.',
}

/**
 * A chat action that did not happen (or was put back); its message is plain words, never a chat's text or name. An
 * `unsure` reply carries the id it was sent with (`replyId`), to send it again under that id.
 */
export class ChatActionError extends Error {
  constructor(
    readonly code: ChatActionErrorCode,
    readonly replyId: string | null = null,
  ) {
    super(TEXTS[code])
    this.name = 'ChatActionError'
  }
}

/**
 * Whether a failed request may have been done by the server all the same: no answer (no network, a deadline, the session
 * ended while it ran), a 408, or a 5xx (a proxy's 502 after the API stored it). Sending it again with the same id is safe.
 */
export function unsureOutcome(error: unknown): boolean {
  const failure = chatApiFailure(error)
  return failure === null ? !(error instanceof ChatActionError) : failure.status === 408 || failure.status >= 500
}

/**
 * What a failed server request means for the user. `about`: a reply (a 429 is the reply limit) or any other change of
 * WhatsApp on the server (a 429 asks to wait).
 */
export function chatActionError(error: unknown, about: 'reply' | 'change' = 'reply'): ChatActionError {
  if (error instanceof ChatActionError) {
    return error
  }
  const failure = chatApiFailure(error)
  if (failure === null) {
    return new ChatActionError('offline')
  }
  switch (failure.status) {
    case 403:
      return new ChatActionError('no_access')
    case 404:
      return new ChatActionError('not_found')
    case 409:
      return new ChatActionError(
        failure.code === 'already_going_out'
          ? 'already_going_out'
          : failure.code === 'not_failed'
            ? 'not_failed'
            : failure.code === 'cancelled'
              ? 'cancelled'
              : failure.code === 'other_number'
                ? 'other_number'
                : 'refused',
      )
    case 422:
      return new ChatActionError('refused')
    case 429:
      return new ChatActionError(about === 'reply' ? 'too_many' : 'wait')
    default:
      return new ChatActionError('failed')
  }
}

/** The "Only this Mac" side: core's local actions on the copy (packages/core/src/chat/localBackend.ts). */
export function localChatActions(store: () => MailStore | null, now: () => number = Date.now): ChatActions {
  const copy = (): MailStore => {
    const current = store()
    if (current === null) {
      throw new ChatActionError('no_chat')
    }
    return current
  }
  return {
    send: (chatId, text, id) => queueLocalReply(copy(), chatId, text, id ?? uuidV7(now()), now()),
    async cancel(chatId, id) {
      await cancelLocalReply(copy(), chatId, id)
    },
    async retry(chatId, id) {
      await retryLocalReply(copy(), chatId, id)
    },
    setState: (chatId, change) => setLocalChatState(copy(), chatId, change),
  }
}

export interface ServerChatActionsOptions {
  api: ChatApi
  /** The copy; null while none is open. */
  store: () => MailStore | null
  /** Epoch ms now, for reply ids: the server's clock (auth.serverNow), since it takes ids at most 10 minutes old. */
  now?: () => number
  /** After every request, worked or not: a pull, so the copy gets the server's word (the mail store's syncNow). */
  pulled?: () => void
}

function later(next: string, current: string | null): boolean {
  const at = Date.parse(next)
  return Number.isFinite(at) && (current === null || !(Date.parse(current) >= at))
}

/**
 * The "All my devices" side: every action shows at once in the copy and goes to the server; when the server refuses
 * it (or cannot be reached) the copy is put back as it was, unless the delta changed that row meanwhile, the way the
 * mail store applies and reverts message actions. A reply is queued with a UUIDv7 made when the user pressed Send, so
 * a request repeated by the network never makes two. What the server answers replaces the shown row, unless the delta
 * brought a newer one meanwhile. Errors are ChatActionError, in plain words.
 */
export function serverChatActions(options: ServerChatActionsOptions): ChatActions {
  const { api } = options
  const now = options.now ?? Date.now

  const copy = (): MailStore => {
    const current = options.store()
    if (current === null) {
      throw new ChatActionError('no_chat')
    }
    return current
  }

  async function page(store: MailStore, chatId: string): Promise<ChatPage> {
    const found = await store.chatPage(chatId, { limit: 1 })
    if (found === null) {
      throw new ChatActionError('no_chat')
    }
    return found
  }

  async function outgoingRow(store: MailStore, chatId: string, id: string): Promise<SyncedChatOutgoing | null> {
    return (await store.chatPage(chatId, { limit: 1 }))?.outgoing.find((row) => row.id === id) ?? null
  }

  /**
   * Each read and write back of a row runs alone, so two answers arriving together never write over each other (one
   * putting a field back while the other writes the whole row as it read it before).
   */
  let writes: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = writes.then(work, work)
    writes = result.catch(() => undefined)
    return result
  }

  /** `next` in place of `shown`, when the copy still holds `shown` (the delta did not move it meanwhile). */
  function replaceReply(store: MailStore, shown: SyncedChatOutgoing, next: SyncedChatOutgoing): Promise<void> {
    return serial(async () => {
      const current = await outgoingRow(store, shown.chatId, shown.id)
      if (current !== null && JSON.stringify(current) === JSON.stringify(shown)) {
        await store.putChatOutgoing([next])
      }
    })
  }

  function replaceChat(store: MailStore, shown: SyncedChat, next: SyncedChat): Promise<void> {
    return serial(async () => {
      const current = (await store.chatPage(shown.id, { limit: 1 }))?.chat ?? null
      if (current !== null && JSON.stringify(current) === JSON.stringify(shown)) {
        await store.putChats([next])
      }
    })
  }

  function pulled(): void {
    options.pulled?.()
  }

  /** Per chat with changes under way: what the server last confirmed of it, to put a refused change back to. */
  const confirmed = new Map<string, { row: SyncedChat; pending: number }>()

  return {
    async send(chatId, text, again) {
      const store = copy()
      const checked = replyText(text)
      if (!checked.ok) {
        throw new ChatActionError(checked.problem)
      }
      const { chat } = await page(store, chatId)
      if (chat.leftOut) {
        throw new ChatActionError('left_out')
      }
      const at = now()
      const shown: SyncedChatOutgoing = {
        id: again ?? uuidV7(at),
        chatId,
        chatAccountId: chat.chatAccountId,
        text: checked.text,
        status: 'waiting',
        error: null,
        createdAt: new Date(at).toISOString(),
        claimedAt: null,
        sentAt: null,
      }
      await store.putChatOutgoing([shown])
      try {
        const queued = await api.queueReply(chatId, { id: shown.id, text: checked.text })
        await replaceReply(store, shown, queued)
        return queued
      } catch (error) {
        // Not queued as far as this device knows: the reply goes from the chat (a cancelled row is never shown) and the
        // composer keeps the text. When the server may have taken it all the same, the delta brings it back, and the
        // error carries its id: sent again, it is the same reply, never a second one.
        await replaceReply(store, shown, { ...shown, status: 'cancelled' })
        if (unsureOutcome(error)) {
          throw new ChatActionError('unsure', shown.id)
        }
        const failure = chatApiFailure(error)
        if (again !== undefined && failure?.status === 422 && failure.violationPaths.includes('id')) {
          // Too old to be queued now, and maybe queued (or cancelled) before: never under a new id by itself.
          throw new ChatActionError('maybe_queued')
        }
        throw chatActionError(error)
      } finally {
        pulled()
      }
    },

    async cancel(chatId, id) {
      const store = copy()
      const row = await outgoingRow(store, chatId, id)
      if (row === null) {
        throw new ChatActionError('not_found')
      }
      if (row.status === 'sending' || row.status === 'sent') {
        throw new ChatActionError('already_going_out')
      }
      if (row.status === 'cancelled') {
        return
      }
      const shown: SyncedChatOutgoing = { ...row, status: 'cancelled' }
      await store.putChatOutgoing([shown])
      try {
        await api.cancelReply(id)
      } catch (error) {
        // Gone from the server already: what the user wanted.
        if (chatApiFailure(error)?.status !== 404) {
          await replaceReply(store, shown, row)
          throw chatActionError(error)
        }
      } finally {
        pulled()
      }
    },

    async retry(chatId, id) {
      const store = copy()
      const row = await outgoingRow(store, chatId, id)
      if (row === null) {
        throw new ChatActionError('not_found')
      }
      if (row.status !== 'failed') {
        throw new ChatActionError('not_failed')
      }
      const shown: SyncedChatOutgoing = { ...row, status: 'waiting', error: null, claimedAt: null }
      await store.putChatOutgoing([shown])
      try {
        await replaceReply(store, shown, await api.retryReply(id))
      } catch (error) {
        await replaceReply(store, shown, row)
        throw chatActionError(error)
      } finally {
        pulled()
      }
    },

    async setState(chatId, change) {
      const store = copy()
      const { chat } = await page(store, chatId)
      // Read and archive only move forward on the server too; a request carries only what changes.
      const request: ChatStateChange = {}
      const shown: SyncedChat = { ...chat }
      if (change.readThrough !== undefined && later(change.readThrough, chat.readThrough)) {
        request.readThrough = change.readThrough
        shown.readThrough = change.readThrough
      }
      if (change.archivedThrough === null ? chat.archivedThrough !== null : change.archivedThrough !== undefined && later(change.archivedThrough, chat.archivedThrough)) {
        request.archivedThrough = change.archivedThrough
        shown.archivedThrough = change.archivedThrough ?? null
      }
      if (change.leftOut !== undefined && change.leftOut !== chat.leftOut) {
        request.leftOut = change.leftOut
        shown.leftOut = change.leftOut
      }
      if (Object.keys(request).length === 0) {
        return chat
      }
      // What the server last confirmed of this chat: the copy's row before the first change still under way.
      const base = confirmed.get(chatId) ?? { row: chat, pending: 0 }
      base.pending++
      confirmed.set(chatId, base)
      await store.putChats([shown])
      try {
        const answered = await api.updateChat(chatId, request)
        base.row = answered
        await replaceChat(store, shown, answered)
        return answered
      } catch (error) {
        // Field by field, back to what the server last confirmed, and only where the copy still shows this change: a
        // later change still under way, or the delta, keeps what it set.
        await serial(async () => {
          const current = (await store.chatPage(chatId, { limit: 1 }))?.chat ?? null
          if (current === null) {
            return
          }
          const back: SyncedChat = { ...current }
          let changed = false
          for (const field of Object.keys(request) as (keyof ChatStateChange)[]) {
            if (current[field] === shown[field] && current[field] !== base.row[field]) {
              ;(back as Record<keyof ChatStateChange, unknown>)[field] = base.row[field]
              changed = true
            }
          }
          if (changed) {
            await store.putChats([back])
          }
        })
        throw chatActionError(error, 'change')
      } finally {
        base.pending--
        if (base.pending === 0 && confirmed.get(chatId) === base) {
          confirmed.delete(chatId)
        }
        pulled()
      }
    },
  }
}
