import { composeBody, forwardSubject, quotedOriginal, replyRecipients, replySubject, type DraftRequest, type SendMessageRequest } from './compose'
import type { Draft, MailStore } from './store/mailStore'
import type { DraftAttachment, DraftAttachmentLink, DraftKind, MessageBody, SyncedDraft, SyncedMailAccount, SyncedMessage, SyncedOutgoingMessage, SyncedSignature } from './sync/types'

/**
 * A file to attach, as the platform has it: the browser's File on the web, a picked file's URI on the phone. `body` is
 * handed to the platform's own upload unchanged.
 */
export interface AttachmentFile {
  name: string
  type: string
  size: number
  body: unknown
}

/** The drafts API. Errors carry the HTTP status as `status`, as both clients' API errors do. */
export interface DraftApi {
  create(id: string, request: DraftRequest): Promise<SyncedDraft>
  update(id: string, request: DraftRequest, expectedVersion: number): Promise<SyncedDraft>
  /** The draft with fresh download links for its files. */
  get(id: string): Promise<SyncedDraft & { attachments: DraftAttachmentLink[] }>
  remove(id: string): Promise<void>
  /** POST /api/v1/drafts/{id}/attachments, multipart */
  attach(id: string, file: AttachmentFile): Promise<DraftAttachmentLink>
  /** POST /api/v1/drafts/{id}/forwarded-attachments: a file of a received message. */
  forward(id: string, attachmentId: string): Promise<DraftAttachmentLink>
  /** DELETE /api/v1/drafts/{id}/attachments/{attachmentId}: answers with the draft's version without the file. */
  detach(id: string, attachmentId: string): Promise<{ draftVersion: number }>
  /**
   * POST /api/v1/draft-attachments/{attachmentId}/unscanned-link with `{ confirmed: true }`: a link for a file that
   * could not be scanned, once the user accepted that.
   */
  unscannedLink(attachmentId: string): Promise<{ url: string }>
}

/** Files are kept with the server's copy of a draft: without a connection there is nowhere to put them. */
export class AttachmentsNeedTheServer extends Error {
  constructor() {
    super('Attaching files needs a connection. Try again when you are online.')
    this.name = 'AttachmentsNeedTheServer'
  }
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** A new, empty draft on this device. */
export function newDraft(kind: DraftKind, mailAccountId: string | null, signatureId: string | null, id: string = crypto.randomUUID()): Draft {
  return {
    id,
    mailAccountId,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    html: '',
    signatureId,
    quoteHtml: '',
    inReplyToMessageId: null,
    kind,
    version: 0,
    pendingSave: true,
    remoteVersion: null,
    outgoingId: null,
    noticedStatus: null,
    updatedAt: Date.now(),
    attachments: [],
  }
}

/** The signature an account adds by default, if it still exists. */
export function defaultSignatureOf(accounts: SyncedMailAccount[], signatures: SyncedSignature[], mailAccountId: string | null): string | null {
  const id = accounts.find((account) => account.id === mailAccountId)?.defaultSignatureId ?? null
  return signatures.some((signature) => signature.id === id) ? id : null
}

/**
 * A reply, reply to all or forward of a message: recipients without the user's own addresses, the subject, and the
 * quoted original (kept apart from what the user writes).
 */
export function replyDraft(
  message: SyncedMessage,
  body: Pick<MessageBody, 'html' | 'text'>,
  kind: 'reply' | 'replyAll' | 'forward',
  accounts: SyncedMailAccount[],
  signatures: SyncedSignature[],
): Draft {
  const draft = newDraft(kind, message.mailAccountId, defaultSignatureOf(accounts, signatures, message.mailAccountId))
  draft.inReplyToMessageId = message.id
  if (kind === 'forward') {
    draft.subject = forwardSubject(message.subject)
  } else {
    const recipients = replyRecipients(
      message,
      accounts.map((account) => account.emailAddress),
      kind === 'replyAll',
    )
    draft.to = recipients.to
    draft.cc = recipients.cc
    draft.subject = replySubject(message.subject)
  }
  draft.quoteHtml = quotedOriginal(message, body, kind === 'forward' ? 'forward' : 'reply')
  return draft
}

/** What the API needs to send a draft: the text with its signature and quote, at a time (with the undo window ahead). */
export function sendRequest(draft: Draft, signatures: SyncedSignature[], sendAt: Date, onServer: boolean, acceptUnscanned = false): SendMessageRequest {
  if (draft.mailAccountId === null) {
    throw new Error('Choose the account to send from.')
  }
  return {
    ...(draft.sendAttemptId ? { outgoingId: draft.sendAttemptId } : {}),
    mailAccountId: draft.mailAccountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: composeBody(draft.html, signatures.find((signature) => signature.id === draft.signatureId)?.html ?? null, draft.quoteHtml),
    sendAt: sendAt.toISOString(),
    ...(draft.inReplyToMessageId ? { inReplyToMessageId: draft.inReplyToMessageId } : {}),
    ...(onServer ? { draftId: draft.id } : {}),
    ...(acceptUnscanned ? { acceptUnscanned: true } : {}),
  }
}

/**
 * What became of a sent draft that the user was not told about yet: `sent` (the draft can go), `failed` (offer to edit
 * and send again), `cancelled` (stopped, here or on another device: the draft is a draft again), `other` (a status to
 * remember without telling), or null when nothing changed.
 */
export function sentOutcome(draft: Draft, outgoing: SyncedOutgoingMessage | null): 'sent' | 'failed' | 'cancelled' | 'other' | null {
  if (draft.outgoingId === null || outgoing === null || outgoing.status === draft.noticedStatus) {
    return null
  }
  switch (outgoing.status) {
    case 'sent':
    case 'failed':
    case 'cancelled':
      return outgoing.status
    default:
      return 'other'
  }
}

/** Editing a message that failed to send makes it a draft again; sending it again is a new send, with a new id. */
export function reopenedDraft(draft: Draft): Draft {
  return draft.outgoingId === null ? draft : { ...draft, outgoingId: null, noticedStatus: null, pendingSave: true, sendAttemptId: null }
}

/**
 * The fields a user edits (and the server stores), as one comparable value: two drafts with the same value say the
 * same thing, whatever their versions, files or bookkeeping.
 */
export function editedFields(draft: EditableDraft): string {
  return JSON.stringify(requestOf(draft))
}

/** What the user writes in a draft: the fields a save sends, as a draft here and the server's copy both have them. */
type EditableDraft = Pick<SyncedDraft, 'mailAccountId' | 'kind' | 'to' | 'cc' | 'bcc' | 'subject' | 'html' | 'signatureId' | 'quoteHtml' | 'inReplyToMessageId'>

function requestOf(draft: EditableDraft): DraftRequest {
  return {
    mailAccountId: draft.mailAccountId,
    kind: draft.kind,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: draft.html,
    signatureId: draft.signatureId,
    quoteHtml: draft.quoteHtml,
    inReplyToMessageId: draft.inReplyToMessageId,
  }
}

/**
 * Keeps the drafts written on this device in step with the server: edits saved locally go up, one upload per draft at
 * a time, and another device's newer version is never overwritten but noted on the draft for the user to settle.
 * Shared by the web, desktop and mobile clients.
 */
export class DraftSync {
  private readonly uploads = new Map<string, Promise<void>>()
  /** Requests that change a draft on the server, one at a time per draft: each one's version is the next one's base. */
  private readonly lanes = new Map<string, Promise<unknown>>()
  private readonly again = new Set<string>()

  constructor(
    private readonly store: () => MailStore | null,
    private readonly api: DraftApi,
    /** Called when a conflict was noted, so screens can show it. */
    private readonly onConflict: () => void = () => {},
  ) {}

  /**
   * Brings the draft's unsaved edits to the server. Uploads of one draft never overlap: an upload asked for during one
   * runs right after it, with whatever was saved by then.
   */
  upload(id: string): Promise<void> {
    this.again.add(id)
    const running = this.uploads.get(id)
    if (running) {
      return running
    }
    const run = (async () => {
      try {
        while (this.again.delete(id)) {
          await this.uploadOnce(id)
        }
      } finally {
        this.uploads.delete(id)
      }
    })()
    this.uploads.set(id, run)
    return run
  }

  private uploadOnce(id: string): Promise<void> {
    return this.inLane(id, () => this.uploadNow(id))
  }

  /** Runs a request that changes the draft on the server after the ones before it. */
  private inLane<T>(id: string, request: () => Promise<T>): Promise<T> {
    const before = this.lanes.get(id) ?? Promise.resolve()
    const run = before.then(request, request)
    const settled = run.catch(() => undefined)
    this.lanes.set(id, settled)
    void settled.then(() => {
      if (this.lanes.get(id) === settled) {
        this.lanes.delete(id)
      }
    })
    return run
  }

  private async uploadNow(id: string): Promise<void> {
    const store = this.store()
    const local = await store?.draft(id)
    if (!store || !local || !local.pendingSave || local.remoteVersion !== null || local.outgoingId !== null) {
      return
    }
    let saved: SyncedDraft
    try {
      saved = local.version === 0 ? await this.api.create(id, requestOf(local)) : await this.api.update(id, requestOf(local), local.version)
    } catch (error) {
      const status = statusOf(error)
      // Deleted here while the request was under way: nothing to note on it.
      const now = await store.draft(id)
      if (status === 409 && local.version > 0 && now !== null) {
        const remote = await this.api.get(id)
        let movedOn = false
        await store.changeDraft(id, (stored) => {
          if (stored === null) {
            return null
          }
          // The copy here took a newer version of its own while the request was under way (a file change): the edits
          // go up again on that one. Any other refusal is a version to settle, also one behind this copy's (a server
          // restored from a backup): asking again would only be refused again.
          movedOn = stored.version !== local.version && remote.version <= stored.version
          return movedOn ? null : { ...stored, remoteVersion: remote.version }
        })
        if (movedOn) {
          this.again.add(id)
        } else {
          this.onConflict()
        }
        return
      }
      if (status === 409 && local.version === 0 && now !== null) {
        await this.recognise(store, id, local)
        return
      }
      if (status === 404 && local.version > 0 && now !== null) {
        // Deleted on another device while it was being written here: it becomes a new draft again.
        await store.changeDraft(id, (stored) => stored && { ...stored, version: 0 })
        this.again.add(id)
        return
      }
      if (now === null) {
        return
      }
      throw error
    }
    let unchanged = true
    const current = await store.changeDraft(id, (stored) => {
      if (stored === null) {
        return null
      }
      // Edits made while the upload was under way stay pending and go up in the next round.
      unchanged = stored.updatedAt === local.updatedAt
      return { ...withVersion(stored, saved.version), pendingSave: !unchanged }
    })
    if (current === null) {
      // Deleted here while the upload was under way: the copy the server just stored goes too.
      await this.removeRemote(id)
      return
    }
    if (!unchanged) {
      this.again.add(id)
    }
  }

  /**
   * A create refused because the server has a draft with this id already: the device chooses the id and retries it,
   * so this is a create whose answer was lost, or a copy rebuilt with its drafts reset to version 0. The server's copy
   * with the same text is taken as this one's; its first version is this device's own first save, which the edits
   * build on; anything later is another device's version to settle.
   */
  private async recognise(store: MailStore, id: string, local: Draft): Promise<void> {
    const remote = await this.api.get(id)
    let outcome = 'gone' as 'adopted' | 'again' | 'conflict' | 'gone'
    await store.changeDraft(id, (stored) => {
      if (stored === null) {
        return null
      }
      if (stored.version !== 0) {
        // Another upload of this copy got a version meanwhile: the edits go up on that one.
        outcome = 'again'
        return null
      }
      const attachments = (remote.attachments ?? []).map(withoutLink)
      if (editedFields(stored) === editedFields(remote)) {
        // Edits made while the request was under way stay pending and go up in the next round.
        const edited = stored.updatedAt !== local.updatedAt
        outcome = edited ? 'again' : 'adopted'
        return { ...withVersion(stored, remote.version), pendingSave: edited, attachments }
      }
      if (remote.version === 1 && stored.remoteVersion === null) {
        outcome = 'again'
        return { ...stored, version: 1, attachments }
      }
      outcome = 'conflict'
      return { ...stored, remoteVersion: remote.version }
    })
    if (outcome === 'again') {
      this.again.add(id)
    } else if (outcome === 'conflict') {
      this.onConflict()
    }
  }

  /** Uploads every draft with edits that did not reach the server yet, e.g. after starting offline. */
  async uploadPending(): Promise<void> {
    for (const draft of (await this.store()?.drafts()) ?? []) {
      if (draft.pendingSave && draft.remoteVersion === null && draft.outgoingId === null) {
        await this.upload(draft.id).catch(() => undefined)
      }
    }
  }

  /** Settles a conflict: keep the edits made here (they overwrite the other version) or take the other version. */
  async resolveConflict(id: string, keep: 'mine' | 'theirs'): Promise<Draft | null> {
    const store = this.store()
    const local = await store?.draft(id)
    if (!store || !local || local.remoteVersion === null) {
      return local ?? null
    }
    let remote: Awaited<ReturnType<DraftApi['get']>>
    try {
      remote = await this.api.get(id)
    } catch (error) {
      if (statusOf(error) !== 404) {
        throw error
      }
      // The other version is gone (sent or deleted on another device): the edits here are all there is left, whichever
      // was chosen. They become a new draft, which is what an upload does with a draft the server no longer has.
      await store.changeDraft(id, (stored) => stored && { ...stored, version: 0, remoteVersion: null, pendingSave: true })
      // Offline by now: the edits stay pending here and go up with the next upload.
      await this.upload(id).catch(() => undefined)
      return store.draft(id)
    }
    const next = await store.changeDraft(id, (stored) =>
      stored === null
        ? null
        : keep === 'mine'
          ? { ...stored, version: remote.version, remoteVersion: null, pendingSave: true, attachments: (remote.attachments ?? []).map(withoutLink) }
          : { ...remote, attachments: (remote.attachments ?? []).map(withoutLink), updatedAt: Date.parse(remote.updatedAt), pendingSave: false, remoteVersion: null, outgoingId: null, noticedStatus: null },
    )
    if (keep === 'mine') {
      await this.upload(id)
    }
    return (await store.draft(id)) ?? next
  }

  /** Removes the draft here and on the server, and with it its copy in the Drafts folder. */
  async deleteEverywhere(id: string): Promise<void> {
    // An upload under way finishes first, so the server copy it makes is known and removed with the rest.
    this.again.delete(id)
    await this.uploads.get(id)?.catch(() => undefined)
    const store = this.store()
    const local = await store?.draft(id)
    if (local && local.version > 0) {
      await this.removeRemote(id)
    }
    await store?.deleteDraft(id)
  }

  /** Deletes the server's copy; one that is gone already is fine. Other failures are thrown (offline, say). */
  private async removeRemote(id: string): Promise<void> {
    try {
      await this.api.remove(id)
    } catch (error) {
      if (statusOf(error) !== 404) {
        throw error
      }
    }
  }

  /**
   * Attaches a file to the draft. The server keeps files with its copy of the draft, so the draft goes up first; the
   * attachment is noted on the copy here too.
   *
   * @throws AttachmentsNeedTheServer when the draft cannot reach the server
   */
  async attach(id: string, file: AttachmentFile): Promise<DraftAttachmentLink> {
    await this.ensureOnServer(id)
    return this.inLane(id, async () => {
      const before = await this.versionHere(id)
      const attachment = await this.api.attach(id, file)
      await this.note(id, (attachments) => [...attachments.filter((other) => other.id !== attachment.id), withoutLink(attachment)], before, attachment.draftVersion ?? null)
      return attachment
    })
  }

  /** Attaches a file of a received message, for a forward; the same file twice is attached once. */
  async forward(id: string, attachmentId: string): Promise<DraftAttachmentLink> {
    await this.ensureOnServer(id)
    return this.inLane(id, async () => {
      const before = await this.versionHere(id)
      const attachment = await this.api.forward(id, attachmentId)
      await this.note(id, (attachments) => [...attachments.filter((other) => other.id !== attachment.id), withoutLink(attachment)], before, attachment.draftVersion ?? null)
      return attachment
    })
  }

  /** Removes a file from the draft; one that is gone already is fine. */
  async detach(id: string, attachmentId: string): Promise<void> {
    await this.inLane(id, async () => {
      const before = await this.versionHere(id)
      let after: number | null = null
      try {
        after = (await this.api.detach(id, attachmentId)).draftVersion
      } catch (error) {
        if (statusOf(error) !== 404) {
          throw error
        }
      }
      await this.note(id, (attachments) => attachments.filter((attachment) => attachment.id !== attachmentId), before, after)
    })
  }

  /** Fresh download links for the draft's files (the copy here keeps none: they expire). */
  async links(id: string): Promise<DraftAttachmentLink[]> {
    return (await this.api.get(id)).attachments ?? []
  }

  /** A link to a file that could not be scanned, for a user who confirmed they accept that. */
  async unscannedLink(attachmentId: string): Promise<{ url: string }> {
    return this.api.unscannedLink(attachmentId)
  }

  private async ensureOnServer(id: string): Promise<void> {
    await this.upload(id).catch(() => undefined)
    const stored = await this.store()?.draft(id)
    if (!stored || stored.version === 0) {
      throw new AttachmentsNeedTheServer()
    }
  }

  private async versionHere(id: string): Promise<number> {
    return (await this.store()?.draft(id))?.version ?? 0
  }

  /**
   * Notes a change to the draft's files on the copy here. A change to the files raises the draft's version on the
   * server; when the server's version is the one right after the copy's (nothing else changed it meanwhile), the copy
   * takes it, so the next edit is not taken for a conflict. Any other version is left for the next upload to find.
   */
  private async note(id: string, change: (attachments: DraftAttachment[]) => DraftAttachment[], before: number, after: number | null): Promise<void> {
    await this.store()?.changeDraft(id, (stored) => {
      if (stored === null) {
        return null
      }
      const changed = { ...stored, attachments: change(stored.attachments) }
      return after !== null && stored.version === before && after === before + 1 ? withVersion(changed, after) : changed
    })
  }

  /** Saves the draft and uploads it, reporting whether the server has it (so sending can take its Drafts copy away). */
  async uploadForSending(draft: Draft): Promise<boolean> {
    const store = this.store()
    if (!store) {
      return false
    }
    await store.changeDraft(draft.id, (stored) => withEdits(stored, draft))
    return this.upload(draft.id)
      .then(async () => ((await store.draft(draft.id))?.version ?? 0) > 0)
      .catch(() => false)
  }
}

/**
 * The draft as stored with the server's version `version`, which the copy here now builds on. A version of another
 * device noted meanwhile that is not past it was this device's own (a sync brought it back before the answer came).
 */
function withVersion(draft: Draft, version: number): Draft {
  return { ...draft, version, remoteVersion: draft.remoteVersion !== null && draft.remoteVersion <= version ? null : draft.remoteVersion }
}

/**
 * The edits made on screen laid over the draft as stored. What the uploads learned (the server version, a conflict)
 * stays, and so do the files: the screen does not know either for sure.
 */
export function withEdits(stored: Draft | null, edited: Draft): Draft {
  return {
    ...edited,
    version: stored?.version ?? edited.version,
    remoteVersion: stored?.remoteVersion ?? null,
    attachments: stored?.attachments ?? edited.attachments,
    // A send under way keeps its id while the text stays the same; an edited message is a new one.
    sendAttemptId: stored !== null && editedFields(stored) === editedFields(edited) ? (stored.sendAttemptId ?? null) : null,
  }
}

/** What a form was opened on: the text (see {@link editedFields}) and version of the draft as last read or written. */
export interface DraftBase {
  version: number
  fields: string
}

/**
 * {@link withEdits}, for edits made on `base`. The delta replaces a stored draft that has nothing waiting to go up with
 * another device's newer version; edits made on the older text must not be laid over it as if they built on it (they
 * would overwrite it on the server). They keep the version they do build on and note the other one, so the user is
 * asked which to keep.
 */
export function withEditsOver(stored: Draft | null, edited: Draft, base: DraftBase | null): Draft {
  const laid = withEdits(stored, edited)
  if (stored === null || base === null || stored.pendingSave || stored.version <= base.version || editedFields(stored) === base.fields) {
    return laid
  }
  return { ...laid, version: base.version, remoteVersion: stored.version }
}

/** A draft attachment as the copy on a device keeps it: without its link, which expires. */
export function withoutLink(attachment: DraftAttachmentLink | DraftAttachment): DraftAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    scanStatus: attachment.scanStatus,
    inline: attachment.inline ?? false,
    contentId: attachment.contentId ?? null,
  }
}
