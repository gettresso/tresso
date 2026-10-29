import { isPlausibleAddress, quotedInlineImages, quoteWithContentId, withInlineLinks, type SendMessageRequest } from './compose'
import { AttachmentsNeedTheServer, defaultSignatureOf, newDraft, reopenedDraft, replyDraft, sendRequest, sentOutcome, withEdits, withoutLink, type AttachmentFile, type DraftSync } from './drafts'
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

  constructor(private readonly deps: ComposerDeps) {}

  get state(): ComposerState {
    return this.current
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
    try {
      // Kept as one step, so what an upload or a file learned meanwhile is not written over.
      await store.changeDraft(draft.id, (stored) => {
        isNew = stored === null
        return withEdits(stored, draft)
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
    // Lists only need to know of a new draft and of one put away; every pause in typing would be too often.
    if (isNew || closing) {
      this.deps.changed?.()
    }
    if (this.current.draft?.id === draft.id) {
      this.set({ savedAt: Date.now() })
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

  private open(draft: Draft): void {
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
    this.held.clear()
    this.heldSaves.clear()
    this.deleting.clear()
    this.onTheirWay.clear()
    this.set({ draft: null, savedAt: null, sending: false, error: null, violations: {}, conflict: false, undoable: null, attaching: [] })
  }

  openNew(to: Address[] = []): void {
    const account = this.deps.defaultAccount()
    this.open({ ...newDraft('new', account, this.defaultSignature(account)), to })
  }

  /** Opens a message written for the user, such as a follow-up to someone a conversation was handed over to. */
  openPrepared(fields: Pick<Draft, 'kind' | 'mailAccountId' | 'to' | 'subject' | 'html' | 'inReplyToMessageId'>): void {
    this.open({ ...newDraft(fields.kind, fields.mailAccountId, this.defaultSignature(fields.mailAccountId)), ...fields })
  }

  async openReply(message: SyncedMessage, kind: 'reply' | 'replyAll' | 'forward'): Promise<void> {
    const body = await this.deps.body(message.id).catch(() => ({ html: null, text: message.snippet, attachments: [] as MessageAttachment[] }))
    const draft = replyDraft(message, body, kind, this.deps.accounts(), this.deps.signatures())
    this.open(draft)
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
      this.open(reopenedDraft(stored))
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
    await this.showStoredFiles()
  }

  async resolveConflict(keep: 'mine' | 'theirs'): Promise<void> {
    const draft = this.current.draft
    if (draft === null) {
      return
    }
    await this.save()
    const resolved = await this.deps.drafts.resolveConflict(draft.id, keep)
    this.set({ conflict: false })
    if (keep === 'theirs' && resolved !== null) {
      // The form starts over with the other device's version.
      this.open(resolved)
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

  /** Closes the form; the draft is kept. */
  close(): void {
    if (this.current.sending) {
      // It stays until the send settles, so a failure is not lost with the form.
      return
    }
    this.clearSaveTimer()
    const closing = this.current.draft
    this.dirty = false
    this.set({ draft: null, conflict: false })
    void this.save(closing, true)
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
    try {
      const onServer = await this.deps.drafts.uploadForSending(draft)
      if (!onServer && draft.attachments.length > 0) {
        // The files are with the server's copy of the draft: sending without it would leave them out.
        throw new AttachmentsNeedTheServer()
      }
      // Worked out after the upload: the undo window is the time between queueing and sending.
      const at = sendAt ?? new Date(Date.now() + this.undoSeconds * 1000)
      const outgoing = await this.deps.send(sendRequest(draft, this.deps.signatures(), at, onServer, acceptUnscanned))
      sent = true
      await store.changeDraft(draft.id, (stored) => ({ ...(stored ?? draft), outgoingId: outgoing.id, pendingSave: false, updatedAt: Date.now() }))
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
      if (!sent && this.current.draft?.id === draft.id) {
        // Whether the send got to write the draft here or not, it is written again before a restart.
        this.dirty = true
      }
      const { message, violations } = this.deps.explain(error)
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

  /** Undo is offered until the message's send time, when it leaves. */
  private startUndo(outgoingId: string, draftId: string, until: Date): void {
    if (this.undoTimer !== null) {
      clearTimeout(this.undoTimer)
    }
    this.set({ undoable: { outgoingId, draftId, until: until.getTime() } })
    this.undoTimer = setTimeout(() => this.set({ undoable: null }), Math.max(0, until.getTime() - Date.now()))
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
      await this.openDraft(pending.draftId)
    } catch (error) {
      this.deps.notify({ text: `Too late to undo: ${this.deps.explain(error).message}`, tone: 'error' }, 8000)
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
    for (const stored of await store.drafts()) {
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
    await this.showStoredFiles()
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

/** A copy holding only plain data: what the caller hands in may be a framework's reactive proxy, which stores refuse. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameFiles(one: DraftAttachment[], other: DraftAttachment[]): boolean {
  return one.length === other.length && one.every((attachment, index) => JSON.stringify(attachment) === JSON.stringify(other[index]))
}
