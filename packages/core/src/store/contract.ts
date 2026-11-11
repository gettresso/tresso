import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MissingFolderError } from '../actions'
import { briefView } from '../brief'
import type { SyncedCalendar, SyncedCalendarEvent } from '../calendar/types'
import type { ChangePage, SyncedDailyBrief, SyncedHandOver, SyncedMessage, SyncedOutgoingMessage, SyncedSmartInbox, SyncedThread, SyncedTodo, SyncedUnsubscription } from '../sync/types'
import type { Draft, MailStore } from './mailStore'

/** Test data for the mail stores. */
export function page(changes: Partial<ChangePage> & { cursor: number }): ChangePage {
  return { hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], dailyBriefs: [], deleted: [], ...changes }
}

export const accounts = [
  { id: 'work', emailAddress: 'kim@company.example', displayName: 'Work', provider: 'imap', status: 'active' as const, statusDetail: null, lastSyncedAt: null, defaultSignatureId: 'sig-work', calendarStatus: 'unknown' as const, calendarStatusDetail: null },
  { id: 'home', emailAddress: 'kim@mail.example', displayName: 'Personal', provider: 'imap', status: 'active' as const, statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null },
]

export const folders = [
  { id: 'work-inbox', mailAccountId: 'work', name: 'INBOX', displayName: 'Inbox', role: 'inbox' as const },
  { id: 'work-archive', mailAccountId: 'work', name: 'Archive', displayName: 'Archive', role: 'archive' as const },
  { id: 'home-inbox', mailAccountId: 'home', name: 'INBOX', displayName: 'Inbox', role: 'inbox' as const },
]

export function signature(id: string, name: string) {
  return { id, name, html: `<p>${name}</p>`, updatedAt: '2026-10-19T08:00:00+00:00' }
}

export function thread(id: string, mailAccountId: string, classification: Partial<Pick<SyncedThread, 'smartInboxId' | 'verdict' | 'classificationReason' | 'heldUntil' | 'batchedAt'>> = {}): SyncedThread {
  return { id, mailAccountId, subject: `Subject ${id}`, messageCount: 1, lastMessageAt: '2026-10-19T08:00:00+00:00', smartInboxId: null, verdict: null, classificationReason: null, ...classification }
}

export function dailyBrief(id: string, coversUntil: string, threadIds: string[]): SyncedDailyBrief {
  return { id, coversFrom: new Date(Date.parse(coversUntil) - 86_400_000).toISOString(), coversUntil, threadIds, createdAt: coversUntil }
}

export function smartInbox(id: string, builtin: SyncedSmartInbox['builtin'], position: number, verdict: SyncedSmartInbox['verdict'] = 'know'): SyncedSmartInbox {
  return { id, builtin, name: id, instructions: '', includeSenders: [], excludeSenders: [], verdict, autoCreateTodo: false, position }
}

export function todo(id: string, extra: Partial<SyncedTodo> = {}): SyncedTodo {
  return {
    id,
    title: `Todo ${id}`,
    notes: '',
    dueDate: null,
    dueTime: null,
    durationMinutes: null,
    completedAt: null,
    position: 0,
    source: 'manual',
    messageId: null,
    threadId: null,
    plannedStart: null,
    plannedEnd: null,
    planState: null,
    createdAt: '2026-10-19T08:00:00+00:00',
    updatedAt: '2026-10-19T08:00:00+00:00',
    ...extra,
  }
}

export function calendar(id: string, mailAccountId: string | null, extra: Partial<SyncedCalendar> = {}): SyncedCalendar {
  return { id, mailAccountId, source: mailAccountId === null ? 'local' : 'caldav', name: id, color: '#6E56CF', timeZone: 'Europe/Amsterdam', writable: true, isDefault: false, visible: true, work: false, providerSchedules: false, conferenceProviders: [], position: 0, ...extra }
}

/** A single timed event of an hour in Amsterdam, unless `extra` says otherwise. */
export function calendarEvent(id: string, calendarId: string, extra: Partial<SyncedCalendarEvent> = {}): SyncedCalendarEvent {
  return {
    id,
    calendarId,
    uid: `${id}@tresso.test`,
    recurrenceId: null,
    sequence: 0,
    status: 'confirmed',
    summary: `Event ${id}`,
    description: '',
    location: '',
    url: null,
    transparency: 'busy',
    visibility: 'public',
    allDay: false,
    start: { dateTime: '2026-10-20T10:00:00', timeZone: 'Europe/Amsterdam' },
    end: { dateTime: '2026-10-20T11:00:00', timeZone: 'Europe/Amsterdam' },
    recurrence: null,
    rdates: [],
    exdates: [],
    organizer: null,
    attendees: [],
    selfResponse: null,
    reminders: [],
    conference: null,
    messageId: null,
    syncError: null,
    travelMinutes: null,
    defaultReminders: true,
    important: false,
    thisAndFuture: false,
    ...extra,
  }
}

export function message(id: string, threadId: string, mailAccountId: string, folderIds: string[], receivedAt: string, extra: Partial<SyncedMessage> = {}): SyncedMessage {
  return {
    id,
    mailAccountId,
    threadId,
    folderIds,
    subject: `Subject ${threadId}`,
    from: { address: `${id}@sender.example`, name: `Sender ${id}` },
    recipients: { to: [], cc: [], bcc: [], replyTo: [] },
    snippet: `Snippet ${id}`,
    sentAt: null,
    receivedAt,
    flags: { seen: false, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    attachmentScan: null,
    smartInboxId: null,
    verdict: null,
    summary: null,
    calendarMethod: null,
    ...extra,
  }
}

export function unsubscription(id: string, mailAccountId: string, sender: string, extra: Partial<SyncedUnsubscription> = {}): SyncedUnsubscription {
  return { id, mailAccountId, sender, method: 'oneClick', status: 'pending', error: null, requestedAt: '2026-10-19T12:00:00+00:00', completedAt: null, ...extra }
}

export function handOver(id: string, messageId: string | null, mailAccountId: string, extra: Partial<SyncedHandOver> = {}): SyncedHandOver {
  return {
    id,
    mailAccountId,
    messageId,
    threadId: null,
    subject: `Subject of ${messageId ?? 'a gone message'}`,
    delegate: { address: 'lisa@company.example', name: 'Lisa Bakker' },
    note: 'Can you take this?',
    dueAt: '2026-10-24T15:00:00+00:00',
    state: 'open',
    forwardId: `forward-${id}`,
    overdueAt: null,
    notifiedAt: null,
    notifiedChannels: [],
    notifiedSilently: false,
    nudgedAt: null,
    lastNudgeId: null,
    replyMessageId: null,
    createdAt: '2026-10-20T08:00:00+00:00',
    closedAt: null,
    updatedAt: '2026-10-20T08:00:00+00:00',
    ...extra,
  }
}

export function draft(id: string, extra: Partial<Draft> = {}): Draft {
  return {
    id,
    mailAccountId: 'work',
    to: [],
    cc: [],
    bcc: [],
    subject: 'Hi',
    html: '<p>Hi</p>',
    signatureId: null,
    quoteHtml: '',
    inReplyToMessageId: null,
    kind: 'new',
    version: 0,
    pendingSave: false,
    remoteVersion: null,
    outgoingId: null,
    noticedStatus: null,
    updatedAt: 1,
    attachments: [],
    ...extra,
  }
}

/** The first page of every test: two accounts, an archived thread, read and unread mail. */
export const firstPage = page({
  cursor: 10,
  mailAccounts: accounts,
  signatures: [signature('sig-work', 'Work'), signature('sig-short', 'Short reply')],
  folders,
  threads: [thread('t1', 'work'), thread('t2', 'work'), thread('t3', 'home')],
  messages: [
    message('m1', 't1', 'work', ['work-inbox'], '2026-10-19T08:00:00+00:00', { flags: { seen: true, flagged: false, answered: false, draft: false } }),
    message('m2', 't1', 'work', ['work-inbox'], '2026-10-19T09:00:00+02:00'),
    message('m3', 't2', 'work', ['work-archive'], '2026-10-19T10:00:00+00:00'),
    message('m4', 't3', 'home', ['home-inbox'], '2026-10-19T06:00:00+00:00', { flags: { seen: true, flagged: true, answered: false, draft: false } }),
  ],
})

/**
 * What every mail store must do, whatever holds the mail: the browser's IndexedDB store and the SQLite store run the
 * same tests. `open` gives an empty store; `remove` closes and deletes it.
 */
export function describeMailStore(name: string, open: () => Promise<MailStore>, remove: (store: MailStore) => Promise<void>): void {
  describe(`${name}: the mail store`, () => {
    let db: MailStore

    beforeEach(async () => {
      db = await open()
      await db.apply(firstPage)
    })

    afterEach(async () => {
      await remove(db)
    })

    it('stores the cursor with the page', async () => {
      expect(await db.cursor()).toBe(10)
    })

    it('lists inbox threads of all accounts, newest first, without archived ones', async () => {
      const inbox = await db.inbox(null, 50)

      expect(inbox.map((c) => c.threadId)).toEqual(['t1', 't3'])
      expect(inbox[0]).toMatchObject({ messageCount: 2, unreadCount: 1, snippet: 'Snippet m1', inbox: true })
      expect(inbox[0]!.senders.map((s) => s.address)).toEqual(['m1@sender.example', 'm2@sender.example'])
      expect(inbox[1]).toMatchObject({ flagged: true, unreadCount: 0, inbox: true })
    })

    it('marks a thread once an attachment of it is blocked', async () => {
      expect((await db.inbox(null, 50)).map((c) => c.attachmentsBlocked)).toEqual([false, false])

      await db.apply(
        page({ cursor: 11, messages: [message('m2', 't1', 'work', ['work-inbox'], '2026-10-19T09:00:00+02:00', { hasAttachments: true, attachmentScan: 'infected' })] }),
      )

      expect((await db.inbox(null, 50)).find((c) => c.threadId === 't1')).toMatchObject({ hasAttachments: true, attachmentsBlocked: true })
    })

    it('lists one account and honors the limit', async () => {
      expect((await db.inbox('home', 50)).map((c) => c.threadId)).toEqual(['t3'])
      expect(await db.inbox(null, 1)).toHaveLength(1)
    })

    it('counts unread inbox threads per account, listing accounts without any', async () => {
      expect(Object.fromEntries(await db.unreadInboxCounts())).toEqual({ work: 1, home: 0 })
    })

    it('moves a thread out of the inbox when its messages are archived', async () => {
      await db.apply(
        page({
          cursor: 11,
          messages: [message('m1', 't1', 'work', ['work-archive'], '2026-10-19T08:00:00+00:00'), message('m2', 't1', 'work', ['work-archive'], '2026-10-19T09:00:00+02:00')],
        }),
      )

      expect((await db.inbox(null, 50)).map((c) => c.threadId)).toEqual(['t3'])
    })

    it('updates both threads when a message moves to another thread', async () => {
      await db.apply(page({ cursor: 11, messages: [message('m2', 't3', 'work', ['work-inbox'], '2026-10-19T09:00:00+02:00')] }))

      const inbox = await db.inbox(null, 50)
      expect(inbox.find((c) => c.threadId === 't1')).toMatchObject({ messageCount: 1, unreadCount: 0 })
      expect(inbox.find((c) => c.threadId === 't3')).toMatchObject({ messageCount: 2 })
    })

    it('drops deleted messages and threads', async () => {
      await db.apply(page({ cursor: 11, deleted: [{ type: 'message', id: 'm2' }] }))
      expect((await db.inbox(null, 50)).find((c) => c.threadId === 't1')).toMatchObject({ messageCount: 1 })

      await db.apply(page({ cursor: 12, deleted: [{ type: 'message', id: 'm1' }, { type: 'thread', id: 't1' }] }))
      expect((await db.inbox(null, 50)).map((c) => c.threadId)).toEqual(['t3'])
      expect(await db.thread('t1')).toBeNull()
    })

    it('removes everything of a deleted account, but keeps its drafts without an account', async () => {
      await db.saveDraft(draft('d1', { mailAccountId: 'work', pendingSave: true }))

      await db.apply(page({ cursor: 11, deleted: [{ type: 'mailAccount', id: 'work' }] }))

      expect((await db.mailAccounts()).map((a) => a.id)).toEqual(['home'])
      expect((await db.inbox(null, 50)).map((c) => c.threadId)).toEqual(['t3'])
      expect(await db.thread('t1')).toBeNull()
      expect(await db.messagesByThread(['t1'])).toEqual(new Map([['t1', []]]))
      expect(await db.draft('d1')).toMatchObject({ mailAccountId: null, pendingSave: true })
    })

    it('drops a deleted folder from the lists', async () => {
      await db.apply(page({ cursor: 11, deleted: [{ type: 'folder', id: 'home-inbox' }] }))

      expect((await db.folders()).map((f) => f.id).sort()).toEqual(['work-archive', 'work-inbox'])
      expect((await db.inbox(null, 50)).map((c) => c.threadId)).toEqual(['t1'])
    })

    it('reacts to a folder becoming the inbox', async () => {
      await db.apply(page({ cursor: 11, folders: [{ ...folders[1]!, role: 'inbox' }] }))

      expect((await db.inbox('work', 50)).map((c) => c.threadId)).toEqual(['t2', 't1'])
    })

    it('returns a thread with its messages oldest first, comparing instants rather than local times', async () => {
      const result = await db.thread('t1')

      expect(result?.messages.map((m) => m.id)).toEqual(['m2', 'm1'])
    })

    it('finds inbox threads beyond the loaded list, and what a selection holds', async () => {
      expect(await db.listThreadIds({ kind: 'inbox', mailAccountId: null }, () => true)).toEqual(['t1', 't3'])
      expect(await db.listThreadIds({ kind: 'inbox', mailAccountId: 'work' }, (c) => c.unreadCount > 0)).toEqual(['t1'])
      expect(await db.listThreadIds({ kind: 'inbox', mailAccountId: null }, () => true, 1)).toEqual(['t1'])
      expect((await db.summaries(['t3', 'gone', 't2'])).map((c) => [c.threadId, c.inbox]).sort()).toEqual([
        ['t2', false],
        ['t3', true],
      ])

      expect(await db.describeThreads({ kind: 'inbox', mailAccountId: null }, ['t1', 't2', 't3', 'gone'])).toEqual({
        present: ['t1', 't3'],
        accounts: ['work', 'home'],
        senders: ['m1@sender.example', 'm2@sender.example', 'm4@sender.example'],
      })
      expect((await db.describeThreads({ kind: 'inbox', mailAccountId: 'home' }, ['t1', 't3'])).present).toEqual(['t3'])
    })

    it('lists the messages of threads', async () => {
      expect(await db.messagesByThread(['t1', 't3', 'gone'])).toEqual(
        new Map([
          ['t1', ['m1', 'm2']],
          ['t3', ['m4']],
          ['gone', []],
        ]),
      )
      expect(await db.messageIdsOfThreads(['t1', 't2'])).toEqual(['m1', 'm2', 'm3'])
    })

    it('breaks ties the same way: the larger id first', async () => {
      const at = '2026-10-19T12:00:00+00:00'
      await db.apply(
        page({
          cursor: 11,
          threads: [thread('ta', 'work'), thread('tb', 'work')],
          messages: [message('ma', 'ta', 'work', ['work-inbox'], at), message('mb', 'tb', 'work', ['work-inbox'], at)],
        }),
      )
      await db.saveDraft(draft('da', { updatedAt: 5 }))
      await db.saveDraft(draft('db', { updatedAt: 5 }))

      expect((await db.inbox(null, 2)).map((c) => c.threadId)).toEqual(['tb', 'ta'])
      expect((await db.listThreadIds({ kind: 'inbox', mailAccountId: 'work' }, () => true)).slice(0, 2)).toEqual(['tb', 'ta'])
      expect((await db.drafts()).map((d) => d.id)).toEqual(['db', 'da'])
      expect((await db.suggestContacts('m', 2)).map((c) => c.key)).toEqual(['mb@sender.example', 'ma@sender.example'])
    })

    it('lists the messages of a thread asked for twice once', async () => {
      expect(await db.messageIdsOfThreads(['t1', 't1'])).toEqual(['m1', 'm2'])
    })

    it('keeps outgoing mail that is not settled, newest first', async () => {
      const outgoing = (id: string, status: SyncedOutgoingMessage['status'], sendAt: string): SyncedOutgoingMessage => ({
        id,
        mailAccountId: 'work',
        status,
        subject: id,
        recipients: { to: [{ address: 'anna@finance.example', name: null }], cc: [], bcc: [] },
        sendAt,
        sentAt: null,
        lastError: null,
        inReplyToMessageId: null,
      })
      await db.apply(page({ cursor: 11, outgoingMessages: [outgoing('o1', 'scheduled', '2026-10-20T08:00:00Z'), outgoing('o2', 'sent', '2026-10-19T08:00:00Z'), outgoing('o3', 'failed', '2026-10-21T08:00:00Z')] }))

      expect((await db.outbox()).map((o) => o.id)).toEqual(['o3', 'o1'])
      expect((await db.outgoing('o2'))?.status).toBe('sent')

      await db.apply(page({ cursor: 12, deleted: [{ type: 'outgoingMessage', id: 'o3' }] }))
      expect((await db.outbox()).map((o) => o.id)).toEqual(['o1'])
      expect(await db.outgoing('o3')).toBeNull()

      await db.apply(page({ cursor: 13, deleted: [{ type: 'mailAccount', id: 'work' }] }))
      expect(await db.outbox()).toEqual([])
    })

    it('suggests the people the user exchanged mail with, most recent first', async () => {
      const contacts = await db.suggestContacts('sender', 10)
      expect(contacts.map((c) => c.address)).toEqual(['m3@sender.example', 'm1@sender.example', 'm2@sender.example', 'm4@sender.example'])

      expect((await db.suggestContacts('m4', 10)).map((c) => c.address)).toEqual(['m4@sender.example'])
      expect((await db.suggestContacts('Sender m1', 10)).length).toBe(0)
      expect((await db.suggestContacts('', 2)).length).toBe(2)
      expect(await db.suggestContacts('', 0)).toEqual([])
    })

    it('counts every message with a contact once and keeps the newest name', async () => {
      await db.apply(
        page({
          cursor: 11,
          messages: [
            message('m5', 't1', 'work', ['work-inbox'], '2026-10-19T12:00:00+00:00', { from: { address: 'M1@Sender.example', name: 'Newer name' } }),
            message('m6', 't1', 'work', ['work-inbox'], '2026-10-18T12:00:00+00:00', { from: { address: 'm1@sender.example', name: 'Older name' } }),
          ],
        }),
      )
      // A message the delta brings again is not counted twice.
      await db.apply(page({ cursor: 12, messages: [message('m5', 't1', 'work', ['work-archive'], '2026-10-19T12:00:00+00:00', { from: { address: 'M1@Sender.example', name: 'Newer name' } })] }))

      expect(await db.suggestContacts('m1@', 10)).toEqual([{ key: 'm1@sender.example', address: 'M1@Sender.example', name: 'Newer name', lastSeen: Date.parse('2026-10-19T12:00:00+00:00'), messages: 3 }])
    })

    it('keeps drafts on this device, most recently changed first', async () => {
      await db.saveDraft(draft('d1', { updatedAt: 1 }))
      await db.saveDraft(draft('d2', { updatedAt: 2 }))

      expect((await db.drafts()).map((d) => d.id)).toEqual(['d2', 'd1'])
      await db.deleteDraft('d2')
      expect(await db.draft('d2')).toBeNull()
      expect(await db.draft('d1')).toEqual(draft('d1', { updatedAt: 1 }))
    })

    it('changes a draft as one step, or leaves it as it is', async () => {
      await db.saveDraft(draft('d1', { subject: 'First' }))

      expect(await db.changeDraft('d1', (stored) => stored && { ...stored, subject: `${stored.subject}, changed` })).toMatchObject({ subject: 'First, changed' })
      expect(await db.draft('d1')).toMatchObject({ subject: 'First, changed' })
      expect(await db.changeDraft('d1', () => null)).toMatchObject({ subject: 'First, changed' })
      expect(await db.changeDraft('gone', (stored) => stored)).toBeNull()
      expect(await db.draft('gone')).toBeNull()

      // Changes made at the same time each see the one before.
      await Promise.all([1, 2, 3].map((n) => db.changeDraft('d1', (stored) => stored && { ...stored, subject: `${stored.subject} ${n}` })))
      expect((await db.draft('d1'))!.subject).toBe('First, changed 1 2 3')
    })

    it('keeps a sent draft until its outcome is known, and leaves unsaved edits alone', async () => {
      const synced = { id: 'd1', mailAccountId: 'work', kind: 'new' as const, to: [], cc: [], bcc: [], subject: 'Server', html: '', signatureId: null, quoteHtml: '', inReplyToMessageId: null, version: 3, updatedAt: '2026-10-19T08:00:00Z', attachments: [] }
      await db.apply(page({ cursor: 11, drafts: [synced] }))
      expect(await db.draft('d1')).toMatchObject({ subject: 'Server', version: 3, pendingSave: false, updatedAt: Date.parse('2026-10-19T08:00:00Z') })

      await db.saveDraft({ ...(await db.draft('d1'))!, subject: 'Local edit', pendingSave: true })
      await db.apply(page({ cursor: 12, drafts: [{ ...synced, subject: 'Newer elsewhere', version: 4 }] }))
      expect(await db.draft('d1')).toMatchObject({ subject: 'Local edit', remoteVersion: 4 })

      await db.apply(page({ cursor: 13, deleted: [{ type: 'draft', id: 'd1' }] }))
      // The server's copy and the newer version noted on the edits are gone: the edits become a new draft.
      expect(await db.draft('d1')).toMatchObject({ subject: 'Local edit', pendingSave: true, version: 0, remoteVersion: null })
      await db.saveDraft({ ...(await db.draft('d1'))!, version: 3 })

      await db.saveDraft({ ...(await db.draft('d1'))!, pendingSave: false, outgoingId: 'o1' })
      await db.apply(page({ cursor: 14, deleted: [{ type: 'draft', id: 'd1' }] }))
      // The server keeps a draft being sent, version and all, so an undo can go on writing it.
      expect(await db.draft('d1')).toMatchObject({ outgoingId: 'o1', version: 3, pendingSave: false })

      await db.saveDraft({ ...(await db.draft('d1'))!, outgoingId: null })
      await db.apply(page({ cursor: 15, deleted: [{ type: 'draft', id: 'd1' }] }))
      expect(await db.draft('d1')).toBeNull()
    })

    it("takes the server's files for a draft, also while its text has edits not uploaded yet", async () => {
      const file = { id: 'f1', filename: 'notes.txt', contentType: 'text/plain', size: 10, scanStatus: 'pending' as const }
      const synced = { id: 'd1', mailAccountId: 'work', kind: 'new' as const, to: [], cc: [], bcc: [], subject: 'Server', html: '', signatureId: null, quoteHtml: '', inReplyToMessageId: null, version: 2, updatedAt: '2026-10-19T08:00:00Z', attachments: [file] }
      await db.saveDraft(draft('d1', { subject: 'Typed here', version: 2, pendingSave: true }))

      await db.apply(page({ cursor: 11, drafts: [synced] }))

      expect(await db.draft('d1')).toMatchObject({ subject: 'Typed here', pendingSave: true, remoteVersion: null, attachments: [file] })
    })

    it('reads drafts stored before they had files as having none', async () => {
      const { attachments: _, ...old } = draft('d1')
      await db.saveDraft(old as Draft)

      expect((await db.draft('d1'))?.attachments).toEqual([])
      expect((await db.drafts())[0]?.attachments).toEqual([])
    })

    it('shows actions at once and takes archived mail out of the inbox list', async () => {
      const applied = await db.applyAction(['m1', 'm2'], 'archive')

      expect(applied.after.map((m) => m.folderIds)).toEqual([['work-archive'], ['work-archive']])
      expect((await db.inbox('work', 10)).map((c) => c.threadId)).toEqual([])
      await db.applyAction(['m1', 'm2'], 'flag')
      expect((await db.thread('t1'))?.messages.map((m) => m.flags.flagged)).toEqual([true, true])
    })

    it('archives into All Mail where there is no Archive folder, and says when there is neither', async () => {
      await db.apply(page({ cursor: 11, folders: [{ id: 'home-all', mailAccountId: 'home', name: '[Gmail]/All Mail', displayName: 'All Mail', role: 'all' }] }))
      expect((await db.applyAction(['m4'], 'archive')).after[0]?.folderIds).toEqual(['home-all'])

      await expect(db.applyAction(['m4'], 'trash')).rejects.toEqual(new MissingFolderError('kim@mail.example', 'Trash'))
      expect((await db.thread('t3'))?.messages[0]?.folderIds).toEqual(['home-all'])
    })

    it('undoes an action the server refused, except where the server has spoken since', async () => {
      const applied = await db.applyAction(['m2', 'm3'], 'move', 'work-archive')
      // The delta brought a newer version of m3 in the meantime.
      await db.apply(page({ cursor: 11, messages: [message('m3', 't2', 'work', ['work-inbox'], '2026-10-19T10:00:00+00:00', { flags: { seen: true, flagged: false, answered: false, draft: false } })] }))

      await db.revertAction(applied)

      expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm2')?.folderIds).toEqual(['work-inbox'])
      expect((await db.thread('t2'))?.messages[0]).toMatchObject({ folderIds: ['work-inbox'], flags: { seen: true } })
      expect((await db.inbox('work', 10)).map((c) => c.threadId).sort()).toEqual(['t1', 't2'])
    })

    it('lists signatures by name and keeps them current', async () => {
      expect((await db.signatures()).map((s) => s.name)).toEqual(['Short reply', 'Work'])

      await db.apply(page({ cursor: 11, signatures: [{ ...signature('sig-work', 'Work'), html: '<p>Kim Visser</p>' }] }))
      expect((await db.signatures()).find((s) => s.id === 'sig-work')?.html).toBe('<p>Kim Visser</p>')

      await db.apply(page({ cursor: 12, deleted: [{ type: 'signature', id: 'sig-work' }], mailAccounts: [{ ...accounts[0]!, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null }] }))
      expect((await db.signatures()).map((s) => s.id)).toEqual(['sig-short'])
      expect((await db.mailAccounts()).find((a) => a.id === 'work')?.defaultSignatureId).toBeNull()
      expect(await db.cursor()).toBe(12)
    })

    describe('todos', () => {
      it('lists open todos in order, then done ones, most recently done first', async () => {
        await db.apply(
          page({
            cursor: 30,
            todos: [
              todo('done-early', { completedAt: '2026-10-18T08:00:00+00:00' }),
              todo('second', { position: 2 }),
              todo('done-late', { completedAt: '2026-10-19T08:00:00+00:00' }),
              todo('first', { position: 1, dueDate: '2026-10-24', dueTime: '17:00', durationMinutes: 30 }),
            ],
          }),
        )

        expect((await db.todos()).map((t) => t.id)).toEqual(['first', 'second', 'done-late', 'done-early'])
        expect(await db.todo('first')).toEqual(todo('first', { position: 1, dueDate: '2026-10-24', dueTime: '17:00', durationMinutes: 30 }))
        expect(await db.todo('gone')).toBeNull()
        expect(await db.cursor()).toBe(30)
      })

      it('keeps the time a todo is planned at, and its conflict', async () => {
        await db.apply(page({ cursor: 30, todos: [todo('a', { dueDate: '2026-10-24', durationMinutes: 60, plannedStart: '2026-10-21T08:00:00+00:00', plannedEnd: '2026-10-21T09:00:00+00:00', planState: 'planned' })] }))
        await db.apply(page({ cursor: 31, todos: [todo('a', { dueDate: '2026-10-24', durationMinutes: 60, plannedStart: '2026-10-21T08:00:00+00:00', plannedEnd: '2026-10-21T09:00:00+00:00', planState: 'conflict' })] }))

        expect((await db.todo('a'))?.planState).toBe('conflict')
        expect((await db.todos()).map((t) => [t.plannedStart, t.plannedEnd])).toEqual([['2026-10-21T08:00:00+00:00', '2026-10-21T09:00:00+00:00']])
      })

      it('keeps todos current and drops deleted ones', async () => {
        await db.apply(page({ cursor: 30, todos: [todo('a'), todo('b', { position: 1 })] }))

        await db.apply(page({ cursor: 31, todos: [todo('a', { title: 'Call Anna', completedAt: '2026-10-20T08:00:00+00:00' })], deleted: [{ type: 'todo', id: 'b' }] }))

        expect((await db.todos()).map((t) => [t.id, t.title, t.completedAt])).toEqual([['a', 'Call Anna', '2026-10-20T08:00:00+00:00']])
      })

      it('finds the todos of a thread, following a message that moved to another thread', async () => {
        await db.apply(
          page({
            cursor: 30,
            todos: [
              todo('from-m1', { messageId: 'm1', threadId: 't1' }),
              todo('from-m3', { messageId: 'm3', threadId: 't1', position: 1 }),
              todo('elsewhere', { messageId: 'm4', threadId: 't3' }),
              todo('email-gone', { messageId: 'm9', threadId: 't1', position: 2 }),
              todo('own'),
            ],
          }),
        )

        // m3 is in t2 on this device, so its todo goes with t2.
        expect((await db.todosOfThread('t1')).map((t) => t.id)).toEqual(['from-m1', 'email-gone'])
        expect((await db.todosOfThread('t2')).map((t) => t.id)).toEqual(['from-m3'])
        expect(await db.todosOfThread('t9')).toEqual([])
      })

      it('keeps todos when the account of their email goes', async () => {
        await db.apply(page({ cursor: 30, todos: [todo('from-m4', { messageId: 'm4', threadId: 't3' })] }))

        await db.apply(page({ cursor: 31, deleted: [{ type: 'mailAccount', id: 'home' }] }))

        expect((await db.todos()).map((t) => t.id)).toEqual(['from-m4'])
        expect(await db.messages(['m4'])).toEqual([])
      })
    })

    it('finds messages by id in the order asked for, leaving out the ones it does not have', async () => {
      expect((await db.messages(['m3', 'gone', 'm1', 'm3'])).map((m) => m.id)).toEqual(['m3', 'm1', 'm3'])
    })

    describe('daily briefs', () => {
      it('keeps them newest first and drops deleted ones', async () => {
        await db.apply(page({ cursor: 11, dailyBriefs: [dailyBrief('b1', '2026-10-18T08:00:00+00:00', ['t3']), dailyBrief('b2', '2026-10-19T08:00:00+02:00', ['t1'])] }))
        expect((await db.dailyBriefs()).map((brief) => brief.id)).toEqual(['b2', 'b1'])

        await db.apply(page({ cursor: 12, deleted: [{ type: 'dailyBrief', id: 'b2' }] }))
        expect(await db.dailyBriefs()).toEqual([dailyBrief('b1', '2026-10-18T08:00:00+00:00', ['t3'])])
      })

      it('reads a page without briefs from a server made before them', async () => {
        const { dailyBriefs: _absent, ...older } = page({ cursor: 11 })
        await db.apply(older)
        expect(await db.dailyBriefs()).toEqual([])
      })

      it('gives the conversations of a brief in its order, each once, without the ones that are gone', async () => {
        const conversations = await db.conversations(['t3', 'gone', 't1', 't3'])
        expect(conversations.map((conversation) => conversation.threadId)).toEqual(['t3', 't1'])
      })

      it('counts a conversation of the brief as noted once it left the inbox', async () => {
        const brief = dailyBrief('b1', '2026-10-19T08:00:00+00:00', ['t1', 't3'])
        await db.apply(page({ cursor: 11, dailyBriefs: [brief] }))
        await db.applyAction(['m1', 'm2'], 'markRead')
        await db.applyAction(['m1', 'm2'], 'archive')

        const view = briefView(brief, await db.conversations(brief.threadIds))

        expect(view.entries.map((entry) => [entry.conversation.threadId, entry.noted])).toEqual([
          ['t1', true],
          ['t3', false],
        ])
      })

      it('keeps a brief whose conversations went with their account, showing none of them', async () => {
        await db.apply(page({ cursor: 11, dailyBriefs: [dailyBrief('b1', '2026-10-19T08:00:00+00:00', ['t1'])] }))
        await db.apply(page({ cursor: 12, deleted: [{ type: 'mailAccount', id: 'work' }] }))
        expect((await db.conversations(['t1'])).length).toBe(0)
        expect((await db.dailyBriefs()).map((brief) => brief.id)).toEqual(['b1'])
      })
    })

    it('lists accounts by name', async () => {
      expect((await db.mailAccounts()).map((a) => a.displayName)).toEqual(['Personal', 'Work'])
    })

    describe('smart inboxes', () => {
      beforeEach(async () => {
        await db.apply(
          page({
            cursor: 20,
            folders: [{ id: 'work-junk', mailAccountId: 'work', name: 'Junk', displayName: 'Junk', role: 'spam' }],
            smartInboxes: [smartInbox('spam', 'spam', 4, 'none'), smartInbox('todo', 'todo', 0, 'do'), smartInbox('news', 'advertise', 3)],
            threads: [
              thread('t1', 'work', { smartInboxId: 'todo', verdict: 'do', classificationReason: 'direct' }),
              thread('t2', 'work', { smartInboxId: 'news', verdict: 'know', classificationReason: 'bulk' }),
              thread('t3', 'home', { smartInboxId: 'spam', verdict: 'none', classificationReason: 'server_spam' }),
              thread('t5', 'work', { smartInboxId: 'spam', verdict: 'none', classificationReason: 'server_spam' }),
              thread('t6', 'work', { smartInboxId: 'news', verdict: 'know', classificationReason: 'bulk' }),
            ],
            messages: [
              message('m5', 't5', 'work', ['work-junk'], '2026-10-19T11:00:00+00:00'),
              message('m6', 't6', 'work', ['work-inbox'], '2026-10-19T12:00:00+00:00', { flags: { seen: true, flagged: false, answered: false, draft: false } }),
            ],
          }),
        )
      })

      it('keeps them in sidebar order and drops deleted ones', async () => {
        expect((await db.smartInboxes()).map((s) => s.id)).toEqual(['todo', 'news', 'spam'])

        await db.apply(page({ cursor: 21, deleted: [{ type: 'smartInbox', id: 'news' }] }))
        expect((await db.smartInboxes()).map((s) => s.id)).toEqual(['todo', 'spam'])
      })

      it('lists a smart inbox across accounts, newest first, without archived conversations', async () => {
        expect((await db.list({ kind: 'smartInbox', smartInboxId: 'news' }, 10)).map((c) => c.threadId)).toEqual(['t6'])
        expect((await db.list({ kind: 'smartInbox', smartInboxId: 'spam' }, 1)).map((c) => c.threadId)).toEqual(['t5'])
      })

      it('shows spam from inboxes and junk folders in the Spam smart inbox only', async () => {
        expect((await db.list({ kind: 'smartInbox', smartInboxId: 'spam' }, 10)).map((c) => c.threadId)).toEqual(['t5', 't3'])
        expect((await db.inbox(null, 10)).map((c) => c.threadId)).toEqual(['t6', 't1'])
        expect(Object.fromEntries(await db.unreadInboxCounts())).toEqual({ work: 1, home: 0 })
      })

      it('counts unread conversations per smart inbox', async () => {
        expect(Object.fromEntries(await db.unreadSmartInboxCounts())).toEqual({ todo: 1, news: 0, spam: 1 })
      })

      it('carries the classification on the conversation', async () => {
        expect((await db.inbox(null, 10)).find((c) => c.threadId === 't1')).toMatchObject({ smartInboxId: 'todo', verdict: 'do', classificationReason: 'direct', inbox: true, active: true })
      })

      it('finds and describes the conversations of a smart inbox for selections', async () => {
        const scope = { kind: 'smartInbox' as const, smartInboxId: 'spam' }

        expect(await db.listThreadIds(scope, () => true)).toEqual(['t5', 't3'])
        expect(await db.describeThreads(scope, ['t1', 't3', 't5'])).toEqual({ present: ['t3', 't5'], accounts: ['home', 'work'], senders: ['m4@sender.example', 'm5@sender.example'] })
      })

      it('moves a conversation at once when the user classifies it, and puts it back when that fails', async () => {
        const previous = await db.classifyThread('t3', 'todo', 'delegate')

        expect((await db.list({ kind: 'smartInbox', smartInboxId: 'todo' }, 10)).map((c) => [c.threadId, c.verdict, c.classificationReason])).toEqual([
          ['t1', 'do', 'direct'],
          ['t3', 'delegate', 'user'],
        ])
        expect((await db.inbox(null, 10)).map((c) => c.threadId)).toContain('t3')

        await db.restoreThread(previous!, { smartInboxId: 'todo', verdict: 'delegate' })
        expect((await db.thread('t3'))?.thread).toMatchObject({ smartInboxId: 'spam', classificationReason: 'server_spam' })
        expect((await db.inbox(null, 10)).map((c) => c.threadId)).not.toContain('t3')
      })

      it('does not put back a conversation the delta changed since', async () => {
        const previous = await db.classifyThread('t2', 'todo', 'do')
        await db.apply(page({ cursor: 21, threads: [thread('t2', 'work', { smartInboxId: 'news', verdict: 'know', classificationReason: 'sender_rule' })] }))

        await db.restoreThread(previous!, { smartInboxId: 'todo', verdict: 'do' })

        expect((await db.thread('t2'))?.thread).toMatchObject({ smartInboxId: 'news', classificationReason: 'sender_rule' })
      })

      it('keeps a placement the server confirmed, also when the answer to the request was lost', async () => {
        const previous = await db.classifyThread('t2', 'todo', 'do')
        await db.apply(page({ cursor: 21, threads: [thread('t2', 'work', { smartInboxId: 'todo', verdict: 'do', classificationReason: 'user' })] }))

        await db.restoreThread(previous!, { smartInboxId: 'todo', verdict: 'do' })

        expect((await db.thread('t2'))?.thread).toMatchObject({ smartInboxId: 'todo', verdict: 'do', classificationReason: 'user' })
      })

      it('says when the conversation to classify is gone', async () => {
        expect(await db.classifyThread('gone', 'todo', 'do')).toBeNull()
      })
    })

    describe('batched delivery', () => {
      const held = '2026-10-19T16:00:00+00:00'
      const heldMessage = { smartInboxId: 'news', verdict: 'know' as const, heldUntil: held }

      beforeEach(async () => {
        await db.apply(
          page({
            cursor: 30,
            smartInboxes: [{ ...smartInbox('news', 'advertise', 3), batchDelivery: true }],
            threads: [
              thread('t7', 'work', { smartInboxId: 'news', verdict: 'know', heldUntil: held }),
              thread('t8', 'home', { smartInboxId: 'news', verdict: 'know', heldUntil: held }),
            ],
            messages: [
              message('m7', 't7', 'work', ['work-inbox'], '2026-10-19T12:00:00+00:00', heldMessage),
              message('m8', 't8', 'home', ['home-inbox'], '2026-10-19T13:00:00+00:00', heldMessage),
            ],
          }),
        )
      })

      it('keeps held conversations out of every list and count until their batch delivers them', async () => {
        expect((await db.inbox(null, 10)).map((c) => c.threadId)).toEqual(['t1', 't3'])
        expect((await db.list({ kind: 'smartInbox', smartInboxId: 'news' }, 10)).map((c) => c.threadId)).toEqual([])
        expect((await db.list({ kind: 'batch' }, 10)).map((c) => c.threadId)).toEqual([])
        expect(Object.fromEntries(await db.unreadInboxCounts())).toEqual({ work: 1, home: 0 })
        expect(Object.fromEntries(await db.unreadSmartInboxCounts())).toEqual({ news: 0 })
        expect((await db.smartInboxes())[0]?.batchDelivery).toBe(true)

        await db.apply(page({ cursor: 31, threads: [thread('t7', 'work', { smartInboxId: 'news', verdict: 'know', heldUntil: null, batchedAt: held })] }))

        expect((await db.inbox(null, 10)).map((c) => c.threadId)).toEqual(['t7', 't1', 't3'])
        expect((await db.list({ kind: 'batch' }, 10)).map((c) => ({ threadId: c.threadId, batchedAt: c.batchedAt, heldUntil: c.heldUntil }))).toEqual([
          { threadId: 't7', batchedAt: Date.parse(held), heldUntil: null },
        ])
        expect(Object.fromEntries(await db.unreadSmartInboxCounts())).toEqual({ news: 1 })
      })

      it('lists the batches newest batch first, and leaves out what was archived since', async () => {
        await db.apply(
          page({
            cursor: 31,
            threads: [
              thread('t7', 'work', { smartInboxId: 'news', verdict: 'know', batchedAt: '2026-10-19T09:00:00+00:00' }),
              thread('t8', 'home', { smartInboxId: 'news', verdict: 'know', batchedAt: held }),
              thread('t1', 'work', { batchedAt: held }),
            ],
          }),
        )

        expect((await db.list({ kind: 'batch' }, 10)).map((c) => c.threadId)).toEqual(['t8', 't1', 't7'])
        expect(await db.listThreadIds({ kind: 'batch' }, () => true)).toEqual(['t8', 't1', 't7'])

        await db.apply(page({ cursor: 32, messages: [message('m7', 't7', 'work', ['work-archive'], '2026-10-19T12:00:00+00:00', { smartInboxId: 'news', verdict: 'know' })] }))
        expect((await db.list({ kind: 'batch' }, 10)).map((c) => c.threadId)).not.toContain('t7')
      })
    })

    describe('unsubscribe', () => {
      it('keeps the requests the delta brings and drops those of a deleted account', async () => {
        await db.apply(page({ cursor: 30, unsubscriptions: [unsubscription('u1', 'work', 'news@shop.example'), unsubscription('u2', 'home', 'digest@club.example', { method: 'mailto' })] }))
        await db.apply(page({ cursor: 31, unsubscriptions: [unsubscription('u1', 'work', 'news@shop.example', { status: 'done', completedAt: '2026-10-19T12:01:00+00:00' })] }))

        expect(await db.unsubscriptions()).toEqual([
          unsubscription('u1', 'work', 'news@shop.example', { status: 'done', completedAt: '2026-10-19T12:01:00+00:00' }),
          unsubscription('u2', 'home', 'digest@club.example', { method: 'mailto' }),
        ])

        await db.apply(page({ cursor: 32, deleted: [{ type: 'mailAccount', id: 'home' }] }))
        expect((await db.unsubscriptions()).map((u) => u.id)).toEqual(['u1'])
      })

      it('stores the answer to a request at once, without undoing what the delta brought since', async () => {
        await db.noteUnsubscription(unsubscription('u1', 'work', 'news@shop.example'))
        expect((await db.unsubscriptions()).map((u) => u.status)).toEqual(['pending'])

        await db.apply(page({ cursor: 30, unsubscriptions: [unsubscription('u1', 'work', 'news@shop.example', { status: 'failed', error: 'Refused.' })] }))
        await db.noteUnsubscription(unsubscription('u1', 'work', 'news@shop.example'))
        expect((await db.unsubscriptions()).map((u) => u.status)).toEqual(['failed'])

        // Asked again after the failure: a newer request.
        await db.noteUnsubscription(unsubscription('u1', 'work', 'news@shop.example', { requestedAt: '2026-10-19T13:00:00+00:00' }))
        expect((await db.unsubscriptions()).map((u) => u.status)).toEqual(['pending'])
      })

      it('carries how a message can be unsubscribed from', async () => {
        await db.apply(page({ cursor: 30, messages: [message('m2', 't1', 'work', ['work-inbox'], '2026-10-19T09:00:00+02:00', { unsubscribe: 'oneClick' })] }))

        expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm2')?.unsubscribe).toBe('oneClick')
      })
    })

    describe('hand-overs', () => {
      it('lists open hand-overs by due date first, then closed ones most recently closed first', async () => {
        await db.apply(
          page({
            cursor: 11,
            handOvers: [
              handOver('h1', 'm1', 'work', { dueAt: '2026-10-25T15:00:00+00:00' }),
              handOver('h2', 'm3', 'work', { dueAt: '2026-10-22T15:00:00+00:00' }),
              handOver('h3', 'm4', 'home', { state: 'done', closedAt: '2026-10-20T09:00:00+00:00' }),
              handOver('h4', 'm2', 'work', { state: 'replied', closedAt: '2026-10-20T10:00:00+00:00', replyMessageId: 'm2' }),
            ],
          }),
        )

        expect((await db.handOvers()).map((h) => h.id)).toEqual(['h2', 'h1', 'h4', 'h3'])
      })

      it('gives the conversation its message is in now, else the one it was handed over in when that is in the copy', async () => {
        await db.apply(
          page({
            cursor: 11,
            handOvers: [handOver('h1', 'm1', 'work', { threadId: 't1' }), handOver('h2', 'gone', 'work', { threadId: 't9' }), handOver('h3', null, 'work'), handOver('h4', null, 'work', { threadId: 't2' })],
          }),
        )
        await db.apply(page({ cursor: 12, threads: [thread('t4', 'work')], messages: [message('m1', 't4', 'work', ['work-inbox'], '2026-10-19T08:00:00+00:00')] }))

        expect(Object.fromEntries((await db.handOvers()).map((h) => [h.id, h.threadId]))).toEqual({ h1: 't4', h2: null, h3: null, h4: 't2' })
      })

      it('keeps them current and drops withdrawn ones', async () => {
        await db.apply(page({ cursor: 11, handOvers: [handOver('h1', 'm1', 'work'), handOver('h2', 'm3', 'work')] }))

        await db.apply(page({ cursor: 12, handOvers: [handOver('h1', 'm1', 'work', { state: 'done', closedAt: '2026-10-20T09:00:00+00:00' })], deleted: [{ type: 'handOver', id: 'h2' }] }))

        expect((await db.handOvers()).map((h) => [h.id, h.state])).toEqual([['h1', 'done']])
      })

      it('drops the hand-overs of a deleted account', async () => {
        await db.apply(page({ cursor: 11, handOvers: [handOver('h1', 'm1', 'work'), handOver('h2', 'm4', 'home')] }))

        await db.apply(page({ cursor: 12, deleted: [{ type: 'mailAccount', id: 'work' }] }))

        expect((await db.handOvers()).map((h) => h.id)).toEqual(['h2'])
      })
    })

    describe('calendars', () => {
      const october = (day: number): number => Date.UTC(2026, 9, day)
      const weekly = calendarEvent('weekly', 'work-cal', {
        uid: 'weekly@tresso.test',
        start: { dateTime: '2026-01-05T09:00:00', timeZone: 'Europe/Amsterdam' },
        end: { dateTime: '2026-01-05T09:30:00', timeZone: 'Europe/Amsterdam' },
        recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      })
      // An occurrence of October moved to December: it is out of October's range, yet October needs it.
      const moved = calendarEvent('moved', 'work-cal', {
        uid: 'weekly@tresso.test',
        recurrenceId: '20261019T070000Z',
        start: { dateTime: '2026-12-01T09:00:00', timeZone: 'Europe/Amsterdam' },
        end: { dateTime: '2026-12-01T09:30:00', timeZone: 'Europe/Amsterdam' },
      })
      const ended = calendarEvent('ended', 'work-cal', {
        start: { dateTime: '2025-01-06T09:00:00', timeZone: 'Europe/Amsterdam' },
        end: { dateTime: '2025-01-06T10:00:00', timeZone: 'Europe/Amsterdam' },
        recurrence: 'FREQ=DAILY;UNTIL=20250201T080000Z',
      })
      const allDay = calendarEvent('holiday', 'home-cal', { allDay: true, start: { date: '2026-10-21' }, end: { date: '2026-10-22' } })

      beforeEach(async () => {
        await db.apply(
          page({
            cursor: 30,
            calendars: [calendar('work-cal', 'work', { position: 1, name: 'Work' }), calendar('home-cal', 'home', { position: 2, name: 'Home' }), calendar('tresso', null, { position: 0, name: 'Tresso' })],
            calendarEvents: [weekly, moved, ended, allDay, calendarEvent('single', 'tresso')],
          }),
        )
      })

      it('lists calendars in the user order', async () => {
        expect((await db.calendars()).map((c) => c.id)).toEqual(['tresso', 'work-cal', 'home-cal'])
      })

      it('finds the rows a range needs, with every row of the series that touch it', async () => {
        const ids = (await db.calendarEvents(october(19), october(26))).map((e) => e.id).sort()
        expect(ids).toEqual(['holiday', 'moved', 'single', 'weekly'])
      })

      it('leaves out series that ended before the range', async () => {
        expect((await db.calendarEvents(october(1), october(2))).map((e) => e.id).sort()).toEqual(['moved', 'weekly'])
      })

      it('reads one event and drops deleted ones', async () => {
        expect((await db.calendarEvent('single'))?.summary).toBe('Event single')
        await db.apply(page({ cursor: 31, deleted: [{ type: 'calendarEvent', id: 'single' }] }))
        expect(await db.calendarEvent('single')).toBeNull()
      })

      it('finds a series by its whole span after one of its rows moves away or goes', async () => {
        // The series ends in January 2026 by itself; its moved December occurrence keeps it in December's range.
        const ended = calendarEvent('short', 'tresso', { uid: 'short@tresso.test', start: { dateTime: '2026-01-05T09:00:00', timeZone: 'Europe/Amsterdam' }, end: { dateTime: '2026-01-05T09:30:00', timeZone: 'Europe/Amsterdam' }, recurrence: 'FREQ=DAILY;UNTIL=20260110T080000Z' })
        const late = calendarEvent('short-late', 'tresso', { uid: 'short@tresso.test', recurrenceId: '20260106T080000Z', start: { dateTime: '2026-12-20T09:00:00', timeZone: 'Europe/Amsterdam' }, end: { dateTime: '2026-12-20T09:30:00', timeZone: 'Europe/Amsterdam' } })
        await db.apply(page({ cursor: 31, calendarEvents: [ended, late] }))
        const shortRows = async () => (await db.calendarEvents(Date.UTC(2026, 11, 1), Date.UTC(2026, 11, 31))).map((e) => e.id).filter((id) => id.startsWith('short')).sort()
        expect(await shortRows()).toEqual(['short', 'short-late'])
        await db.apply(page({ cursor: 32, deleted: [{ type: 'calendarEvent', id: 'short-late' }] }))
        expect(await shortRows()).toEqual([])
      })

      it('counts only pages that change calendars or events', async () => {
        const before = db.calendarChanges()
        await db.apply(page({ cursor: 31, signatures: [signature('sig-x', 'X')] }))
        expect(db.calendarChanges()).toBe(before)
        await db.apply(page({ cursor: 32, calendarEvents: [calendarEvent('single', 'tresso', { summary: 'Renamed' })] }))
        expect(db.calendarChanges()).toBe(before + 1)
        await db.apply(page({ cursor: 33, deleted: [{ type: 'calendar', id: 'home-cal' }] }))
        expect(db.calendarChanges()).toBe(before + 2)
      })

      it('drops the events of a deleted calendar, and the calendars of a deleted account', async () => {
        await db.apply(page({ cursor: 31, deleted: [{ type: 'calendar', id: 'home-cal' }, { type: 'mailAccount', id: 'work' }] }))
        expect((await db.calendars()).map((c) => c.id)).toEqual(['tresso'])
        expect(await db.calendarEvent('holiday')).toBeNull()
        expect(await db.calendarEvent('weekly')).toBeNull()
        expect((await db.calendarEvents(october(1), october(31))).map((e) => e.id)).toEqual(['single'])
      })
    })
  })
}
