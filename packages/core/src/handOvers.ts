import { composeBody, escapeHtml, replySubject } from './compose'
import type { Composer } from './composer'
import { defaultSignatureOf } from './drafts'
import type { Draft } from './store/mailStore'
import type { Address, SyncedHandOver, SyncedMailAccount, SyncedMessage, SyncedOutgoingMessage, SyncedSignature } from './sync/types'

/** What the API accepts for a note; the web form checks the same. */
export const MAX_NOTE = 10_000
/** A due date is at most this far ahead (the API refuses later ones). */
export const MAX_DUE_DAYS = 365
/** The hour of the day a due date falls on: the end of a working day. */
export const DUE_HOUR = 17

/** POST /api/v1/hand-overs */
export interface CreateHandOverRequest {
  messageId: string
  delegate: Address
  note: string
  /** ISO 8601. */
  dueAt: string
  /** The outgoing message that forwarded it. */
  forwardId: string
}

/** PATCH /api/v1/hand-overs/{id} */
export interface UpdateHandOverRequest {
  dueAt?: string
  /** True marks it done; false puts it back in "Waiting on". */
  done?: boolean
}

/** POST /api/v1/hand-overs/{id}/nudge */
export interface NudgeRequest {
  html: string
  /** ISO 8601; a few seconds ahead leaves room to undo. */
  sendAt?: string
}

export interface HandOverApi {
  create(request: CreateHandOverRequest): Promise<SyncedHandOver>
  update(id: string, request: UpdateHandOverRequest): Promise<SyncedHandOver>
  withdraw(id: string): Promise<void>
  nudge(id: string, request: NudgeRequest): Promise<SyncedHandOver>
}

/**
 * Notices delivered longer ago than this before a device started telling are old news reaching it late (a copy
 * rebuilt, a device that was offline), not news.
 */
export const NOTICE_FRESHNESS_MS = 15 * 60_000

/** One per round: a new due date that passes tells again. */
export function noticeKey(handOver: SyncedHandOver): string {
  return `${handOver.id}:${handOver.notifiedAt ?? ''}`
}

/**
 * The overdue notices the server delivered that are news on this device, from the hand-overs of the pages applied: still
 * open, delivered on some channel (on `channel` when given), no longer than {@link NOTICE_FRESHNESS_MS} before this
 * device started telling, and not shown before (see {@link noticeKey}). The server decided when and how (channels,
 * focus holds, quiet hours); clients only show what it delivered.
 */
export function deliveredNotices(handOvers: SyncedHandOver[], notifyingSince: number, shown: ReadonlySet<string>, channel?: string): SyncedHandOver[] {
  const due = new Map<string, SyncedHandOver>()
  for (const handOver of handOvers) {
    if (
      handOver.state === 'open' &&
      handOver.notifiedAt !== null &&
      handOver.notifiedChannels.length > 0 &&
      (channel === undefined || handOver.notifiedChannels.includes(channel)) &&
      Date.parse(handOver.notifiedAt) >= notifyingSince - NOTICE_FRESHNESS_MS &&
      !shown.has(noticeKey(handOver))
    ) {
      due.set(noticeKey(handOver), handOver)
    }
  }
  return [...due.values()]
}

/** "Waiting on" order: open hand-overs by due date first, then closed ones, most recently closed first. */
export function compareHandOvers(a: SyncedHandOver, b: SyncedHandOver): number {
  const aOpen = a.state === 'open'
  const bOpen = b.state === 'open'
  if (aOpen !== bOpen) {
    return aOpen ? -1 : 1
  }
  if (aOpen) {
    return Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id)
  }
  return Date.parse(b.closedAt ?? b.updatedAt) - Date.parse(a.closedAt ?? a.updatedAt) || b.id.localeCompare(a.id)
}

export type HandOverStatus = 'overdue' | 'waiting' | 'replied' | 'done'

/** How a hand-over stands now: an open one whose due date passed is overdue, also before the server marked it. */
export function handOverStatus(handOver: SyncedHandOver, now: Date = new Date()): HandOverStatus {
  if (handOver.state !== 'open') {
    return handOver.state
  }
  return Date.parse(handOver.dueAt) <= now.getTime() ? 'overdue' : 'waiting'
}

/** The open hand-overs of a conversation, soonest due first. */
export function openHandOversOf(handOvers: SyncedHandOver[], threadId: string): SyncedHandOver[] {
  return handOvers.filter((handOver) => handOver.state === 'open' && handOver.threadId === threadId).sort(compareHandOvers)
}

/** Whether its latest nudge counts: it was not cancelled and did not fail. */
export function nudgeStands(handOver: SyncedHandOver, nudge: SyncedOutgoingMessage | null): boolean {
  if (handOver.nudgedAt === null) {
    return false
  }
  return nudge === null || (nudge.status !== 'cancelled' && nudge.status !== 'failed')
}

/** The name to greet someone by: the first word of their name, else their address before the @. */
export function firstName(person: Address): string {
  const name = person.name?.trim().split(/\s+/)[0]
  return name !== undefined && name !== '' ? name : (person.address.split('@')[0] ?? person.address)
}

/** Plain text as HTML paragraphs: a blank line starts a paragraph, a line break stays one. */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** What the forward says above the original: the note, then when an answer is due. */
export function noteHtml(note: string, dueLabel: string): string {
  const due = `<p>Could you get back to me by ${escapeHtml(dueLabel)}?</p>`
  return note.trim() === '' ? due : `${textToHtml(note)}${due}`
}

/** A suggested follow-up for the delegate, in plain text the user can change before it goes. */
export function nudgeText(handOver: SyncedHandOver, dueLabel: string, now: Date = new Date()): string {
  const name = firstName(handOver.delegate)
  const overdue = Date.parse(handOver.dueAt) <= now.getTime()
  const when = overdue ? `It was due ${dueLabel}.` : `It is due ${dueLabel}.`
  return `Hi ${name},\n\nJust checking in on "${handOver.subject}", which I forwarded to you. ${when} Could you let me know where it stands?\n\nThanks`
}

/** The same day at the hour due dates fall on. */
export function dueOn(day: Date): Date {
  const at = new Date(day)
  at.setHours(DUE_HOUR, 0, 0, 0)
  return at
}

export type DueChoice = 'today' | 'tomorrow' | 'friday' | 'nextWeek'

/**
 * The due dates offered with one click: today (while there is still an hour of it left), tomorrow, and this Friday when
 * it lies beyond tomorrow, else Monday next week.
 */
export function dueChoices(now: Date = new Date()): { key: DueChoice; at: Date }[] {
  const day = (offset: number) => {
    const at = new Date(now)
    at.setDate(at.getDate() + offset)
    return dueOn(at)
  }
  const choices: { key: DueChoice; at: Date }[] = []
  const today = dueOn(now)
  if (today.getTime() - now.getTime() >= 60 * 60 * 1000) {
    choices.push({ key: 'today', at: today })
  }
  choices.push({ key: 'tomorrow', at: day(1) })
  const toFriday = (5 - now.getDay() + 7) % 7
  if (toFriday > 1) {
    choices.push({ key: 'friday', at: day(toFriday) })
  } else {
    choices.push({ key: 'nextWeek', at: day(((1 - now.getDay() + 7) % 7) || 7) })
  }
  return choices
}

/** What the hand-over form collects. */
export interface HandOverInput {
  delegate: Address
  note: string
  dueAt: Date
  /** How the due date reads in the forward, in the writer's words ("Friday 24 October"). */
  dueLabel: string
  /** The user confirmed forwarding files that could not be scanned (after an {@link UnscannedFilesError}). */
  acceptUnscanned?: boolean
}

/** A hand-over just made, which can be taken back until its forward leaves. */
export interface HandedOver {
  handOver: SyncedHandOver
  forwardId: string
  draftId: string
  /** Epoch ms when the forward leaves. */
  until: number
}

/** A nudge just queued, which can be taken back until it leaves. */
export interface Nudged {
  handOver: SyncedHandOver
  nudgeId: string
  until: number
}

export class HandOverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HandOverError'
  }
}

/** Files of the original could not be scanned: they go along only once the user confirms (`acceptUnscanned`). */
export class UnscannedFilesError extends HandOverError {
  constructor(message: string) {
    super(message)
    this.name = 'UnscannedFilesError'
  }
}

export interface HandOverFlowDeps {
  /** A composer of its own, not the one on screen: handing over writes and sends the forward in the background. */
  composer: Composer
  api: HandOverApi
  /** Cancels an outgoing message (undo send). */
  cancel(outgoingId: string): Promise<SyncedOutgoingMessage>
  /** An outgoing message as the copy has it, or null when it is not there. */
  outgoing(outgoingId: string): Promise<SyncedOutgoingMessage | null>
  accounts(): SyncedMailAccount[]
  signatures(): SyncedSignature[]
  /** Pulls the delta, so the copy shows what changed. */
  sync(): Promise<void>
  /** What a failed request means for the user. */
  explain(error: unknown): { message: string }
  /** Seconds a nudge waits before it goes out, so it can be undone; the composer's own window applies to forwards. */
  undoSeconds?: number
  /** The time on the server's clock (epoch ms), which a nudge's send time is counted on; the device's by default. */
  now?(): number
  /**
   * How long one step that uses the flow's composer may hold the next one up, in ms: a request that hangs must not
   * stop every later hand-over and undo. The step itself goes on.
   */
  queueTimeoutMs?: number
}

const QUEUE_TIMEOUT_MS = 60_000

/**
 * Handing over, the same on every client: the conversation is forwarded to the delegate with the note through the
 * shared compose flow (its files go along), and the hand-over is recorded once the forward is queued. Until the forward
 * leaves, both can be taken back at once. Nudges reply to the delegate in the same conversation.
 */
export class HandOverFlow {
  /**
   * The flow's composer holds one draft at a time, so hand-overs run one after another: none finds another's draft
   * open after an await. What does not need the draft on screen (stopping a forward, withdrawing a hand-over, throwing
   * away the draft a taken back forward came back as, by its id) does not wait for them: a forward leaves within
   * seconds.
   */
  private queue: Promise<unknown> = Promise.resolve()
  /**
   * The composer session (see Composer.session) a hand-over is using the composer in right now, or null: it keeps it
   * until it settles, also past its turn's time limit. A sign-out starts another session, which it does not hold up.
   */
  private composingIn: number | null = null
  /** Clean-ups still under way after an undo or take back answered; see {@link idle}. */
  private readonly cleanups = new Set<Promise<unknown>>()

  constructor(private readonly deps: HandOverFlowDeps) {}

  /**
   * Runs a step that uses the composer once the steps before it are done. A step that takes longer than the time limit
   * (counted from when it starts) lets the queue go on, but keeps the composer: the next step is refused until it
   * settles, rather than sharing the draft on screen with it.
   */
  private inOrder<T>(task: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    let startLimit: () => void = () => undefined
    const limit = new Promise<void>((resolve) => {
      startLimit = () => {
        timer = setTimeout(resolve, this.deps.queueTimeoutMs ?? QUEUE_TIMEOUT_MS)
      }
    })
    const composer = this.deps.composer
    const queuedIn = composer.session
    const step = async (): Promise<T> => {
      const session = composer.session
      if (session !== queuedIn) {
        // Asked for before a sign-out: it belongs to a session that is over.
        throw new HandOverError('You were signed out. Sign in again to hand this over.')
      }
      if (this.composingIn === session) {
        throw new HandOverError('Another hand-over is still being made. Try again in a moment.')
      }
      this.composingIn = session
      startLimit()
      try {
        return await task()
      } finally {
        if (this.composingIn === session) {
          this.composingIn = null
        }
      }
    }
    const run = this.queue.then(step, step)
    this.queue = Promise.race([run.catch(() => undefined), limit]).finally(() => {
      if (timer !== null) {
        clearTimeout(timer)
      }
    })
    return run
  }

  /** Resolves once the clean-ups of earlier undos and take backs (throwing away their drafts) are done. */
  async idle(): Promise<void> {
    while (this.cleanups.size > 0) {
      await Promise.all([...this.cleanups])
    }
  }

  /** Throws the draft a taken back forward came back as away, after the answer: it is clean-up, not part of the undo. */
  private cleanUp(draftId: string): void {
    const cleanup = this.deps.composer.discardStored(draftId).catch(() => undefined)
    this.cleanups.add(cleanup)
    void cleanup.then(() => this.cleanups.delete(cleanup))
  }

  /** @throws HandOverError with the reason, after taking back whatever was done already */
  handOver(message: SyncedMessage, input: HandOverInput): Promise<HandedOver> {
    return this.inOrder(() => this.handOverNow(message, input))
  }

  private async handOverNow(message: SyncedMessage, input: HandOverInput): Promise<HandedOver> {
    const composer = this.deps.composer
    try {
      await composer.openReply(message, 'forward', { strict: true })
    } catch (error) {
      // Without the original (and its files) the forward would not be what is handed over: nothing is sent.
      throw new HandOverError(error instanceof Error ? error.message : this.deps.explain(error).message)
    }
    const draft = composer.state.draft
    if (draft === null) {
      throw new HandOverError('You were signed out. Sign in again to hand this over.')
    }
    if (draft.kind !== 'forward' || draft.inReplyToMessageId !== message.id) {
      throw new HandOverError('Another message took the place of the forward. Hand it over again.')
    }
    if (composer.state.error !== null) {
      // A file of the original could not go along: rather than forward without it, nothing is sent.
      const reason = composer.state.error
      await composer.discard()
      throw new HandOverError(reason)
    }
    composer.update({ to: [input.delegate], html: noteHtml(input.note, input.dueLabel) })
    const forward = await composer.send(undefined, input.acceptUnscanned ?? false)
    if (forward === null) {
      const unscanned = composer.state.unscannedToConfirm
      const reason = composer.state.error ?? unscanned?.message ?? 'The forward could not be sent.'
      composer.keepEditing()
      await composer.discard()
      throw unscanned === null ? new HandOverError(reason) : new UnscannedFilesError(reason)
    }
    const undoable = composer.state.undoable
    let handOver: SyncedHandOver
    try {
      handOver = await this.deps.api.create({
        messageId: message.id,
        delegate: input.delegate,
        note: input.note.trim(),
        dueAt: input.dueAt.toISOString(),
        forwardId: forward.id,
      })
    } catch (error) {
      // Not recorded: the forward is stopped too, so nothing is handed over that "Waiting on" would not show.
      const reason = this.deps.explain(error).message
      try {
        await this.takeBackForward(forward.id, draft.id)
      } catch {
        const who = input.delegate.name?.trim() || input.delegate.address
        throw new HandOverError(`${sentence(reason)} The forward to ${who} could not be stopped and may still be sent, but it is not in "Waiting on".`)
      }
      throw new HandOverError(reason)
    }
    await this.deps.sync().catch(() => undefined)
    return { handOver, forwardId: forward.id, draftId: draft.id, until: undoable?.until ?? Date.now() }
  }

  /**
   * Stops the forward and withdraws the hand-over. Once the forward has left it is too late: the hand-over stays.
   *
   * @throws HandOverError when it is too late or the server cannot be reached
   */
  async undo(handed: HandedOver): Promise<void> {
    // Stopped at once, not after a hand-over still being made: the forward leaves within seconds.
    try {
      await this.deps.cancel(handed.forwardId)
    } catch (error) {
      throw new HandOverError(`Too late to undo: ${this.deps.explain(error).message}`)
    }
    try {
      await this.deps.api.withdraw(handed.handOver.id)
    } finally {
      await this.deps.sync().catch(() => undefined)
    }
    this.cleanUp(handed.draftId)
  }

  /**
   * Takes a hand-over back as far as it still can (triage's undo): the forward and the hand-over while the forward has
   * not left, only the hand-over once it surely has (the delegate has the mail; nothing waits on them any more). Returns
   * which. When the cancel fails and the forward did not surely leave (offline, say: it may still go out), nothing is
   * taken back.
   *
   * @throws HandOverError saying the hand-over still stands
   */
  async takeBack(handed: HandedOver): Promise<'undone' | 'withdrawn'> {
    // Stopped at once (see undo); throwing the draft away is clean-up after the answer.
    let refused: unknown = null
    try {
      await this.deps.cancel(handed.forwardId)
    } catch (error) {
      refused = error
    }
    if (refused !== null) {
      // The answer may be lost while the cancel went through: the copy says how the forward stands.
      await this.deps.sync().catch(() => undefined)
      const forward = await this.deps.outgoing(handed.forwardId)
      if (forward?.status === 'sent') {
        await this.withdraw(handed.handOver)
        return 'withdrawn'
      }
      if (forward?.status !== 'cancelled') {
        throw new HandOverError(`The hand-over could not be taken back, so it still stands: ${this.deps.explain(refused).message}`)
      }
    }
    // The hand-over goes before the draft the forward came back as: when this stops halfway, trying again finds the
    // forward cancelled and withdraws what is left; a draft left behind is the user's to throw away.
    try {
      await this.deps.api.withdraw(handed.handOver.id)
    } finally {
      await this.deps.sync().catch(() => undefined)
    }
    this.cleanUp(handed.draftId)
    return 'undone'
  }

  /** Queues the follow-up (plain text, signed with the account's default signature) as a reply to the delegate. */
  async nudge(handOver: SyncedHandOver, text: string): Promise<Nudged> {
    const signatureId = defaultSignatureOf(this.deps.accounts(), this.deps.signatures(), handOver.mailAccountId)
    const signature = this.deps.signatures().find((candidate) => candidate.id === signatureId)?.html ?? null
    const window = (this.deps.undoSeconds ?? 5) * 1000
    // The send time is the server's to keep, so it is counted on its clock; `until` is the same moment on this device.
    const until = Date.now() + window
    const sendAt = new Date((this.deps.now?.() ?? Date.now()) + window)
    const nudged = await this.deps.api.nudge(handOver.id, { html: composeBody(textToHtml(text), signature, ''), sendAt: sendAt.toISOString() })
    await this.deps.sync().catch(() => undefined)
    if (nudged.lastNudgeId === null) {
      throw new HandOverError('The nudge was not queued.')
    }
    return { handOver: nudged, nudgeId: nudged.lastNudgeId, until }
  }

  async undoNudge(nudged: Nudged): Promise<void> {
    try {
      await this.deps.cancel(nudged.nudgeId)
    } catch (error) {
      throw new HandOverError(`Too late to undo: ${this.deps.explain(error).message}`)
    } finally {
      await this.deps.sync().catch(() => undefined)
    }
  }

  markDone(handOver: SyncedHandOver): Promise<SyncedHandOver> {
    return this.change(handOver, { done: true })
  }

  reopen(handOver: SyncedHandOver): Promise<SyncedHandOver> {
    return this.change(handOver, { done: false })
  }

  reschedule(handOver: SyncedHandOver, dueAt: Date): Promise<SyncedHandOver> {
    return this.change(handOver, { dueAt: dueAt.toISOString() })
  }

  async withdraw(handOver: SyncedHandOver): Promise<void> {
    await this.deps.api.withdraw(handOver.id)
    await this.deps.sync().catch(() => undefined)
  }

  private async change(handOver: SyncedHandOver, request: UpdateHandOverRequest): Promise<SyncedHandOver> {
    const changed = await this.deps.api.update(handOver.id, request)
    await this.deps.sync().catch(() => undefined)
    return changed
  }

  /** Cancels the forward and throws away the draft it came back as. */
  private async takeBackForward(forwardId: string, draftId: string): Promise<void> {
    await this.deps.cancel(forwardId)
    await this.deps.composer.discardStored(draftId)
  }
}

/** A reason as a sentence of its own, so another can follow it. */
function sentence(reason: string): string {
  const trimmed = reason.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** What triage says when undoing a hand-over could only withdraw it: the forward had left already. */
export function withdrawnNotice(handed: Pick<HandedOver, 'handOver'>): string {
  const who = handed.handOver.delegate.name?.trim() || handed.handOver.delegate.address
  return `${who} has the forward already; the hand-over is withdrawn, so nothing waits on them any more.`
}

/** A follow-up to write in the composer ("Edit first"): to the delegate, in the conversation that was handed over. */
export function followUpDraft(handOver: SyncedHandOver, text: string, forwardSubject: string | null): Pick<Draft, 'kind' | 'mailAccountId' | 'to' | 'subject' | 'html' | 'inReplyToMessageId'> {
  return {
    kind: 'reply',
    mailAccountId: handOver.mailAccountId,
    to: [handOver.delegate],
    subject: replySubject(forwardSubject ?? handOver.subject),
    html: textToHtml(text),
    inReplyToMessageId: handOver.messageId,
  }
}
