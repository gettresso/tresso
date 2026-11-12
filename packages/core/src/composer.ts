import { isPlausibleAddress, quotedInlineImages, quoteWithContentId, withInlineLinks, type SendMessageRequest } from './compose'
import { AttachmentsNeedTheServer, defaultSignatureOf, editedFields, newDraft, reopenedDraft, replyDraft, sendRequest, sentOutcome, withEditsOver, withoutLink, type AttachmentFile, type DraftBase, type DraftSync } from './drafts'
import { uuidV7 } from './ids'
import { CopyClosingError, type Draft, type MailStore } from './store/mailStore'
import type { Address, AttachmentAccess, DraftAttachment, MessageAttachment, MessageBody, SyncedMailAccount, SyncedMessage, SyncedOutgoingMessage, SyncedSignature } from './sync/types'

/** Seconds a sent message waits before it goes out, so "Undo" can still stop it. */
export const UNDO_SECONDS = 5
const AUTOSAVE_MS = 800
/** How often saveNow writes edits typed while it saves before it gives up. */
const SAVE_NOW_ROUNDS = 5
/** What the API accepts; the web form's schema (apps/web/src/forms/compose.ts) checks the same. */
export const MAX_RECIPIENTS = 100
export const MAX_SUBJECT = 998
export const MAX_HTML = 2_000_000

/** A forward was asked for, but the message it forwards could not be loaded (its text and files would be missing). */
export class OriginalUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OriginalUnavailableError'
  }
}

export interface ComposerNotice {
  text: string
  tone: 'info' | 'error'
  action?: { label: string; run: () => void }
}

export interface ComposerDeps {
  store(): MailStore | null
  /** The parts of DraftSync writing mail uses. */
  drafts: Pick<DraftSync, 'upload' | 'resolveConflict' | 'deleteEverywhere' | 'uploadForSending' | 'attach' | 'forward' | 'detach' | 'links' | 'unscannedLink'>
  accounts(): SyncedMailAccount[]
  signatures(): SyncedSignature[]
  /** The account a new message is written from: the one on screen, or the first. */
  defaultAccount(): string | null
  body(messageId: string): Promise<Pick<MessageBody, 'html' | 'text' | 'attachments'>>
  send(request: SendMessageRequest): Promise<SyncedOutgoingMessage>
  cancel(outgoingId: string): Promise<SyncedOutgoingMessage>
  notify(notice: ComposerNotice, ms: number): void
  /** What a failed request means for the user: its message, and messages per field. */
  explain(error: unknown): { message: string; violations: Record<string, string> }
  /** How a scheduled time is written in a notice. */
  formatTime?(at: Date): string
  /** Called after the composer changed the copy (a draft saved, sent or removed), so lists read it again. */
  changed?(): void
  /**
   * The time on the server's clock (epoch ms), as well as the client knows it. The undo window is a send time the
   * server keeps, so it is counted on that clock; the device's own clock (the default) may be off by minutes.
   */
  now?(): number
  undoSeconds?: number
  autosaveMs?: number
}

export interface ComposerState {
  draft: Draft | null
  /** Rises whenever a draft is (re)opened, so a form starts over even for the same draft. */
  revision: number
  /** When this device last saved the draft (epoch ms). */
  savedAt: number | null
  sending: boolean
  error: string | null
  violations: Record<string, string>
  /** Another device saved a newer version while this one was being written. */
  conflict: boolean
  /** A message that can still be stopped, until `until` (epoch ms). */
  undoable: { outgoingId: string; draftId: string; until: number } | null
  /** Files being attached to the open draft right now, by name. */
  attaching: string[]
  /**
   * The server would only send the draft once the user confirms its files that could not be scanned for malware:
   * the reason to show, and the send time asked for (null: right away). `sendAnyway()` confirms, `keepEditing()`
   * does not.
   */
  unscannedToConfirm: { message: string; sendAt: number | null } | null
}

/**
 * Writing mail, the same on every client: drafts are saved on the device while typing and uploaded, kept until the
 * message is confirmed sent (so a failure can be edited and sent again), and every message waits a few seconds so
 * "Undo" can stop it. Screens read `state` and are told of changes through `subscribe`.
 */
export class Composer {
  private current: ComposerState = { draft: null, revision: 0, savedAt: null, sending: false, error: null, violations: {}, conflict: false, undoable: null, attaching: [], unscannedToConfirm: null }
  private readonly listeners = new Set<() => void>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private undoTimer: ReturnType<typeof setTimeout> | null = null
  private following: Promise<void> | null = null
  private followAgain = false
  /**
   * The copy the open draft belongs to. A draft is only ever written into it: after a sign-out or another user's
   * sign-in the composer does not touch the new copy (see reset).
   */
  private openedIn: MailStore | null = null
  /** Files on their way to a draft, by a number of their own, so switching drafts never loses or mixes them up. */
  private readonly onTheirWay = new Map<number, { draftId: string; name: string }>()
  private nextFile = 0
  /** Saves on this device that are under way, each resolving to null or why it failed, so a restart can wait for them. */
  private readonly writes = new Set<Promise<string | null>>()
  /** Drafts being sent or deleted, which nothing writes meanwhile: a sent or deleted draft must not come back. */
  private readonly held = new Set<string>()
  /** The last save asked for each held draft, made once it is released and still there. */
  private readonly heldSaves = new Map<string, { draft: Draft; closing: boolean }>()
  /** Drafts being deleted everywhere. */
  private readonly deleting = new Set<string>()
  /** The open draft has edits that are not written on this device yet, or whose write failed. */
  private dirty = false
  /**
   * What each draft open (or just put away) was opened on: its text and version as last read from the copy or written
   * into it, and whether it was there at all. Edits are laid over the stored draft only while that is still this text:
   * another device's version that the delta brought meanwhile is not overwritten (see withEditsOver).
   */
  private readonly bases = new Map<string, DraftBase & { stored: boolean }>()
  /** Counts saves on this device, so a read of the copy can tell a save came in between. */
  private writesStarted = 0
  /**
   * What each draft's send stands at, as last read from the copy or written into it, so a draft moved into a copy that
   * was opened again (rebind) keeps its send's id, an earlier send that may have gone out, and whether the server hid
   * it: those live in the copy, which is new.
   */
  private readonly sends = new Map<string, Pick<Draft, 'sendAttemptId' | 'unsureSendId' | 'hiddenOnServer'>>()
  /** Rises on every reset (a sign-out, another user): work started before belongs to a session that is over. */
  private resets = 0

  constructor(private readonly deps: ComposerDeps) {}

  get state(): ComposerState {
    return this.current
  }

  /** Which session the composer is in: it changes on every {@link reset}. */
  get session(): number {
    return this.resets
  }

  /** Notes where a draft's send stands, from the copy (see `sends`). */
  private noteSend(draft: Draft | null): void {
    if (draft === null) {
      return
    }
    if (draft.sendAttemptId || draft.unsureSendId || draft.hiddenOnServer) {
      this.sends.set(draft.id, { sendAttemptId: draft.sendAttemptId ?? null, unsureSendId: draft.unsureSendId ?? null, ...(draft.hiddenOnServer ? { hiddenOnServer: true } : {}) })
    } else {
      this.sends.delete(draft.id)
    }
  }

  /**
   * What quitting now would cut short: files on their way to any draft (their contents are only in memory), a message
   * being handed to the server, or a draft being deleted there. Null when the app can go.
   */
  get unfinished(): 'files' | 'sending' | 'deleting' | null {
    return this.onTheirWay.size > 0 ? 'files' : this.current.sending ? 'sending' : this.deleting.size > 0 ? 'deleting' : null
  }

  /**
   * Saves the open draft on this device at once, rather than when typing stops, and waits for saves under way, so a
   * restart loses no edits. The upload is left for later: the draft stays marked as not on the server. Throws when a
   * save failed, so the caller does not go ahead and lose those edits.
   */
  async saveNow(): Promise<void> {
    this.clearSaveTimer()
    // Typing during a save marks the draft again; a few rounds catch up with that.
    for (let round = 0; round < SAVE_NOW_ROUNDS; round++) {
      const draft = this.current.draft
      if (this.dirty && draft !== null && !this.held.has(draft.id)) {
        void this.saveHere(draft, false)
      }
      const failed = (await Promise.all([...this.writes])).find((failure) => failure !== null)
      if (failed !== undefined) {
        throw new Error(failed)
      }
      if (!this.dirty || this.current.draft === null || this.held.has(this.current.draft.id)) {
        return
      }
    }
    throw new Error('The draft keeps changing while it is saved.')
  }

  /** Lets nothing write the draft while it is sent (which writes it itself) or deleted. */
  private hold(id: string): void {
    this.held.add(id)
  }

  /**
   * Ends a hold. Unless the draft is `gone` (sent or deleted), what was asked to be saved meanwhile is saved now: the
   * open draft by its next autosave, with its newest edits, and one put away from the save asked for it.
   */
  private release(id: string, gone: boolean): void {
    this.held.delete(id)
    const send = this.sends.get(id)
    const store = this.storeOfDraft()
    if (!gone && send !== undefined && this.current.draft?.id === id && store !== null) {
      // The copy may have been opened again during the send (rebind leaves a draft being sent alone): its send comes
      // along before the autosave writes the form there, so a lost answer is recognised there, not sent twice.
      const draft = this.current.draft
      void store.changeDraft(id, (stored) => (stored !== null ? null : { ...withEditsOver(null, draft, null), ...send, pendingSave: true })).catch(() => undefined)
    }
    const asked = this.heldSaves.get(id)
    this.heldSaves.delete(id)
    if (!gone && asked !== undefined && this.current.draft?.id !== id) {
      void this.save(asked.draft, asked.closing)
    }
    this.resumeSaving()
  }

  private resumeSaving(): void {
    if (this.dirty && this.current.draft !== null && this.saveTimer === null) {
      this.saveTimer = setTimeout(() => this.autosave(), this.deps.autosaveMs ?? AUTOSAVE_MS)
    }
  }

  private autosave(): void {
    this.saveTimer = null
    void this.save()
  }

  /** Writes the draft on this device; resolves to null when that worked (or there is nowhere to keep it), else why not. */
  private saveHere(draft: Draft, closing: boolean): Promise<string | null> {
    this.writesStarted++
    const write = this.writeHere(draft, closing)
    this.writes.add(write)
    void write.then(() => this.writes.delete(write))
    return write
  }

  private async writeHere(draft: Draft, closing: boolean): Promise<string | null> {
    if (this.current.draft?.id === draft.id) {
      this.dirty = false
    }
    const store = this.storeOfDraft()
    if (store === null) {
      return null
    }
    let isNew = false
    let written: Draft | null = null
    try {
      // Kept as one step, so what an upload or a file learned meanwhile is not written over.
      await store.changeDraft(draft.id, (stored) => {
        isNew = stored === null
        written = withEditsOver(stored, draft, this.bases.get(draft.id) ?? null)
        return written
      })
    } catch (error) {
      if (error instanceof CopyClosingError) {
        // Signed out meanwhile: the copy is going, and the draft with it.
        return null
      }
      const failure = `The draft could not be saved: ${this.deps.explain(error).message}`
      if (this.current.draft?.id === draft.id) {
        this.dirty = true
        this.set({ error: failure })
      }
      return failure
    }
    const saved = written as Draft | null
    this.noteSend(saved)
    if (saved !== null) {
      if (closing && this.current.draft?.id !== draft.id) {
        this.bases.delete(draft.id)
      } else {
        this.bases.set(draft.id, { version: saved.version, fields: editedFields(saved), stored: true })
      }
    }
    // Lists only need to know of a new draft and of one put away; every pause in typing would be too often.
    if (isNew || closing) {
      this.deps.changed?.()
    }
    if (this.current.draft?.id === draft.id) {
      this.set(saved !== null && saved.remoteVersion !== null ? { savedAt: Date.now(), conflict: true } : { savedAt: Date.now() })
    }
    return null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(changes: Partial<ComposerState>): void {
    this.current = { ...this.current, ...changes }
    for (const listener of this.listeners) {
      listener()
    }
  }

  private get undoSeconds(): number {
    return this.deps.undoSeconds ?? UNDO_SECONDS
  }

  defaultSignature(mailAccountId: string | null): string | null {
    return defaultSignatureOf(this.deps.accounts(), this.deps.signatures(), mailAccountId)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Opens a draft in the form; `stored` says it is the draft as the copy has it (not one only made on screen). */
  private open(draft: Draft, stored = false): void {
    const store = this.deps.store()
    if (store === null) {
      // No copy is open (signed out): there is nowhere to keep a draft.
      return
    }
    // A save that was still waiting for typing to stop (or failed) is made before the other draft takes its place.
    if (this.saveTimer !== null || this.dirty) {
      this.clearSaveTimer()
      void this.save(this.current.draft)
    }
    this.dirty = false
    this.openedIn = store
    this.bases.set(draft.id, { version: draft.version, fields: editedFields(draft), stored })
    this.set({ draft: plain(draft), revision: this.current.revision + 1, error: null, violations: {}, savedAt: null, conflict: draft.remoteVersion !== null, attaching: this.attachingTo(draft.id) })
  }

  /** The copy to write the open draft into, or null when it is no longer the one open (a sign-out, another user). */
  private storeOfDraft(): MailStore | null {
    const store = this.deps.store()
    return store !== null && store === this.openedIn ? store : null
  }

  /**
   * Forgets the draft on screen without saving it, for a sign-out or another user's sign-in: whatever it is goes no
   * further. Drafts already saved stay in the copy they were saved in.
   */
  reset(): void {
    this.clearSaveTimer()
    if (this.undoTimer !== null) {
      clearTimeout(this.undoTimer)
      this.undoTimer = null
    }
    this.openedIn = null
    this.dirty = false
    this.resets++
    this.sends.clear()
    this.bases.clear()
    this.held.clear()
    this.heldSaves.clear()
    this.deleting.clear()
    this.onTheirWay.clear()
    this.set({ draft: null, savedAt: null, sending: false, error: null, violations: {}, conflict: false, undoable: null, attaching: [] })
  }

  /**
   * The copy was opened again for the same user (removed or closed under this window, by a sign-out in another tab,
   * say): the open draft moves to the new copy, where it is saved and uploaded again, so typing goes on being kept.
   * The copy keeps the version it knows, so the upload settles with the server's own (a conflict, or a new draft when
   * the server has none). Call it only for the same user; for another one, `reset()`.
   */
  async rebind(): Promise<void> {
    const store = this.deps.store()
    const draft = this.current.draft
    if (store === null || this.openedIn === null || store === this.openedIn || draft === null) {
      return
    }
    this.openedIn = store
    this.dirty = true
    this.clearSaveTimer()
    // Where its send stands lived in the old copy: it comes along, so a send whose answer was lost is still recognised
    // (or still settled, when the server hid the draft) rather than sent a second time.
    const send = this.sends.get(draft.id)
    // A draft being sent is written by its send alone (and not at all into a copy that replaced its own).
    if (send !== undefined && !this.held.has(draft.id)) {
      await store.changeDraft(draft.id, (stored) => (stored !== null ? null : { ...withEditsOver(null, draft, null), ...send, pendingSave: true }))
    }
    await this.save(draft)
  }

  openNew(to: Address[] = []): void {
    const account = this.deps.defaultAccount()
    this.open({ ...newDraft('new', account, this.defaultSignature(account)), to })
  }

  /** Opens a message written for the user, such as a follow-up to someone a conversation was handed over to. */
  openPrepared(fields: Pick<Draft, 'kind' | 'mailAccountId' | 'to' | 'subject' | 'html' | 'inReplyToMessageId'>): void {
    this.open({ ...newDraft(fields.kind, fields.mailAccountId, this.defaultSignature(fields.mailAccountId)), ...fields })
  }

  /**
   * Opens a reply, reply to all or forward of a message. When the original cannot be loaded, a reply still opens,
   * quoting the snippet and saying the quote is incomplete; a forward does not, since without the original and its
   * files it is not what was asked for: the user is told, or with `strict` the reason is thrown.
   *
   * @throws OriginalUnavailableError for a forward whose original could not be loaded, with `strict`
   */
  async openReply(message: SyncedMessage, kind: 'reply' | 'replyAll' | 'forward', options: { strict?: boolean } = {}): Promise<void> {
    let body: Pick<MessageBody, 'html' | 'text' | 'attachments'>
    let missing: string | null = null
    const session = this.resets
    try {
      body = await this.deps.body(message.id)
    } catch (error) {
      if (this.resets !== session) {
        return this.signedOutMeanwhile(options.strict === true)
      }
      missing = this.deps.explain(error).message
      if (kind === 'forward') {
        const failure = new OriginalUnavailableError(`The message could not be forwarded: it could not be loaded (${missing}).`)
        if (options.strict) {
          throw failure
        }
        this.deps.notify({ text: failure.message, tone: 'error' }, 8000)
        return
      }
      // Replying stays possible offline, quoting what the copy here has.
      body = { html: null, text: message.snippet, attachments: [] }
    }
    if (this.resets !== session) {
      // Signed out while the original was loading: it was the previous user's, and must not open for the next.
      return this.signedOutMeanwhile(options.strict === true)
    }
    const draft = replyDraft(message, body, kind, this.deps.accounts(), this.deps.signatures())
    this.open(draft)
    if (missing !== null && this.current.draft?.id === draft.id) {
      this.set({ error: `The original message could not be loaded (${missing}), so the quote is incomplete.` })
    }
    const usable = body.attachments.filter((attachment) => attachment.scanStatus !== 'infected')
    // The quote's images go along with the message: their links expire within the hour.
    const images = quotedInlineImages(draft.quoteHtml, usable)
    // A forward takes the original's files along too, as other mail apps do.
    const files = kind === 'forward' ? usable.filter((attachment) => !attachment.inline) : []
    if (images.length + files.length === 0) {
      return
    }
    // Shown as on their way from the start, so the message is not sent without them.
    const tokens = this.beginFiles(draft.id, [...images, ...files].map((file) => file.filename))
    // The files are kept with the server's copy of the draft, so the draft goes up first.
    await this.save(this.current.draft)
    await this.withFiles(draft.id, [
      ...images.map((image, index) => ({
        token: tokens[index]!,
        name: image.filename,
        request: () => this.deps.drafts.forward(draft.id, image.id),
        // From now on the quote refers to the copy that goes along.
        done: () => this.changeQuote(draft.id, (quote) => quoteWithContentId(quote, image.url, image.contentId)),
      })),
      ...files.map((file, index) => ({ token: tokens[images.length + index]!, name: file.filename, request: () => this.deps.drafts.forward(draft.id, file.id) })),
    ])
  }

  /** A reply or forward asked for before a sign-out opens nothing; with `strict` the caller hears why. */
  private signedOutMeanwhile(strict: boolean): void {
    if (strict) {
      throw new OriginalUnavailableError('You were signed out. Sign in again to hand this over.')
    }
  }

  /** Attaches files to the open draft, which goes to the server first if it is not there yet. */
  async attach(files: AttachmentFile[]): Promise<void> {
    const draft = this.current.draft
    if (draft === null || files.length === 0 || this.storeOfDraft() === null) {
      return
    }
    // Typed text goes up with the draft, so it is not lost if the files take long.
    const tokens = this.beginFiles(
      draft.id,
      files.map((file) => file.name),
    )
    this.clearSaveTimer()
    await this.save(draft)
    await this.withFiles(
      draft.id,
      files.map((file, index) => ({ token: tokens[index]!, name: file.name, request: () => this.deps.drafts.attach(draft.id, file) })),
    )
  }

  /** Removes a file from the open draft. */
  async removeAttachment(attachmentId: string): Promise<void> {
    const draft = this.current.draft
    if (draft === null || this.storeOfDraft() === null) {
      return
    }
    try {
      await this.deps.drafts.detach(draft.id, attachmentId)
      this.noteAttachments(draft.id, (attachments) => attachments.filter((attachment) => attachment.id !== attachmentId))
    } catch (error) {
      if (this.current.draft?.id === draft.id) {
        this.set({ error: `The file could not be removed: ${this.deps.explain(error).message}` })
      }
    }
  }

  /** A fresh link to open one of the open draft's files, or null when it is quarantined or gone. */
  /**
   * A fresh link to one of the open draft's files, with what the scan allows: `url` only for a clean file; for one
   * that could not be scanned (`confirm`) ask the user, then call `unscannedAttachmentLink()`.
   */
  async attachmentLink(attachmentId: string): Promise<{ url: string | null; access: AttachmentAccess } | null> {
    const draft = this.current.draft
    if (draft === null) {
      return null
    }
    const link = (await this.deps.drafts.links(draft.id)).find((file) => file.id === attachmentId)
    return link === undefined ? null : { url: link.url, access: link.access }
  }

  /** A link to a file that could not be scanned, for a user who confirmed they accept that. */
  async unscannedAttachmentLink(attachmentId: string): Promise<string> {
    return (await this.deps.drafts.unscannedLink(attachmentId)).url
  }

  /**
   * The open draft's quote as it can be shown: images that go along with the draft are referred to by content id,
   * which a screen cannot load, so they are shown through fresh links (the quote unchanged when those cannot be had).
   */
  async shownQuote(quoteHtml: string): Promise<string> {
    const draft = this.current.draft
    if (draft === null || !quoteHtml.includes('cid:')) {
      return quoteHtml
    }
    const links = await this.deps.drafts.links(draft.id).catch(() => [])
    return withInlineLinks(quoteHtml, links)
  }

  /** Notes files as on their way to a draft; returns their numbers, to say when each arrived. */
  private beginFiles(draftId: string, names: string[]): number[] {
    const tokens = names.map((name) => {
      const token = ++this.nextFile
      this.onTheirWay.set(token, { draftId, name })
      return token
    })
    this.showAttaching()
    return tokens
  }

  private endFile(token: number): void {
    this.onTheirWay.delete(token)
    this.showAttaching()
  }

  private attachingTo(draftId: string): string[] {
    return [...this.onTheirWay.values()].filter((file) => file.draftId === draftId).map((file) => file.name)
  }

  private showAttaching(): void {
    const draft = this.current.draft
    this.set({ attaching: draft === null ? [] : this.attachingTo(draft.id) })
  }

  /** Runs the attach requests one after another, showing which files are on their way and why one failed. */
  private async withFiles(draftId: string, files: { token: number; name: string; request: () => Promise<DraftAttachment>; done?: () => void }[]): Promise<void> {
    const failures: string[] = []
    for (const file of files) {
      try {
        const attachment = await file.request()
        this.noteAttachments(draftId, (attachments) => [...attachments.filter((other) => other.id !== attachment.id), withoutLink(attachment)])
        file.done?.()
      } catch (error) {
        const reason = error instanceof AttachmentsNeedTheServer ? error.message : this.deps.explain(error).message
        failures.push(`${file.name}: ${reason}`)
      } finally {
        this.endFile(file.token)
      }
    }
    if (failures.length > 0) {
      const text = `Not attached. ${failures.join(' ')}`
      if (this.current.draft?.id === draftId) {
        this.set({ error: text })
      } else {
        this.deps.notify({ text, tone: 'error' }, 8000)
      }
    }
  }

  /** Changes the quote of a draft (the one open, or one saved), as an edit that is saved and uploaded. */
  private changeQuote(draftId: string, change: (quoteHtml: string) => string): void {
    if (this.current.draft?.id === draftId) {
      this.update({ quoteHtml: change(this.current.draft.quoteHtml) })
      return
    }
    const store = this.storeOfDraft()
    void store
      ?.changeDraft(draftId, (stored) => stored && { ...stored, quoteHtml: change(stored.quoteHtml), pendingSave: true, updatedAt: Date.now() })
      .then((stored) => (stored === null ? undefined : this.deps.drafts.upload(draftId)))
      .catch(() => undefined)
  }

  /** The open draft's files as the server has them now (they are not edits: nothing is saved for them). */
  private noteAttachments(draftId: string, change: (attachments: DraftAttachment[]) => DraftAttachment[]): void {
    const draft = this.current.draft
    if (draft !== null && draft.id === draftId) {
      this.set({ draft: { ...draft, attachments: change(draft.attachments) } })
    }
  }

  async openDraft(id: string): Promise<void> {
    const stored = await this.deps.store()?.draft(id)
    if (stored) {
      this.noteSend(stored)
      this.open(reopenedDraft(stored), true)
    }
  }

  /**
   * Brings the open draft in line with the copy, after the delta changed it: another device's text replaces the form
   * while nothing typed here waits to be saved (with edits waiting, their save notes the other version as a conflict
   * instead), a draft sent or deleted on another device closes, and files attached or removed there show.
   */
  async refreshOpen(): Promise<void> {
    const open = this.current.draft
    const store = this.storeOfDraft()
    if (open === null || store === null) {
      return
    }
    const writesBefore = this.writesStarted
    const stored = await store.draft(open.id)
    // Edits waiting to be written, or written while the copy was read (what was read may be older than the form).
    const busy = this.dirty || this.saveTimer !== null || this.writes.size > 0 || this.writesStarted !== writesBefore || this.held.has(open.id) || this.current.sending
    // Typed meanwhile (the form holds another object then), or another draft took the screen.
    if (this.current.draft !== open || busy) {
      await this.showStoredFiles()
      return
    }
    const base = this.bases.get(open.id)
    if (stored === null) {
      if (base?.stored === true) {
        this.bases.delete(open.id)
        this.set({ draft: null, conflict: false })
        this.deps.notify({ text: `"${open.subject || '(no subject)'}" was sent or deleted on another device.`, tone: 'info' }, 8000)
      }
      return
    }
    if (!stored.pendingSave && stored.outgoingId === null && base !== undefined && stored.version > base.version && editedFields(stored) !== editedFields(open)) {
      // The form starts over with the other device's text: a version past the one it builds on, never an older one (a
      // page read before this device's last upload that arrived after its answer).
      this.open(stored, true)
      this.deps.notify({ text: `"${stored.subject || '(no subject)'}" was changed on another device. It shows that version now.`, tone: 'info' }, 8000)
      return
    }
    this.noteBase(stored)
    const conflict = stored.remoteVersion !== null
    const files = sameFiles(open.attachments, stored.attachments) ? {} : { draft: { ...open, attachments: stored.attachments } }
    if (conflict !== this.current.conflict || 'draft' in files) {
      this.set({ conflict, ...files })
    }
  }

  /** Changes the draft being written; it is saved and uploaded shortly after typing stops. */
  update(changes: Partial<Draft>): void {
    const draft = this.current.draft
    if (draft === null) {
      return
    }
    this.set({ draft: { ...draft, ...plain(changes), pendingSave: true, updatedAt: Date.now() } })
    this.dirty = true
    this.clearSaveTimer()
    this.saveTimer = setTimeout(() => this.autosave(), this.deps.autosaveMs ?? AUTOSAVE_MS)
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  /** Saves on this device at once and uploads, so the draft is on every device and in the Drafts folder. */
  async save(draft: Draft | null = this.current.draft, closing = false): Promise<void> {
    if (draft !== null && this.held.has(draft.id)) {
      this.heldSaves.set(draft.id, { draft, closing })
      return
    }
    if (draft === null || this.storeOfDraft() === null || (await this.saveHere(draft, closing)) !== null) {
      return
    }
    try {
      await this.deps.drafts.upload(draft.id)
    } catch {
      // Offline or the server is unreachable: the edits wait on this device and go up later.
    }
    await this.checkConflict(draft.id)
  }

  private async checkConflict(id: string): Promise<void> {
    if (this.current.draft?.id !== id) {
      return
    }
    const stored = await this.deps.store()?.draft(id)
    const open = this.current.draft
    if (open?.id !== id) {
      return
    }
    this.set({ conflict: (stored?.remoteVersion ?? null) !== null })
    if (stored) {
      this.noteBase(stored)
    }
    await this.showStoredFiles()
  }

  /**
   * Notes the version the open text is at on the server: the stored draft has the same text (this device's own upload
   * gave it a version, or a file changed on another device), so edits from here on build on that version.
   */
  private noteBase(stored: Draft): void {
    const base = this.bases.get(stored.id)
    if (base !== undefined && !stored.pendingSave && editedFields(stored) === base.fields) {
      this.bases.set(stored.id, { ...base, version: stored.version, stored: true })
    }
  }

  /** Settles a conflict; when that fails the conflict stays, saying why, so the user can try again. */
  async resolveConflict(keep: 'mine' | 'theirs'): Promise<void> {
    const draft = this.current.draft
    if (draft === null) {
      return
    }
    let resolved: Draft | null
    try {
      await this.save()
      resolved = await this.deps.drafts.resolveConflict(draft.id, keep)
    } catch (error) {
      if (this.current.draft?.id === draft.id) {
        this.set({ error: `The versions could not be compared: ${this.deps.explain(error).message}` })
      }
      return
    }
    if (this.current.draft?.id !== draft.id) {
      return
    }
    this.set({ conflict: false, error: null })
    if (keep === 'theirs' && resolved !== null) {
      // The form starts over with the other device's version (or this one's, when the other is gone).
      this.open(resolved, true)
    }
  }

  /**
   * Throws the draft away, here and on the server. When the server cannot be reached the draft stays open, saying so,
   * rather than lingering in Drafts while the form is gone.
   */
  async discard(): Promise<boolean> {
    const draft = this.current.draft
    // A draft being sent settles first: deleting it meanwhile would race the send for the same draft.
    if (draft === null || this.storeOfDraft() === null || this.current.sending || this.held.has(draft.id)) {
      return false
    }
    this.clearSaveTimer()
    this.hold(draft.id)
    this.deleting.add(draft.id)
    this.set({})
    try {
      await this.deps.drafts.deleteEverywhere(draft.id)
    } catch (error) {
      this.deleting.delete(draft.id)
      this.release(draft.id, false)
      this.set({})
      const text = `The draft could not be deleted: ${this.deps.explain(error).message}`
      if (this.current.draft?.id === draft.id) {
        this.set({ error: text })
      } else {
        this.deps.notify({ text, tone: 'error' }, 8000)
      }
      return false
    }
    this.deleting.delete(draft.id)
    this.bases.delete(draft.id)
    if (this.current.draft?.id === draft.id) {
      this.dirty = false
      this.set({ draft: null, conflict: false })
    } else {
      this.set({})
    }
    this.release(draft.id, true)
    this.deps.changed?.()
    return true
  }

  /**
   * Throws away a stored draft here and on the server without opening it, so the draft on screen is not touched: the
   * one a forward came back as when a hand-over is taken back. The open draft goes through {@link discard}. When the
   * server cannot be reached it says so (the draft stays in Drafts); while the draft is being sent or deleted already it
   * returns false without a word, since that step reports its own outcome.
   */
  async discardStored(id: string): Promise<boolean> {
    if (this.current.draft?.id === id) {
      return this.discard()
    }
    if (this.deps.store() === null || this.held.has(id)) {
      return false
    }
    this.hold(id)
    this.deleting.add(id)
    this.set({})
    let gone = false
    try {
      await this.deps.drafts.deleteEverywhere(id)
      gone = true
    } catch (error) {
      this.deps.notify({ text: `The draft could not be deleted: ${this.deps.explain(error).message}`, tone: 'error' }, 8000)
    } finally {
      this.deleting.delete(id)
      if (gone) {
        this.bases.delete(id)
      }
      this.release(id, gone)
      this.set({})
    }
    if (gone) {
      this.deps.changed?.()
    }
    return gone
  }

  /**
   * Closes the form; the draft is kept. Only edits are written: a draft from the copy that was not changed here stays
   * as stored, which may be another device's newer version, or no draft at all once it was sent or deleted elsewhere.
   */
  close(): void {
    if (this.current.sending) {
      // It stays until the send settles, so a failure is not lost with the form.
      return
    }
    const closing = this.current.draft
    const edited = this.dirty || this.saveTimer !== null || (closing !== null && this.bases.get(closing.id)?.stored !== true)
    this.clearSaveTimer()
    this.dirty = false
    this.set({ draft: null, conflict: false })
    if (closing === null) {
      return
    }
    if (edited) {
      void this.save(closing, true)
      return
    }
    this.bases.delete(closing.id)
    // Autosaves do not tell the lists (too often); a draft put away does, so Drafts shows what was saved since.
    this.deps.changed?.()
    if (this.storeOfDraft() !== null && !this.held.has(closing.id)) {
      // Edits saved before but not uploaded yet (offline, say) go up now; there is nothing new to write.
      void this.deps.drafts.upload(closing.id).catch(() => undefined)
    }
  }

  /** Why the draft cannot be sent as it is, or null when it can. */
  validate(draft: Draft): string | null {
    if (draft.mailAccountId === null) {
      return 'Choose the account to send from.'
    }
    const recipients = [...draft.to, ...draft.cc, ...draft.bcc]
    if (recipients.length === 0) {
      return 'Add at least one recipient.'
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return `A message can have at most ${MAX_RECIPIENTS} recipients.`
    }
    const wrong = recipients.find((recipient) => !isPlausibleAddress(recipient.address))
    if (wrong) {
      return `${wrong.address} is not a valid address.`
    }
    if (draft.subject.length > MAX_SUBJECT || /[\r\n]/.test(draft.subject)) {
      return draft.subject.length > MAX_SUBJECT ? 'The subject is too long.' : 'The subject cannot contain line breaks.'
    }
    return draft.html.length > MAX_HTML ? 'The message is too long.' : null
  }

  /**
   * Sends now (after the undo window) or at a chosen time. Files that could not be scanned only go along once the
   * user confirmed them: without `acceptUnscanned`, the server's question ends up in `unscannedToConfirm`. Returns the
   * message on its way, or null when it was not sent; `state.error` (or `unscannedToConfirm`) then says why.
   */
  async send(sendAt?: Date, acceptUnscanned = false): Promise<SyncedOutgoingMessage | null> {
    const draft = this.current.draft
    if (draft === null || this.current.sending) {
      return null
    }
    const store = this.storeOfDraft()
    if (store === null) {
      this.set({ error: 'You were signed out. Sign in again to send this message.' })
      return null
    }
    const problem = this.current.conflict
      ? 'This draft was changed on another device. Choose which version to keep first.'
      : this.current.attaching.length > 0
        ? 'Wait until the files are attached.'
        : this.validate(draft)
    if (problem) {
      this.set({ error: problem })
      return null
    }
    this.set({ sending: true, error: null, violations: {}, unscannedToConfirm: null })
    // The draft goes up first, so the server can take it (and its Drafts folder copy) away when the message is queued.
    // That writes it on this device too.
    this.clearSaveTimer()
    this.dirty = false
    this.hold(draft.id)
    let sent = false
    let written = false
    try {
      // Written here first, as every save is: another device's newer version that the form does not show is noted
      // rather than overwritten, and the message is not sent until the user chose which to keep.
      const failure = await this.saveHere(draft, false)
      if (failure !== null) {
        throw new Error(failure)
      }
      written = true
      if (((await store.draft(draft.id))?.remoteVersion ?? null) !== null) {
        this.set({ conflict: true })
        throw new Error('This draft was changed on another device. Choose which version to keep first.')
      }
      // The send's id is chosen once, when it is first tried, and kept with the draft before the request leaves: every
      // try of the same send (Send pressed again after a lost answer, also after a restart) carries it, so the server
      // queues the message once. Its time is the server's, which takes only an id made about now.
      const attempt = await store.changeDraft(draft.id, (stored) => (stored === null || stored.sendAttemptId ? null : { ...stored, sendAttemptId: uuidV7(this.now()) }))
      this.noteSend(attempt)
      const attemptId = attempt?.sendAttemptId ?? uuidV7(this.now())
      // A try whose answer was lost may have reached the server: when its message is in the copy, it is on its way.
      const queued = await store.outgoing(attemptId)
      if (queued !== null) {
        sent = true
        await this.markOnItsWay(store, draft.id, attemptId)
        this.bases.delete(draft.id)
        if (this.current.draft?.id === draft.id) {
          this.set({ draft: null, conflict: false })
        }
        this.deps.changed?.()
        this.deps.notify({ text: `"${draft.subject || '(no subject)'}" reached the server after all and is on its way.`, tone: 'info' }, 8000)
        return queued
      }
      const onServer = await this.deps.drafts.uploadForSending({ ...draft, sendAttemptId: attemptId })
      if (!onServer && draft.attachments.length > 0) {
        // The files are with the server's copy of the draft: sending without it would leave them out.
        throw new AttachmentsNeedTheServer()
      }
      // Worked out after the upload: the undo window is the time between queueing and sending, on the server's clock.
      const at = sendAt ?? new Date(this.now() + this.undoSeconds * 1000)
      const outgoing = await this.deps.send(sendRequest({ ...draft, sendAttemptId: attemptId }, this.deps.signatures(), at, onServer, acceptUnscanned))
      sent = true
      this.bases.delete(draft.id)
      try {
        // The server has the message: the send is over, and so is its id.
        await store.changeDraft(draft.id, (stored) => ({ ...(stored ?? draft), outgoingId: outgoing.id, sendAttemptId: null, unsureSendId: null, pendingSave: false, updatedAt: Date.now() }))
      } catch (error) {
        // The server has the message: it goes out whatever this device could note, so the form closes all the same.
        this.deps.notify({ text: `Sent, but this device could not note it (${this.deps.explain(error).message}). The draft may stay in Drafts.`, tone: 'error' }, 30000)
      }
      this.deps.changed?.()
      if (this.current.draft?.id === draft.id) {
        this.set({ draft: null, conflict: false })
      }
      if (sendAt === undefined) {
        this.startUndo(outgoing.id, draft.id, at)
      } else {
        const when = this.deps.formatTime?.(at) ?? at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        this.deps.notify({ text: `Scheduled for ${when}.`, tone: 'info' }, 8000)
      }
      return outgoing
    } catch (error) {
      if (!sent && !written && this.current.draft?.id === draft.id) {
        // The send did not get to write the form here: it is written again before a restart. Once written, writing the
        // same text again would only mark it as an edit the server never had, which it may well have.
        this.dirty = true
      }
      const { message, violations } = this.deps.explain(error)
      if (!sent && (violations.outgoingId !== undefined || queuedNothing(error))) {
        // The server answered and queued nothing (it refused the id, made on a clock far ahead, or the request): the
        // send is over, and the next try is a new one. When even that cannot be written, the next try carries the old
        // id, which the server has no message for either.
        this.noteSend(await store.changeDraft(draft.id, (stored) => (stored?.sendAttemptId ? { ...stored, sendAttemptId: null } : null)).catch(() => null))
      }
      const unscanned = violations.acceptUnscanned
      if (unscanned !== undefined && this.current.draft?.id === draft.id) {
        this.set({ unscannedToConfirm: { message: unscanned, sendAt: sendAt?.getTime() ?? null } })
      } else if (this.current.draft?.id === draft.id) {
        this.set({ error: message, violations })
      } else {
        // Another draft took the screen meanwhile: this one is in Drafts, offered for another try.
        this.deps.notify(
          { text: `"${draft.subject || '(no subject)'}" was not sent: ${message}`, tone: 'error', action: { label: 'Edit', run: () => void this.openDraft(draft.id) } },
          30000,
        )
      }
      return null
    } finally {
      this.set({ sending: false })
      this.release(draft.id, sent)
      if (!sent) {
        // The answer may be lost while the server queued the message, and the delta that says so may have come while
        // the draft was held: look again now.
        void this.followUp().catch(() => undefined)
      }
    }
  }

  /** The user confirmed sending the files that could not be scanned. */
  async sendAnyway(): Promise<void> {
    const asked = this.current.unscannedToConfirm
    if (asked === null) {
      return
    }
    this.set({ unscannedToConfirm: null })
    await this.send(asked.sendAt === null ? undefined : new Date(asked.sendAt), true)
  }

  /** The user would rather not send files that could not be scanned. */
  keepEditing(): void {
    this.set({ unscannedToConfirm: null })
  }

  /**
   * Undo is offered until the message's send time, when it leaves. That time is on the server's clock; `undoable.until`
   * is the same moment on this device's clock, which the screens count with.
   */
  private startUndo(outgoingId: string, draftId: string, sendAt: Date): void {
    if (this.undoTimer !== null) {
      clearTimeout(this.undoTimer)
    }
    const left = Math.max(0, sendAt.getTime() - this.now())
    this.set({ undoable: { outgoingId, draftId, until: Date.now() + left } })
    this.undoTimer = setTimeout(() => this.set({ undoable: null }), left)
  }

  /** Stops the message that was just sent and opens it again for editing. */
  async undo(): Promise<void> {
    const pending = this.current.undoable
    if (pending === null) {
      return
    }
    this.set({ undoable: null })
    if (this.undoTimer !== null) {
      clearTimeout(this.undoTimer)
    }
    try {
      await this.deps.cancel(pending.outgoingId)
    } catch (error) {
      this.deps.notify({ text: `Too late to undo: ${this.deps.explain(error).message}`, tone: 'error' }, 8000)
      return
    }
    // A draft again in the copy too, whatever the user does next: otherwise it stays hidden as a message on its way.
    await this.reopenCancelled(pending.draftId, pending.outgoingId)
    await this.openDraft(pending.draftId)
  }

  /**
   * Makes the draft of a cancelled message a draft again, here and (as edits waiting to go up) on the server. A draft
   * that was sent again meanwhile, as another message, is left alone.
   */
  private async reopenCancelled(draftId: string, outgoingId: string): Promise<void> {
    const store = this.deps.store()
    if (store === null) {
      return
    }
    try {
      let reopened = false
      await store.changeDraft(draftId, (stored) => {
        reopened = stored !== null && stored.outgoingId === outgoingId
        return reopened && stored !== null ? reopenedDraft(stored) : null
      })
      if (reopened) {
        this.deps.changed?.()
        void this.deps.drafts.upload(draftId).catch(() => undefined)
      }
    } catch (error) {
      if (!(error instanceof CopyClosingError)) {
        this.deps.notify({ text: `The draft could not be brought back: ${this.deps.explain(error).message}`, tone: 'error' }, 8000)
      }
    }
  }

  /**
   * Follows every draft that was sent: confirmed ones are removed, failed ones offered for editing, once each. Runs
   * never overlap, or two could announce the same outcome; a call during a run makes it go round once more.
   */
  followUp(): Promise<void> {
    this.followAgain = true
    if (this.following !== null) {
      return this.following
    }
    this.following = (async () => {
      try {
        while (this.followAgain) {
          this.followAgain = false
          await this.followUpOnce()
        }
      } finally {
        this.following = null
      }
    })()
    return this.following
  }

  private async followUpOnce(): Promise<void> {
    const store = this.deps.store()
    if (store === null) {
      return
    }
    for (const listed of await store.drafts()) {
      const stored = await this.recognisedSend(store, listed)
      if (stored === null || (await this.settleHidden(store, stored))) {
        continue
      }
      const outgoing = stored.outgoingId === null ? null : await store.outgoing(stored.outgoingId)
      if (stored.outgoingId !== null && outgoing === null && stored.mailAccountId === null) {
        // Its account was removed while it was on its way: the message went with it, unsent, and the draft is back.
        await store.changeDraft(stored.id, (now) => now && { ...reopenedDraft(now), pendingSave: false })
        this.deps.changed?.()
        this.deps.notify({ text: `"${stored.subject || '(no subject)'}" was not sent: its account was removed. It is in Drafts.`, tone: 'error' }, 30000)
        continue
      }
      const outcome = sentOutcome(stored, outgoing)
      if (outcome === null || outgoing === null) {
        continue
      }
      if (outcome === 'cancelled') {
        // Stopped (an undo, or Cancel in the Outbox, here or on another device): it is a draft again.
        await this.reopenCancelled(stored.id, outgoing.id)
        continue
      }
      if (outcome === 'sent') {
        await store.deleteDraft(stored.id)
        this.deps.changed?.()
        if (outgoing.lastError) {
          this.deps.notify({ text: outgoing.lastError, tone: 'info' }, 8000)
        }
        continue
      }
      if (outcome === 'failed') {
        this.deps.notify(
          {
            text: `"${outgoing.subject || '(no subject)'}" was not sent. ${outgoing.lastError ?? ''}`.trim(),
            tone: 'error',
            action: { label: 'Edit and send again', run: () => void this.openDraft(stored.id) },
          },
          30000,
        )
      }
      await store.changeDraft(stored.id, (now) => now && { ...now, noticedStatus: outgoing.status })
    }
    await this.refreshOpen()
  }

  /**
   * A draft whose send was answered with nothing (a lost answer) while the server did queue it: the message with the
   * send's id is in the copy, so the draft is on its way after all, and an edit must not send it a second time. Its
   * form closes. Text typed there since the send (before or while this is noted) did not go along: it stays on screen
   * as a new draft, and the user is told. Returns the draft to follow up, or null to leave it this round (a save under
   * way, which the next round waits out).
   */
  private async recognisedSend(store: MailStore, draft: Draft): Promise<Draft | null> {
    if (draft.outgoingId === null && !this.held.has(draft.id) && draft.unsureSendId && (await store.outgoing(draft.unsureSendId)) !== null) {
      return this.recognisedEarlier(store, draft, draft.unsureSendId)
    }
    const id = draft.sendAttemptId ?? null
    if (draft.outgoingId !== null || id === null || this.held.has(draft.id) || (await store.outgoing(id)) === null) {
      return draft
    }
    if (this.current.draft?.id === draft.id && this.writes.size > 0) {
      return null
    }
    const recognised = await this.markOnItsWay(store, draft.id, id)
    if (recognised?.outgoingId !== id) {
      return recognised
    }
    this.deps.changed?.()
    const subject = draft.subject || '(no subject)'
    const form = this.current.draft?.id === draft.id ? this.current.draft : null
    if (form !== null && editedFields(form) !== editedFields(draft)) {
      await this.keepAsNewDraft(store, form)
      this.deps.notify({ text: `"${subject}" reached the server after all and is on its way, without what you typed since. That is kept as a new draft${withoutFiles(draft)}.`, tone: 'info' }, 30000)
      return recognised
    }
    if (form !== null) {
      this.clearSaveTimer()
      this.dirty = false
      this.bases.delete(draft.id)
      this.set({ draft: null, conflict: false })
    }
    this.deps.notify({ text: `"${subject}" reached the server after all and is on its way.`, tone: 'info' }, 8000)
    return recognised
  }

  /**
   * A send whose answer never came, before the text was edited (`unsureSendId`), did reach the server: the earlier text
   * is on its way. The draft is noted as that message, and its edited text, which did not go along, is kept as a new
   * draft (the server's copy of this one is gone with the send), as the user is told.
   */
  private async recognisedEarlier(store: MailStore, draft: Draft, id: string): Promise<Draft | null> {
    const form = this.current.draft?.id === draft.id ? this.current.draft : null
    if (form !== null && this.writes.size > 0) {
      return null
    }
    const source = form ?? draft
    await this.keepAsNewDraft(store, source)
    const recognised = await store.changeDraft(draft.id, (stored) => {
      if (stored === null || stored.outgoingId !== null || stored.unsureSendId !== id) {
        return null
      }
      const { hiddenOnServer: _known, ...rest } = stored
      return { ...rest, outgoingId: id, sendAttemptId: null, unsureSendId: null, pendingSave: false }
    })
    this.deps.changed?.()
    this.deps.notify({ text: `An earlier version of "${draft.subject || '(no subject)'}" reached the server after all and is on its way. What you typed since is kept as a new draft${withoutFiles(draft)}.`, tone: 'info' }, 30000)
    return recognised
  }

  /**
   * A draft kept through the server's deletion for its send (`hiddenOnServer`) whose message did not show up: the
   * deletion was someone else's (sent or deleted on another device, or a server that does not take the send's id).
   * It goes as a deleted draft goes; text typed on it since stays, as a new draft. Returns whether it was settled.
   */
  private async settleHidden(store: MailStore, listed: Draft): Promise<boolean> {
    if (listed.outgoingId !== null || listed.hiddenOnServer !== true || this.held.has(listed.id)) {
      return false
    }
    // Any save under way (also of a form being closed) is waited out: the next round settles the draft with it.
    if (this.writes.size > 0) {
      return false
    }
    // Decided on the draft as it is now, not as listed at the start of the round.
    const writesBefore = this.writesStarted
    const draft = await store.draft(listed.id)
    if (draft === null) {
      return true
    }
    if (draft.outgoingId !== null || draft.hiddenOnServer !== true || this.held.has(draft.id) || this.writes.size > 0 || this.writesStarted !== writesBefore) {
      return false
    }
    const form = this.current.draft?.id === draft.id ? this.current.draft : null
    const subject = draft.subject || '(no subject)'
    // True whether this device's own send hid it (on a server that does not take the send's id) or another device did.
    const gone = `"${subject}" is no longer a draft on the server: it was sent, or deleted on another device.`
    const kept = `${gone} What you wrote here since is kept as a new draft${withoutFiles(draft)}.`
    // Text the server never had (typed in the form, or saved here and not uploaded) is never thrown away.
    if (draft.pendingSave || (form !== null && editedFields(form) !== editedFields(draft))) {
      if (form === null) {
        // The copy is written before the draft goes, so a copy that closes in between still has the text.
        await this.keepAsNewDraft(store, draft)
        await store.deleteDraft(draft.id)
      } else {
        // The form holds the text: the draft goes first, then the form as it is by then, keystrokes typed meanwhile too.
        await store.deleteDraft(draft.id)
        await this.keepAsNewDraft(store, this.current.draft?.id === draft.id ? this.current.draft : form)
      }
      this.deps.notify({ text: kept, tone: 'info' }, 30000)
      return true
    }
    await store.deleteDraft(draft.id)
    this.deps.changed?.()
    const now = this.current.draft
    if (now !== null && now.id === draft.id) {
      if (editedFields(now) !== editedFields(draft)) {
        // Typed while the draft was deleted: kept, not closed away.
        await this.keepAsNewDraft(store, now)
        this.deps.notify({ text: kept, tone: 'info' }, 30000)
        return true
      }
      this.clearSaveTimer()
      this.dirty = false
      this.bases.delete(draft.id)
      this.set({ draft: null, conflict: false })
      this.deps.notify({ text: gone, tone: 'info' }, 8000)
    }
    return true
  }

  /**
   * Keeps what the form shows as a draft of its own: the draft it was written in is out of reach on the server (on its
   * way, or gone), so it gets a new id and goes up as a new draft, without that draft's send or files.
   */
  private async keepAsNewDraft(store: MailStore, form: Draft): Promise<void> {
    const { hiddenOnServer: _gone, ...fields } = form
    const copy: Draft = { ...fields, id: crypto.randomUUID(), version: 0, pendingSave: true, remoteVersion: null, outgoingId: null, noticedStatus: null, sendAttemptId: null, unsureSendId: null, attachments: [], updatedAt: Date.now() }
    const onScreen = this.current.draft?.id === form.id
    if (onScreen) {
      // Only this draft's own save waits no more: another draft on screen keeps its autosave.
      this.clearSaveTimer()
      this.dirty = false
    }
    await store.saveDraft(copy)
    this.bases.delete(form.id)
    if (onScreen && this.current.draft?.id === form.id) {
      this.open(copy, true)
    }
    this.deps.changed?.()
    void this.deps.drafts.upload(copy.id).catch(() => undefined)
  }

  /** Notes the draft as the message `outgoingId` on its way, the send's id done with. */
  private markOnItsWay(store: MailStore, draftId: string, outgoingId: string): Promise<Draft | null> {
    return store.changeDraft(draftId, (stored) => {
      if (stored === null || stored.outgoingId !== null || stored.sendAttemptId !== outgoingId) {
        return null
      }
      const { hiddenOnServer: _known, ...rest } = stored
      return { ...rest, outgoingId, sendAttemptId: null, unsureSendId: null, pendingSave: false }
    })
  }

  /** The open draft's files as the copy here has them now: attached or removed on another device meanwhile. */
  private async showStoredFiles(): Promise<void> {
    const open = this.current.draft
    if (open === null) {
      return
    }
    const stored = await this.storeOfDraft()?.draft(open.id)
    const now = this.current.draft
    if (stored && now?.id === open.id && !sameFiles(now.attachments, stored.attachments)) {
      this.set({ draft: { ...now, attachments: stored.attachments } })
    }
  }

  /** The local draft behind an outgoing message, if it was written on this device. */
  async draftFor(outgoingId: string): Promise<Draft | null> {
    return ((await this.deps.store()?.drafts()) ?? []).find((stored) => stored.outgoingId === outgoingId) ?? null
  }

  /** Stops the timers and listeners, when the app part that owns the composer goes; a pending save is not made. */
  dispose(): void {
    this.reset()
    this.listeners.clear()
  }
}

/** Said of a draft kept as a new one: its files stay with the server's copy, out of reach, so they do not come along. */
function withoutFiles(draft: Draft): string {
  return draft.attachments.length > 0 ? ', without its files' : ''
}

/**
 * Whether a failed send's answer shows the server queued nothing: a refusal (4xx), except a timeout (408) and "being
 * sent already" (409), which say nothing of the kind. No answer at all (offline, a lost answer) or a 5xx may have
 * queued it.
 */
function queuedNothing(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 409
}

/** A copy holding only plain data: what the caller hands in may be a framework's reactive proxy, which stores refuse. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameFiles(one: DraftAttachment[], other: DraftAttachment[]): boolean {
  return one.length === other.length && one.every((attachment, index) => JSON.stringify(attachment) === JSON.stringify(other[index]))
}
