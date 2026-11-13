import { chatApiFailure, replyText, type MailStore, type SyncedChat, type SyncedChatOutgoing } from '@tresso/core'
import type { PhoneChatApi } from '@/chat/chatApi'
import { replyProblemText } from '@/chat/texts'

/**
 * How long a reply id whose request got no answer is used again for the same text: the server takes an id made at most
 * 10 minutes before it first sees it (QueueReply), so a minute is left for clocks and the request itself.
 */
export const REUSE_ID_MS = 9 * 60 * 1000

export interface ChatActionsDeps {
  /** The open copy; null while none is open (signed out, switching users). */
  store(): MailStore | null
  api: PhoneChatApi
  now(): number
  /** A UUIDv7 made at this time (core's uuidV7). */
  newId(at: number): string
  /** The copy changed here: lists and screens read it again (MailSession.changed). */
  changed(): void
  /** Something went wrong that the user sees only by its effect (a chat that shows unread again); by name, no content. */
  onError?(what: string, error: unknown): void
}

/** A send in this chat whose request got no answer: it may have been queued, so the same text goes again under its id. */
interface Unsure {
  id: string
  text: string
  at: number
}

/**
 * What the user does in a chat on the phone ("All my devices": the replies go through the server's queue and the Mac
 * that relays sends them). Every change shows at once and is taken back when the server refuses it:
 *
 * - A reply shows as waiting while it is queued (held here, not in the copy: an app closed meanwhile must leave no
 *   reply behind that the server never got) and is stored in the copy with the server's answer. When the server refuses
 *   it, it goes and the text goes back in the box. When no answer came it may have been queued: the same text sent again
 *   in this chat within REUSE_ID_MS goes under the same id, which the server answers with the reply it has, never a
 *   second one.
 * - Cancel (a reply that waits) and Delete (one that was not sent) hide it until the server took it; Try again (only
 *   ever the user's) shows it as waiting until the server took it. A refusal shows it as it was.
 * - Opening a chat reads it in Tresso through its last message, in the copy first and then on the server; when the
 *   server does not take it, the copy goes back to what it was.
 *
 * Nothing here resends by itself, and nothing of a chat (text, names, numbers) is logged.
 */
export class ChatActions {
  /** Replies being queued, and queued ones until the copy has them, per chat. */
  private readonly pending = new Map<string, SyncedChatOutgoing[]>()
  /** Replies being cancelled or deleted, until the copy no longer shows them. */
  private readonly hidden = new Set<string>()
  /** Replies tried again, shown as waiting until the copy no longer has them as failed. */
  private readonly retrying = new Map<string, SyncedChatOutgoing>()
  private readonly unsure = new Map<string, Unsure>()
  /** Chats being read. */
  private readonly reading = new Set<string>()
  private readonly listeners = new Set<() => void>()
  /** Replies the server answered, until the copy has them (see settle). */
  private readonly landed = new Set<string>()
  /** The chat of each hidden reply. */
  private readonly hiddenIn = new Map<string, string>()
  /** Cancels and retries whose request is under way. */
  private readonly cancelling = new Set<string>()
  private readonly retryingNow = new Set<string>()

  constructor(private readonly deps: ChatActionsDeps) {}

  /** Calls back whenever what `shown` returns may have changed; returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The replies of a chat as its screen shows them: the stored ones with the changes under way, and those being queued. */
  shown(chatId: string, stored: readonly SyncedChatOutgoing[]): SyncedChatOutgoing[] {
    const ids = new Set(stored.map((reply) => reply.id))
    const rows = stored.filter((reply) => !this.hidden.has(reply.id)).map((reply) => (reply.status === 'failed' ? (this.retrying.get(reply.id) ?? reply) : reply))
    for (const reply of this.pending.get(chatId) ?? []) {
      if (!ids.has(reply.id)) {
        rows.push(reply)
      }
    }
    return rows
  }

  /**
   * Forgets the changes the copy shows now (`stored` is every reply of the chat, as a window of it reads them): a queued
   * reply it has, a cancelled one it no longer lists as waiting or failed, a retried one it no longer has as failed.
   */
  settle(chatId: string, stored: readonly SyncedChatOutgoing[]): void {
    const byId = new Map(stored.map((reply) => [reply.id, reply]))
    let changed = false
    const pending = this.pending.get(chatId)
    if (pending !== undefined) {
      // A reply still being queued stays; one the server answered goes once the copy has it.
      const kept = pending.filter((reply) => !(this.landed.has(reply.id) && byId.has(reply.id)))
      if (kept.length !== pending.length) {
        changed = true
        for (const reply of pending) {
          if (!kept.includes(reply)) {
            this.landed.delete(reply.id)
          }
        }
      }
      if (kept.length === 0) {
        this.pending.delete(chatId)
      } else {
        this.pending.set(chatId, kept)
      }
    }
    for (const id of [...this.hidden]) {
      const row = byId.get(id)
      if (this.hiddenIn.get(id) === chatId && (row === undefined || row.status === 'cancelled') && !this.cancelling.has(id)) {
        this.hidden.delete(id)
        this.hiddenIn.delete(id)
        changed = true
      }
    }
    for (const [id, row] of [...this.retrying]) {
      if (row.chatId === chatId && byId.get(id)?.status !== 'failed' && !this.retryingNow.has(id)) {
        this.retrying.delete(id)
        changed = true
      }
    }
    if (changed) {
      this.emit()
    }
  }

  /**
   * Queues a reply (checked and trimmed by core's replyText).
   *
   * @throws Error with what to tell the user when the text cannot be sent; the server's refusal (ApiError) or a network
   *   error as it came, after which the reply is gone from the screen and its text belongs back in the box
   */
  async send(chat: SyncedChat, text: string): Promise<SyncedChatOutgoing> {
    const checked = replyText(text)
    if (!checked.ok) {
      throw new Error(replyProblemText(checked.problem) ?? 'Write a reply first.')
    }
    const store = this.deps.store()
    if (store === null) {
      throw new Error('The chat is not on this phone.')
    }
    const now = this.deps.now()
    const earlier = this.unsure.get(chat.id)
    const id = earlier !== undefined && earlier.text === checked.text && now - earlier.at < REUSE_ID_MS ? earlier.id : this.deps.newId(now)
    const waiting: SyncedChatOutgoing = {
      id,
      chatId: chat.id,
      chatAccountId: chat.chatAccountId,
      text: checked.text,
      status: 'waiting',
      error: null,
      createdAt: new Date(now).toISOString(),
      claimedAt: null,
      sentAt: null,
    }
    this.pending.set(chat.id, [...(this.pending.get(chat.id) ?? []).filter((reply) => reply.id !== id), waiting])
    this.emit()
    let queued: SyncedChatOutgoing
    try {
      queued = await this.deps.api.queueReply(chat.id, { id, text: checked.text })
    } catch (error) {
      const left = (this.pending.get(chat.id) ?? []).filter((reply) => reply.id !== id)
      if (left.length === 0) {
        this.pending.delete(chat.id)
      } else {
        this.pending.set(chat.id, left)
      }
      if (chatApiFailure(error) === null) {
        this.unsure.set(chat.id, { id, text: checked.text, at: earlier?.id === id ? earlier.at : now })
      } else {
        this.unsure.delete(chat.id)
      }
      this.emit()
      throw error
    }
    this.unsure.delete(chat.id)
    // Shown as the server has it until the copy has it too (see settle; the delta brings the same row).
    this.landed.add(id)
    this.pending.set(chat.id, (this.pending.get(chat.id) ?? []).map((reply) => (reply.id === id ? queued : reply)))
    this.emit()
    try {
      if (this.deps.store() === store) {
        await store.putChatOutgoing([queued])
        this.deps.changed()
      }
    } catch (error) {
      // It is queued; the screen shows it from here until the delta brings it.
      this.deps.onError?.('Keeping a queued reply on this phone failed', error)
    }
    return queued
  }

  /**
   * Cancels a reply that waits (the server answers 409 `already_going_out` once the Mac took it), or deletes one that was
   * not sent. A reply the server no longer has (404) is gone either way.
   */
  async cancel(reply: SyncedChatOutgoing): Promise<void> {
    if (this.cancelling.has(reply.id)) {
      return
    }
    const store = this.deps.store()
    this.cancelling.add(reply.id)
    this.hidden.add(reply.id)
    this.hiddenIn.set(reply.id, reply.chatId)
    this.emit()
    try {
      try {
        await this.deps.api.cancelReply(reply.id)
      } catch (error) {
        if (chatApiFailure(error)?.status !== 404) {
          throw error
        }
      }
      // Hidden in the copy until the delta's removal takes it out.
      if (store !== null && this.deps.store() === store) {
        await store.putChatOutgoing([{ ...reply, status: 'cancelled' }])
        this.deps.changed()
      }
    } catch (error) {
      this.hidden.delete(reply.id)
      this.hiddenIn.delete(reply.id)
      throw error
    } finally {
      this.cancelling.delete(reply.id)
      this.emit()
    }
  }

  /** The user's Try again: a reply that was not sent waits for the Mac again. The only way one goes out again. */
  async retry(reply: SyncedChatOutgoing): Promise<void> {
    if (this.retryingNow.has(reply.id)) {
      return
    }
    const store = this.deps.store()
    this.retryingNow.add(reply.id)
    this.retrying.set(reply.id, { ...reply, status: 'waiting', error: null, claimedAt: null })
    this.emit()
    try {
      const again = await this.deps.api.retryReply(reply.id)
      this.retrying.set(reply.id, again)
      if (store !== null && this.deps.store() === store) {
        await store.putChatOutgoing([again])
        this.deps.changed()
      }
    } catch (error) {
      this.retrying.delete(reply.id)
      throw error
    } finally {
      this.retryingNow.delete(reply.id)
      this.emit()
    }
  }

  /**
   * Reads a chat in Tresso through its last message (never in WhatsApp: the phone keeps its own unread state there).
   * Resolves whether the server took it; a read already under way, or a chat read through already, does nothing.
   */
  async markRead(chat: Pick<SyncedChat, 'id' | 'chatAccountId' | 'jid'>): Promise<boolean> {
    const store = this.deps.store()
    if (store === null || this.reading.has(chat.id)) {
      return false
    }
    this.reading.add(chat.id)
    let target: string | null = null
    let previous: string | null = null
    try {
      const stored = await store.chatByJid(chat.chatAccountId, chat.jid)
      if (stored === null || stored.id !== chat.id || stored.leftOut || !after(stored.lastMessageAt, stored.readThrough)) {
        return false
      }
      target = stored.lastMessageAt
      previous = stored.readThrough
      await store.putChats([{ ...stored, readThrough: target }])
      this.deps.changed()
      const answer = await this.deps.api.updateChat(chat.id, { readThrough: target })
      if (this.deps.store() === store) {
        await store.putChats([answer])
        this.deps.changed()
      }
      return true
    } catch (error) {
      this.deps.onError?.('Reading the chat on the server failed', error)
      if (target !== null && this.deps.store() === store) {
        try {
          const now = await store.chatByJid(chat.chatAccountId, chat.jid)
          // Only what this read wrote goes back: a newer read (the delta, another device) stays.
          if (now !== null && now.id === chat.id && now.readThrough === target) {
            await store.putChats([{ ...now, readThrough: previous }])
            this.deps.changed()
          }
        } catch (rollback) {
          this.deps.onError?.('Taking back the read of a chat failed', rollback)
        }
      }
      return false
    } finally {
      this.reading.delete(chat.id)
    }
  }

  /** Forgets everything under way (a sign-out, another user): nothing of one user's chats stays for the next. */
  clear(): void {
    this.pending.clear()
    this.hidden.clear()
    this.hiddenIn.clear()
    this.retrying.clear()
    this.unsure.clear()
    this.landed.clear()
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener()
    }
  }
}

/** Whether `time` lies after `through` (null, or a time that does not parse, is never). */
function after(time: string, through: string | null): boolean {
  const at = Date.parse(time)
  if (Number.isNaN(at)) {
    return false
  }
  const read = through === null ? Number.NaN : Date.parse(through)
  return Number.isNaN(read) || at > read
}
