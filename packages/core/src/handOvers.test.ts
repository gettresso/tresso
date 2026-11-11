import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageRequest } from './compose'
import { Composer } from './composer'
import { DraftSync } from './drafts'
import { ApiFailure, FakeDraftApi } from './drafts.fake'
import {
  compareHandOvers,
  deliveredNotices,
  dueChoices,
  firstName,
  followUpDraft,
  HandOverError,
  HandOverFlow,
  handOverStatus,
  noteHtml,
  nudgeStands,
  noticeKey,
  nudgeText,
  openHandOversOf,
  textToHtml,
  UnscannedFilesError,
  type CreateHandOverRequest,
  type NudgeRequest,
  type UpdateHandOverRequest,
} from './handOvers'
import { accounts, handOver, message, page, signature } from './store/contract'
import { memorySql } from './store/memorySql'
import { SqliteMailStore } from './store/sqlite'
import type { MessageAttachment, SyncedHandOver, SyncedOutgoingMessage } from './sync/types'

function outgoing(id: string, status: SyncedOutgoingMessage['status']): SyncedOutgoingMessage {
  return { id, mailAccountId: 'work', status, subject: 'Fwd: Invoice question', recipients: { to: [], cc: [], bcc: [] }, sendAt: '2026-10-20T09:00:00Z', sentAt: null, lastError: null, inReplyToMessageId: 'm1' }
}

describe('hand-over rules', () => {
  it('shows the notices the server delivered once per round, fresh, on the channel asked for', () => {
    const since = Date.parse('2026-10-24T15:00:00Z')
    const notified = (id: string, at: string, channels: string[], extra: Partial<SyncedHandOver> = {}) => handOver(id, 'm1', 'work', { overdueAt: at, notifiedAt: at, notifiedChannels: channels, ...extra })
    const list = [
      notified('desk', '2026-10-24T15:05:00Z', ['phone', 'desktop']),
      notified('phone', '2026-10-24T15:05:00Z', ['phone']),
      notified('none', '2026-10-24T15:05:00Z', []),
      notified('old', '2026-10-24T14:30:00Z', ['desktop']),
      notified('closed', '2026-10-24T15:05:00Z', ['desktop'], { state: 'done' }),
      handOver('waiting', 'm1', 'work', { overdueAt: '2026-10-24T15:05:00Z' }),
      notified('desk', '2026-10-24T15:05:00Z', ['phone', 'desktop'], { nudgedAt: '2026-10-24T15:10:00Z' }),
    ]

    expect(deliveredNotices(list, since, new Set()).map((h) => h.id)).toEqual(['desk', 'phone'])
    expect(deliveredNotices(list, since, new Set(), 'desktop').map((h) => h.id)).toEqual(['desk'])
    expect(deliveredNotices(list, since, new Set([noticeKey(list[0]!)]), 'desktop')).toEqual([])
    // A new due date that passed is a new round: told again.
    const again = notified('desk', '2026-10-25T15:05:00Z', ['desktop'])
    expect(deliveredNotices([again], since, new Set([noticeKey(list[0]!)])).map((h) => h.id)).toEqual(['desk'])
  })

  it('orders open ones by due date before closed ones, most recently closed first', () => {
    const list = [
      handOver('closed-early', 'm1', 'work', { state: 'done', closedAt: '2026-10-20T08:00:00Z' }),
      handOver('late', 'm1', 'work', { dueAt: '2026-10-30T15:00:00Z' }),
      handOver('closed-late', 'm1', 'work', { state: 'replied', closedAt: '2026-10-21T08:00:00Z' }),
      handOver('soon', 'm1', 'work', { dueAt: '2026-10-21T15:00:00Z' }),
    ]

    expect(list.sort(compareHandOvers).map((h) => h.id)).toEqual(['soon', 'late', 'closed-late', 'closed-early'])
  })

  it('says how a hand-over stands, overdue as soon as the due date passed', () => {
    const open = handOver('h1', 'm1', 'work', { dueAt: '2026-10-24T15:00:00Z' })

    expect(handOverStatus(open, new Date('2026-10-24T14:59:00Z'))).toBe('waiting')
    expect(handOverStatus(open, new Date('2026-10-24T15:00:00Z'))).toBe('overdue')
    expect(handOverStatus({ ...open, state: 'replied' }, new Date('2026-10-30T00:00:00Z'))).toBe('replied')
    expect(handOverStatus({ ...open, state: 'done' })).toBe('done')
  })

  it('finds the open hand-overs of a conversation', () => {
    const list = [handOver('a', 'm1', 'work', { threadId: 't1', dueAt: '2026-10-30T15:00:00Z' }), handOver('b', 'm1', 'work', { threadId: 't1', dueAt: '2026-10-22T15:00:00Z' }), handOver('c', 'm1', 'work', { threadId: 't1', state: 'done' }), handOver('d', 'm3', 'work', { threadId: 't2' })]

    expect(openHandOversOf(list, 't1').map((h) => h.id)).toEqual(['b', 'a'])
  })

  it('counts a nudge only while it was not cancelled or failed', () => {
    const nudged = handOver('h1', 'm1', 'work', { nudgedAt: '2026-10-24T16:00:00Z', lastNudgeId: 'n1' })

    expect(nudgeStands(handOver('h1', 'm1', 'work'), null)).toBe(false)
    expect(nudgeStands(nudged, outgoing('n1', 'scheduled'))).toBe(true)
    expect(nudgeStands(nudged, outgoing('n1', 'sent'))).toBe(true)
    expect(nudgeStands(nudged, outgoing('n1', 'cancelled'))).toBe(false)
    expect(nudgeStands(nudged, outgoing('n1', 'failed'))).toBe(false)
    expect(nudgeStands(nudged, null)).toBe(true)
  })

  it('greets by first name, or by the address when there is no name', () => {
    expect(firstName({ address: 'lisa@company.example', name: 'Lisa Bakker' })).toBe('Lisa')
    expect(firstName({ address: 'tom.degroot@company.example', name: null })).toBe('tom.degroot')
    expect(firstName({ address: 'x@company.example', name: '  ' })).toBe('x')
  })

  it('writes the note as escaped paragraphs and asks for an answer by the due date', () => {
    expect(textToHtml('Can you <check> this?\nThanks\n\nKim')).toBe('<p>Can you &lt;check&gt; this?<br>Thanks</p><p>Kim</p>')
    expect(noteHtml('Can you check?', 'Friday 24 October')).toBe('<p>Can you check?</p><p>Could you get back to me by Friday 24 October?</p>')
    expect(noteHtml('  ', 'Friday 24 October')).toBe('<p>Could you get back to me by Friday 24 October?</p>')
  })

  it('suggests a follow-up that says whether it was due or is due', () => {
    const open = handOver('h1', 'm1', 'work', { subject: 'Invoice question', dueAt: '2026-10-24T15:00:00Z' })

    expect(nudgeText(open, 'Friday', new Date('2026-10-25T08:00:00Z'))).toBe('Hi Lisa,\n\nJust checking in on "Invoice question", which I forwarded to you. It was due Friday. Could you let me know where it stands?\n\nThanks')
    expect(nudgeText(open, 'Friday', new Date('2026-10-23T08:00:00Z'))).toContain('It is due Friday.')
  })

  it('offers today while an hour of it is left, tomorrow, and Friday or else next Monday', () => {
    const at = (date: string) => dueChoices(new Date(date)).map((choice) => [choice.key, choice.at.getDate(), choice.at.getHours()])

    // Monday 20 October 2026, morning.
    expect(at('2026-10-20T09:00:00')).toEqual([['today', 20, 17], ['tomorrow', 21, 17], ['friday', 23, 17]])
    // Monday late in the afternoon: no today.
    expect(at('2026-10-20T16:30:00')).toEqual([['tomorrow', 21, 17], ['friday', 23, 17]])
    // Thursday: Friday is tomorrow, so next Monday instead.
    expect(at('2026-10-22T09:00:00')).toEqual([['today', 22, 17], ['tomorrow', 23, 17], ['nextWeek', 26, 17]])
    // Friday.
    expect(at('2026-10-23T09:00:00')).toEqual([['today', 23, 17], ['tomorrow', 24, 17], ['nextWeek', 26, 17]])
  })

  it('prepares a follow-up to the delegate in the conversation that was handed over', () => {
    expect(followUpDraft(handOver('h1', 'm1', 'work', { subject: 'Invoice question' }), 'Any news?', 'Fwd: Invoice question')).toEqual({
      kind: 'reply',
      mailAccountId: 'work',
      to: [{ address: 'lisa@company.example', name: 'Lisa Bakker' }],
      subject: 'Re: Fwd: Invoice question',
      html: '<p>Any news?</p>',
      inReplyToMessageId: 'm1',
    })
  })
})

describe('HandOverFlow', () => {
  const original = message('m1', 't1', 'work', ['work-inbox'], '2026-10-19T08:00:00+00:00', { subject: 'Invoice question' })
  const input = { delegate: { address: 'lisa@company.example', name: 'Lisa Bakker' }, note: ' Can you check the double charge? ', dueAt: new Date('2026-10-24T15:00:00Z'), dueLabel: 'Friday 24 October' }

  let store: SqliteMailStore
  let drafts: FakeDraftApi
  let composer: Composer
  let sent: SendMessageRequest[]
  let cancelled: string[]
  let created: CreateHandOverRequest[]
  let updated: [string, UpdateHandOverRequest][]
  let withdrawn: string[]
  let nudges: [string, NudgeRequest][]
  let syncs: number
  let createFails: unknown
  let cancelFails: unknown
  let withdrawFails: unknown
  /** How the copy says the forward stands after a cancel failed; null when it does not have it. */
  let forwardStatus: SyncedOutgoingMessage['status'] | null
  let originalFiles: MessageAttachment[]
  let unscannedRefused: boolean
  let bodyFails: unknown
  let flow: HandOverFlow

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T09:00:00Z'))
    store = await SqliteMailStore.open(await memorySql())
    await store.apply(page({ cursor: 1, mailAccounts: accounts, signatures: [signature('sig-work', 'Work')] }))
    drafts = new FakeDraftApi()
    sent = []
    cancelled = []
    created = []
    updated = []
    withdrawn = []
    nudges = []
    syncs = 0
    createFails = null
    cancelFails = null
    withdrawFails = null
    forwardStatus = null
    originalFiles = []
    unscannedRefused = false
    bodyFails = null
    const explain = (error: unknown) => ({ message: error instanceof Error ? error.message : String(error), violations: error instanceof ApiFailure ? error.violations : {} })
    const cancel = async (id: string) => {
      if (cancelFails !== null) throw cancelFails
      cancelled.push(id)
      return outgoing(id, 'cancelled')
    }
    composer = new Composer({
      store: () => store,
      drafts: new DraftSync(() => store, drafts),
      accounts: () => accounts,
      signatures: () => [signature('sig-work', 'Work')],
      defaultAccount: () => 'work',
      body: async () => {
        if (bodyFails !== null) throw bodyFails
        return { html: '<p>Charged twice</p>', text: null, attachments: originalFiles }
      },
      send: async (request) => {
        if (unscannedRefused && request.acceptUnscanned !== true) {
          throw new ApiFailure(422, { acceptUnscanned: 'invoice.pdf could not be scanned. Send it anyway?' })
        }
        sent.push(request)
        return outgoing(`forward-${sent.length}`, 'scheduled')
      },
      cancel,
      notify: () => undefined,
      explain,
    })
    flow = new HandOverFlow({
      composer,
      api: {
        create: async (request) => {
          if (createFails !== null) throw createFails
          created.push(request)
          return handOver('h1', request.messageId, 'work', { forwardId: request.forwardId, note: request.note, dueAt: request.dueAt })
        },
        update: async (id, request) => {
          updated.push([id, request])
          return handOver(id, 'm1', 'work', { state: request.done === true ? 'done' : 'open' })
        },
        withdraw: async (id) => {
          if (withdrawFails !== null) throw withdrawFails
          withdrawn.push(id)
        },
        nudge: async (id, request) => {
          nudges.push([id, request])
          return handOver(id, 'm1', 'work', { nudgedAt: new Date().toISOString(), lastNudgeId: 'nudge-1' })
        },
      },
      cancel,
      outgoing: async (id) => (forwardStatus === null ? null : outgoing(id, forwardStatus)),
      accounts: () => accounts,
      signatures: () => [signature('sig-work', 'Work')],
      sync: async () => {
        syncs += 1
      },
      explain,
    })
  })

  afterEach(() => {
    composer.dispose()
    vi.useRealTimers()
  })

  it('forwards the conversation with the note and records the hand-over', async () => {
    const handed = await flow.handOver(original, input)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: [input.delegate], subject: 'Fwd: Invoice question', inReplyToMessageId: 'm1' })
    expect(sent[0]!.html).toContain('<p>Can you check the double charge?</p><p>Could you get back to me by Friday 24 October?</p>')
    expect(sent[0]!.html).toContain('Charged twice')
    expect(created).toEqual([{ messageId: 'm1', delegate: input.delegate, note: 'Can you check the double charge?', dueAt: '2026-10-24T15:00:00.000Z', forwardId: 'forward-1' }])
    expect(handed).toMatchObject({ forwardId: 'forward-1', handOver: { id: 'h1' } })
    expect(handed.until).toBeGreaterThan(Date.now())
    expect(syncs).toBe(1)
    // The forward carries the id of its send, so a request sent again does not forward twice.
    expect(sent[0]!.outgoingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
  })

  it("takes the original's files along", async () => {
    originalFiles = [{ id: 'invoice', filename: 'invoice.pdf', contentType: 'application/pdf', size: 100, inline: false, contentId: null, scanStatus: 'clean', access: 'allowed', scanSignature: null, scanFailure: null, url: null }]

    await flow.handOver(original, input)

    expect(drafts.calls.filter((call) => call.startsWith('forward'))).toHaveLength(1)
    expect(sent[0]!.draftId).toBeDefined()
  })

  it('asks before forwarding files that could not be scanned, and forwards them once confirmed', async () => {
    unscannedRefused = true

    await expect(flow.handOver(original, input)).rejects.toThrow(new UnscannedFilesError('invoice.pdf could not be scanned. Send it anyway?'))
    expect(created).toEqual([])
    expect(await store.drafts()).toEqual([])
    expect(composer.state.unscannedToConfirm).toBeNull()

    await flow.handOver(original, { ...input, acceptUnscanned: true })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.acceptUnscanned).toBe(true)
    expect(created).toHaveLength(1)
  })

  it('stops the forward when the hand-over cannot be recorded', async () => {
    createFails = new Error('The due date must be in the future.')

    await expect(flow.handOver(original, input)).rejects.toThrow(new HandOverError('The due date must be in the future.'))

    expect(cancelled).toEqual(['forward-1'])
    expect(await store.drafts()).toEqual([])
  })

  it('says the forward may still go out when the hand-over could not be recorded nor the forward stopped', async () => {
    createFails = new Error('Network request failed')
    cancelFails = new Error('Network request failed')

    await expect(flow.handOver(original, input)).rejects.toThrow(
      new HandOverError('Network request failed. The forward to Lisa Bakker could not be stopped and may still be sent, but it is not in "Waiting on".'),
    )
  })

  it('hands nothing over when the original could not be loaded', async () => {
    bodyFails = new Error('Service unavailable')

    await expect(flow.handOver(original, input)).rejects.toThrow(new HandOverError('The message could not be forwarded: it could not be loaded (Service unavailable).'))

    expect(sent).toEqual([])
    expect(created).toEqual([])
    expect(await store.drafts()).toEqual([])
  })

  it('takes back one hand-over while another is made, each on its own draft', async () => {
    const first = await flow.handOver(original, input)
    const second = message('m2', 't2', 'work', ['work-inbox'], '2026-10-19T09:00:00+00:00', { subject: 'Contract' })
    const delegate = { address: 'tom@company.example', name: 'Tom' }
    // The second forward takes a file along, which holds it after its draft opened.
    originalFiles = [{ id: 'contract', filename: 'contract.pdf', contentType: 'application/pdf', size: 100, inline: false, contentId: null, scanStatus: 'clean', access: 'allowed', scanSignature: null, scanFailure: null, url: null }]
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    drafts.duringFile = () => held

    const handing = flow.handOver(second, { ...input, delegate })
    await vi.advanceTimersByTimeAsync(10)
    const takingBack = flow.takeBack(first)
    await vi.advanceTimersByTimeAsync(10)
    release()
    const handed = await handing
    expect(await takingBack).toBe('undone')

    expect(sent[1]).toMatchObject({ to: [delegate], subject: 'Fwd: Contract', inReplyToMessageId: 'm2' })
    expect(created[1]).toMatchObject({ messageId: 'm2', forwardId: handed.forwardId })
    expect(withdrawn).toEqual(['h1'])
    expect(await store.draft(first.draftId)).toBeNull()
    expect(await store.draft(handed.draftId)).toMatchObject({ inReplyToMessageId: 'm2', outgoingId: handed.forwardId })
  })

  it('stops a forward at once on undo, also while another hand-over is still being made', async () => {
    const first = await flow.handOver(original, input)
    originalFiles = [{ id: 'contract', filename: 'contract.pdf', contentType: 'application/pdf', size: 100, inline: false, contentId: null, scanStatus: 'clean', access: 'allowed', scanSignature: null, scanFailure: null, url: null }]
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    drafts.duringFile = () => held
    const handing = flow.handOver(message('m2', 't2', 'work', ['work-inbox'], '2026-10-19T09:00:00+00:00'), input)
    await vi.advanceTimersByTimeAsync(10)

    const undoing = flow.undo(first)
    await vi.advanceTimersByTimeAsync(10)

    // The forward is stopped and the hand-over withdrawn before the other hand-over is done.
    expect(cancelled).toEqual(['forward-1'])
    expect(withdrawn).toEqual(['h1'])
    release()
    await handing
    await undoing
    expect(await store.draft(first.draftId)).toBeNull()
  })

  it('does not let a step that hangs hold up the next one for ever', async () => {
    const first = await flow.handOver(original, input)
    originalFiles = [{ id: 'contract', filename: 'contract.pdf', contentType: 'application/pdf', size: 100, inline: false, contentId: null, scanStatus: 'clean', access: 'allowed', scanSignature: null, scanFailure: null, url: null }]
    // This hand-over's file never arrives.
    drafts.duringFile = () => new Promise<void>(() => undefined)
    void flow.handOver(message('m2', 't2', 'work', ['work-inbox'], '2026-10-19T09:00:00+00:00'), input).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10)

    let outcome: string | null = null
    void flow.takeBack(first).then((result) => (outcome = result))
    await vi.advanceTimersByTimeAsync(59_000)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(outcome).toBe('undone')
    expect(await store.draft(first.draftId)).toBeNull()
  })

  it('takes back both the forward and the hand-over', async () => {
    const handed = await flow.handOver(original, input)

    await flow.undo(handed)

    expect(cancelled).toEqual(['forward-1'])
    expect(withdrawn).toEqual(['h1'])
    expect(await store.drafts()).toEqual([])
  })

  it('keeps the hand-over when the forward left already', async () => {
    const handed = await flow.handOver(original, input)
    cancelFails = new Error('This message is sent and can no longer be cancelled.')

    await expect(flow.undo(handed)).rejects.toThrow('Too late to undo: This message is sent and can no longer be cancelled.')

    expect(withdrawn).toEqual([])
  })

  it('takes back the forward and the hand-over while the forward has not left', async () => {
    const handed = await flow.handOver(original, input)

    expect(await flow.takeBack(handed)).toBe('undone')

    expect(cancelled).toEqual(['forward-1'])
    expect(withdrawn).toEqual(['h1'])
  })

  it('withdraws only the hand-over once the forward surely left', async () => {
    const handed = await flow.handOver(original, input)
    cancelFails = new Error('This message is sent and can no longer be cancelled.')
    forwardStatus = 'sent'

    expect(await flow.takeBack(handed)).toBe('withdrawn')

    expect(withdrawn).toEqual(['h1'])
  })

  it('keeps the hand-over when the cancel failed and the forward may still go out', async () => {
    const handed = await flow.handOver(original, input)
    cancelFails = new Error('You are offline.')
    forwardStatus = 'scheduled'

    await expect(flow.takeBack(handed)).rejects.toThrow('The hand-over could not be taken back, so it still stands: You are offline.')

    expect(withdrawn).toEqual([])
  })

  it('withdraws the hand-over before throwing the draft away, so an undo that stopped halfway can be tried again', async () => {
    const handed = await flow.handOver(original, input)
    withdrawFails = new Error('Try again later.')

    await expect(flow.takeBack(handed)).rejects.toThrow('Try again later.')
    expect(await store.drafts()).toHaveLength(1)

    // The forward is cancelled now: the second try finds it so and finishes.
    withdrawFails = null
    cancelFails = new Error('This message was cancelled already.')
    forwardStatus = 'cancelled'
    expect(await flow.takeBack(handed)).toBe('undone')
    expect(withdrawn).toEqual(['h1'])
    expect(await store.drafts()).toEqual([])
  })

  it('takes everything back when the cancel went through and only its answer was lost', async () => {
    const handed = await flow.handOver(original, input)
    cancelFails = new Error('The connection was lost.')
    forwardStatus = 'cancelled'

    expect(await flow.takeBack(handed)).toBe('undone')

    expect(withdrawn).toEqual(['h1'])
  })

  it('nudges with the signature and an undo window', async () => {
    const open: SyncedHandOver = handOver('h1', 'm1', 'work')

    const nudged = await flow.nudge(open, 'Hi Lisa,\n\nAny news?')

    expect(nudges).toEqual([['h1', { html: '<p>Hi Lisa,</p><p>Any news?</p><div class="tresso-signature"><p>Work</p></div>', sendAt: '2026-10-20T09:00:05.000Z' }]])
    expect(nudged).toMatchObject({ nudgeId: 'nudge-1', until: Date.parse('2026-10-20T09:00:05Z') })

    await flow.undoNudge(nudged)
    expect(cancelled).toEqual(['nudge-1'])
  })

  it('marks done, reopens and moves the due date, syncing after each', async () => {
    const open = handOver('h1', 'm1', 'work')

    await flow.markDone(open)
    await flow.reopen(open)
    await flow.reschedule(open, new Date('2026-10-28T16:00:00Z'))
    await flow.withdraw(open)

    expect(updated).toEqual([
      ['h1', { done: true }],
      ['h1', { done: false }],
      ['h1', { dueAt: '2026-10-28T16:00:00.000Z' }],
    ])
    expect(withdrawn).toEqual(['h1'])
    expect(syncs).toBe(4)
  })
})
