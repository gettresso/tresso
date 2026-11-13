import { CHAT_MAX_FILE_BYTES, chatApiFailure, replyText, type MailStore, type SyncedChat, type SyncedChatOutgoing } from '@tresso/core'
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
  /** The content of a file the user picked, by its URI on the device (a fetch of it, which React Native backs natively). */
  readFile?(uri: string): Promise<Blob>
}

/** A file the user picked to send: where it is on the device, its name and its size in bytes. */
export interface PickedFile {
  uri: string
  name: string
  size: number
}

/**
 * A send whose outcome is unknown (no answer, a timeout, a server error): it may have been queued, so the same text in the
 * same chat goes again under its id. Kept in memory and in the copy's chat values (UNSURE_PREFIX), with a hash of the
 * text rather than the text, so a resend after the app was closed reuses the id too.
 */
interface Unsure {
  id: string
  chatId: string
  /** textHash of the trimmed text. */
  hash: string
  /** When the id was made (the server's time), epoch ms. */
  at: number
}

/** Before the chat id in the chat value that holds its unsure send (see Unsure). */
export const UNSURE_PREFIX = 'phone-unsure-reply:'

/** A read the server refused: not asked again for the same last message until the chat is looked at again. */
interface RefusedRead {
  lastMessageAt: string
  /** Not before this (epoch ms, the server's Retry-After), even when the chat is looked at again. */
  notBefore: number
  /** Until the screen is active or focused again. */
  held: boolean
}

/**
 * A 53-bit hash of a text (cyrb53), hex: enough to tell one reply text from another within one chat and nine minutes,
 * and not the text itself.
 */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/**
 * Whether a failed request may still have been done by the server: no answer (network, timeout), 408, or a server error
 * (5xx: a proxy may answer 502 or 504 after the API took it). Any other answer is a refusal.
 */
export function outcomeUnknown(error: unknown): boolean {
  const failure = chatApiFailure(error)
  return failure === null || failure.status === 408 || failure.status >= 500
}

/** A file on the device as a Blob, read by React Native's fetch of its URI. */
async function readDeviceFile(uri: string): Promise<Blob> {
  return (await fetch(uri)).blob()
}

function readUnsure(value: string | null): Unsure | null {
  if (value === null) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as Partial<Unsure>
    return typeof parsed.id === 'string' && typeof parsed.chatId === 'string' && typeof parsed.hash === 'string' && typeof parsed.at === 'number'
      ? { id: parsed.id, chatId: parsed.chatId, hash: parsed.hash, at: parsed.at }
      : null
  } catch {
    return null
  }
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
  /** Reads the server refused, per chat. */
  private readonly refusedRead = new Map<string, RefusedRead>()
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

  /** Files whose sending ended without an answer, by chat and file: the ids they went with, to go again under. */
  private readonly unsureFiles = new Map<string, { uploadId: string; replyId: string; at: number }>()

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
    const unsure = this.unsure.get(chatId)
    if (unsure !== undefined && byId.has(unsure.id)) {
      // It was queued after all: the same text sent again now is a new reply.
      this.forgetUnsure(chatId)
    } else if (unsure === undefined) {
      // One kept in the copy by an earlier run of the app, which this run has not read yet.
      void this.settleKept(chatId, byId)
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
    const hash = textHash(checked.text)
    let earlier = await this.unsureOf(store, chat.id, now)
    if (earlier !== null && earlier.hash === hash && (await this.copyHasReply(store, chat.id, earlier.id))) {
      // It was queued after all (the delta brought it): the same text again is a new reply, never swallowed.
      this.forgetUnsure(chat.id)
      earlier = null
    }
    const id = earlier !== null && earlier.hash === hash ? earlier.id : this.deps.newId(now)
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
      if (outcomeUnknown(error)) {
        await this.keepUnsure(store, { id, chatId: chat.id, hash, at: earlier?.id === id ? earlier.at : now })
      } else {
        this.forgetUnsure(chat.id)
      }
      this.emit()
      throw error
    }
    this.forgetUnsure(chat.id)
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
   * Sends a file: uploads it to the chat, then queues a reply that carries it for the relaying Mac. When the outcome is
   * not known, the same file in the same chat goes again under the same upload and reply ids within REUSE_ID_MS, so it
   * is queued once. At most CHAT_MAX_FILE_BYTES.
   *
   * @throws Error with what to tell the user, or the server's refusal or a network error as it came
   */
  async sendFile(chat: SyncedChat, file: PickedFile): Promise<SyncedChatOutgoing> {
    const store = this.deps.store()
    if (store === null) {
      throw new Error('The chat is not on this phone.')
    }
    if (file.size > CHAT_MAX_FILE_BYTES) {
      throw new Error(`${file.name} is larger than 100 MB, the most Tresso sends.`)
    }
    const now = this.deps.now()
    const key = `${chat.id}\n${file.name}\n${file.size}`
    const kept = this.unsureFiles.get(key)
    const earlier = kept !== undefined && now - kept.at < REUSE_ID_MS && now >= kept.at ? kept : null
    const uploadId = earlier?.uploadId ?? this.deps.newId(now)
    const id = earlier?.replyId ?? this.deps.newId(now)
    const waiting: SyncedChatOutgoing = {
      id,
      chatId: chat.id,
      chatAccountId: chat.chatAccountId,
      text: '',
      status: 'waiting',
      error: null,
      createdAt: new Date(now).toISOString(),
      claimedAt: null,
      sentAt: null,
      file: { name: file.name, size: file.size },
    }
    this.pending.set(chat.id, [...(this.pending.get(chat.id) ?? []).filter((reply) => reply.id !== id), waiting])
    this.emit()
    let queued: SyncedChatOutgoing
    try {
      const content = await (this.deps.readFile ?? readDeviceFile)(file.uri)
      await this.deps.api.uploadFile(chat.id, uploadId, content)
      queued = await this.deps.api.queueReply(chat.id, { id, text: '', file: { uploadId, name: file.name } })
    } catch (error) {
      const left = (this.pending.get(chat.id) ?? []).filter((reply) => reply.id !== id)
      if (left.length === 0) {
        this.pending.delete(chat.id)
      } else {
        this.pending.set(chat.id, left)
      }
      if (outcomeUnknown(error)) {
        this.unsureFiles.set(key, { uploadId, replyId: id, at: earlier?.at ?? now })
      } else {
        this.unsureFiles.delete(key)
      }
      this.emit()
      throw error
    }
    this.unsureFiles.delete(key)
    this.landed.add(id)
    this.pending.set(chat.id, (this.pending.get(chat.id) ?? []).map((reply) => (reply.id === id ? queued : reply)))
    this.emit()
    try {
      if (this.deps.store() === store) {
        await store.putChatOutgoing([queued])
        this.deps.changed()
      }
    } catch (error) {
      this.deps.onError?.('Keeping a queued reply on this phone failed', error)
    }
    return queued
  }

  /** Asks the relaying Mac for a message's file; nothing downloads without this. */
  async requestFile(messageId: string): Promise<void> {
    await this.deps.api.requestMedia(messageId)
  }

  /**
   * A fresh signed link to a file the server holds, to hand to the system (which downloads it, never runs it); with
   * `acceptUnscanned`, for a file that could not be checked, once the user accepted that. Null when it may not open yet.
   */
  async fileLink(messageId: string, acceptUnscanned = false): Promise<string | null> {
    const answer = acceptUnscanned ? await this.deps.api.unscannedMediaLink(messageId) : await this.deps.api.media(messageId)
    return answer.url
  }

  /** Forgets the unsure send the copy keeps for a chat when the copy has that reply now. */
  private async settleKept(chatId: string, byId: ReadonlyMap<string, SyncedChatOutgoing>): Promise<void> {
    const store = this.deps.store()
    if (store === null) {
      return
    }
    try {
      const kept = readUnsure(await store.chatMeta(UNSURE_PREFIX + chatId))
      if (kept !== null && byId.has(kept.id) && !this.unsure.has(chatId)) {
        this.forgetUnsure(chatId)
      }
    } catch (error) {
      this.deps.onError?.('Reading an unsure reply failed', error)
    }
  }

  /** The unsure send of a chat, from memory or the copy; null when there is none or it is too old to reuse. */
  private async unsureOf(store: MailStore, chatId: string, now: number): Promise<Unsure | null> {
    let unsure = this.unsure.get(chatId) ?? null
    if (unsure === null) {
      try {
        unsure = readUnsure(await store.chatMeta(UNSURE_PREFIX + chatId))
      } catch (error) {
        this.deps.onError?.('Reading an unsure reply failed', error)
      }
    }
    if (unsure === null || unsure.chatId !== chatId) {
      return null
    }
    if (!(now - unsure.at < REUSE_ID_MS && now >= unsure.at)) {
      this.forgetUnsure(chatId)
      return null
    }
    this.unsure.set(chatId, unsure)
    return unsure
  }

  /** Whether the copy holds a reply of the chat with this id. */
  private async copyHasReply(store: MailStore, chatId: string, id: string): Promise<boolean> {
    try {
      return ((await store.chatPage(chatId, { limit: 1 }))?.outgoing ?? []).some((reply) => reply.id === id)
    } catch (error) {
      this.deps.onError?.('Reading the replies of a chat failed', error)
      return false
    }
  }

  private async keepUnsure(store: MailStore, unsure: Unsure): Promise<void> {
    this.unsure.set(unsure.chatId, unsure)
    try {
      await store.setChatMeta(UNSURE_PREFIX + unsure.chatId, JSON.stringify(unsure))
    } catch (error) {
      this.deps.onError?.('Keeping an unsure reply failed', error)
    }
  }

  /** Forgets a chat's unsure send, in memory and in the copy. */
  private forgetUnsure(chatId: string): void {
    this.unsure.delete(chatId)
    const store = this.deps.store()
    if (store !== null) {
      store.setChatMeta(UNSURE_PREFIX + chatId, null).catch((error: unknown) => this.deps.onError?.('Forgetting an unsure reply failed', error))
    }
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
   * Resolves whether the server took it; a read already under way, or a chat read through already, does nothing. A read
   * the server refused (or that got no answer) is not asked again for the same last message until the chat is looked at
   * again (lookedAt), and never before its Retry-After: taking it back changes the copy, which would read the chat again.
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
      const refused = this.refusedRead.get(chat.id)
      if (refused !== undefined) {
        // Never before Retry-After, also not for a newer message; the same message waits until the chat is looked at again.
        if (this.deps.now() < refused.notBefore || (refused.lastMessageAt === stored.lastMessageAt && refused.held)) {
          return false
        }
        // A newer message came after the wait, or the chat is looked at again after it.
        this.refusedRead.delete(chat.id)
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
      if (target !== null) {
        this.refusedRead.set(chat.id, { lastMessageAt: target, notBefore: this.deps.now() + (chatApiFailure(error)?.retryAfterMs ?? 0), held: true })
      }
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

  /**
   * The chat is looked at again (the app came to the front, or the screen got the focus): a refused read may be asked
   * again, once its Retry-After passed.
   */
  lookedAt(chatId: string): void {
    const refused = this.refusedRead.get(chatId)
    if (refused !== undefined) {
      this.refusedRead.set(chatId, { ...refused, held: false })
    }
  }

  /** Forgets everything under way (a sign-out, another user): nothing of one user's chats stays for the next. */
  clear(): void {
    this.refusedRead.clear()
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
