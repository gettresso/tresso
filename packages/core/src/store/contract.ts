import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MissingFolderError } from '../actions'
import { briefView } from '../brief'
import type { SyncedCalendar, SyncedCalendarEvent } from '../calendar/types'
import { inInbox, unreadCount } from '../chat/format'
import type { SyncedChat, SyncedChatAccount, SyncedChatMessage, SyncedChatOutgoing } from '../chat/types'
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
    conferenceRequest: null,
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

/** A chat account as the delta brings it; `wa:account` makes one of the "Only this Mac" mode. */
export function chatAccount(id: string, extra: Partial<SyncedChatAccount> = {}): SyncedChatAccount {
  return {
    id,
    channel: 'whatsapp',
    address: '31698765432',
    displayName: 'Sam',
    relayDeviceId: '0193a000-0000-7000-8000-000000000001',
    relayDeviceName: 'MacBook Air',
    relayOnline: true,
    relayOfflineSince: null,
    bridge: 'running',
    link: 'linked',
    linkedAt: '2026-11-01T09:00:00+00:00',
    loopbackOnly: true,
    includeGroups: true,
    notify: false,
    ...extra,
  }
}

export function chat(id: string, chatAccountId: string, extra: Partial<SyncedChat> = {}): SyncedChat {
  return {
    id,
    chatAccountId,
    jid: `${id}@s.whatsapp.net`,
    kind: 'direct',
    name: `Chat ${id}`,
    lastMessageAt: '2026-11-12T10:00:00+00:00',
    readThrough: null,
    archivedThrough: null,
    leftOut: false,
    ...extra,
  }
}

export function chatMessage(id: string, chatId: string, chatAccountId: string, sentAt: string, extra: Partial<SyncedChatMessage> = {}): SyncedChatMessage {
  return { id, chatId, chatAccountId, waId: `3EB0${id}`, fromMe: false, sender: null, text: `Text ${id}`, sentAt, mediaKind: null, mediaName: null, mediaSize: null, ...extra }
}

export function chatOutgoing(id: string, chatId: string, chatAccountId: string, extra: Partial<SyncedChatOutgoing> = {}): SyncedChatOutgoing {
  return { id, chatId, chatAccountId, text: `Reply ${id}`, status: 'waiting', error: null, createdAt: '2026-11-12T10:05:00+00:00', claimedAt: null, sentAt: null, ...extra }
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

    it('keeps when it last synced, which a new copy does not know yet', async () => {
      expect(await db.syncedAt()).toBeNull()
      expect(db.afterUpdate).toBe(false)

      await db.markSynced(1_700_000_000_000)

      expect(await db.syncedAt()).toBe(1_700_000_000_000)
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

    it('keeps a draft with a send under way when the server hides it for sending', async () => {
      await db.saveDraft(draft('d1', { version: 2, sendAttemptId: 'a1' }))

      await db.apply(page({ cursor: 11, deleted: [{ type: 'draft', id: 'd1' }] }))

      expect(await db.draft('d1')).toMatchObject({ sendAttemptId: 'a1', pendingSave: false, hiddenOnServer: true })
      // The server bringing the draft back ends the mark.
      const synced = { id: 'd1', mailAccountId: 'work', kind: 'new' as const, to: [], cc: [], bcc: [], subject: 'Hi', html: '<p>Hi</p>', signatureId: null, quoteHtml: '', inReplyToMessageId: null, version: 3, updatedAt: '2026-10-19T08:00:00Z', attachments: [] }
      await db.apply(page({ cursor: 12, drafts: [synced] }))
      expect((await db.draft('d1'))?.hiddenOnServer).toBeUndefined()
    })

    it('keeps edits the server never had on a draft hidden for sending, and drops the mark when the server has it again', async () => {
      await db.saveDraft(draft('d1', { version: 2, sendAttemptId: 'a1', pendingSave: true, subject: 'Typed offline' }))

      await db.apply(page({ cursor: 11, deleted: [{ type: 'draft', id: 'd1' }] }))
      expect(await db.draft('d1')).toMatchObject({ pendingSave: true, hiddenOnServer: true, subject: 'Typed offline' })

      const synced = { id: 'd1', mailAccountId: 'work', kind: 'new' as const, to: [], cc: [], bcc: [], subject: 'Hi', html: '<p>Hi</p>', signatureId: null, quoteHtml: '', inReplyToMessageId: null, version: 2, updatedAt: '2026-10-19T08:00:00Z', attachments: [] }
      await db.apply(page({ cursor: 12, drafts: [synced] }))
      const back = await db.draft('d1')
      expect(back).toMatchObject({ pendingSave: true, subject: 'Typed offline' })
      expect(back?.hiddenOnServer).toBeUndefined()
    })

    it('keeps a newer draft than the one a late page brings', async () => {
      const synced = { id: 'd1', mailAccountId: 'work', kind: 'new' as const, to: [], cc: [], bcc: [], subject: 'Newer', html: '', signatureId: null, quoteHtml: '', inReplyToMessageId: null, version: 5, updatedAt: '2026-10-19T08:00:00Z', attachments: [] }
      await db.apply(page({ cursor: 11, drafts: [synced] }))

      await db.apply(page({ cursor: 12, drafts: [{ ...synced, subject: 'Older', version: 4 }] }))

      expect(await db.draft('d1')).toMatchObject({ subject: 'Newer', version: 5 })
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

    it('undoes two refused actions on the same message part by part, whichever order they fail in', async () => {
      const read = await db.applyAction(['m2'], 'markRead')
      const flagged = await db.applyAction(['m2'], 'flag')

      await db.revertAction(read)
      expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm2')?.flags).toMatchObject({ seen: false, flagged: true })
      await db.revertAction(flagged)
      expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm2')?.flags).toMatchObject({ seen: false, flagged: false })

      // The same part twice: read, then unread again, both refused in the order they were made.
      const markedRead = await db.applyAction(['m2'], 'markRead')
      const markedUnread = await db.applyAction(['m2'], 'markUnread')
      await db.revertAction(markedRead)
      await db.revertAction(markedUnread)
      expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm2')?.flags).toMatchObject({ seen: false })
      // And in the other order, from a message that was read.
      const unread = await db.applyAction(['m1'], 'markUnread')
      const readAgainFirst = await db.applyAction(['m1'], 'markRead')
      await db.revertAction(readAgainFirst)
      expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm1')?.flags).toMatchObject({ seen: true })
      await db.revertAction(unread)
      expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm1')?.flags).toMatchObject({ seen: true })

      // An action the server took without changing anything (no delta follows) is not left open.
      const first = await db.applyAction(['m2'], 'markRead')
      const second = await db.applyAction(['m2'], 'markUnread')
      await db.revertAction(first)
      db.acceptAction(second)
      const third = await db.applyAction(['m2'], 'markRead')
      await db.revertAction(third)
      expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm2')?.flags).toMatchObject({ seen: false })

      // A late answer to an action the delta already settled leaves a newer action on the same part alone.
      const settled = await db.applyAction(['m2'], 'markRead')
      await db.apply(page({ cursor: 30, messages: [{ ...(await db.thread('t1'))!.messages.find((m) => m.id === 'm2')!, flags: { seen: true, flagged: false, answered: false, draft: false } }] }))
      const newer = await db.applyAction(['m2'], 'markUnread')
      db.acceptAction(settled)
      await db.revertAction(newer)
      expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm2')?.flags).toMatchObject({ seen: true })
      await db.apply(page({ cursor: 31, messages: [{ ...(await db.thread('t1'))!.messages.find((m) => m.id === 'm2')!, flags: { seen: false, flagged: false, answered: false, draft: false } }] }))

      const archived = await db.applyAction(['m2'], 'archive')
      const readAgain = await db.applyAction(['m2'], 'markRead')
      await db.revertAction(readAgain)
      await db.revertAction(archived)
      expect((await db.thread('t1'))?.messages.find((m) => m.id === 'm2')).toMatchObject({ folderIds: ['work-inbox'], flags: { seen: false, flagged: false } })
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

        await db.restoreThread(previous!)
        expect((await db.thread('t3'))?.thread).toMatchObject({ smartInboxId: 'spam', classificationReason: 'server_spam' })
        expect((await db.inbox(null, 10)).map((c) => c.threadId)).not.toContain('t3')
      })

      it('puts a conversation classified twice back only once both choices were refused, as it was before the first', async () => {
        const before = (await db.thread('t3'))!.thread
        const first = await db.classifyThread('t3', 'todo', 'delegate')
        const second = await db.classifyThread('t3', 'todo', 'do')

        await db.restoreThread(first!)
        expect((await db.thread('t3'))?.thread).toMatchObject({ smartInboxId: 'todo', verdict: 'do', classificationReason: 'user' })

        await db.restoreThread(second!)
        expect((await db.thread('t3'))?.thread).toEqual(before)
      })

      it('keeps the second choice when only the first was refused and the server confirmed the second', async () => {
        const first = await db.classifyThread('t3', 'todo', 'delegate')
        await db.classifyThread('t3', 'todo', 'do')

        await db.restoreThread(first!)
        await db.apply(page({ cursor: 21, threads: [thread('t3', 'home', { smartInboxId: 'todo', verdict: 'do', classificationReason: 'user' })] }))

        expect((await db.thread('t3'))?.thread).toMatchObject({ smartInboxId: 'todo', verdict: 'do', classificationReason: 'user' })
      })

      it('does not put back a conversation the delta changed since', async () => {
        const previous = await db.classifyThread('t2', 'todo', 'do')
        await db.apply(page({ cursor: 21, threads: [thread('t2', 'work', { smartInboxId: 'news', verdict: 'know', classificationReason: 'sender_rule' })] }))

        await db.restoreThread(previous!)

        expect((await db.thread('t2'))?.thread).toMatchObject({ smartInboxId: 'news', classificationReason: 'sender_rule' })
      })

      it('keeps a placement the server confirmed, also when the answer to the request was lost', async () => {
        const previous = await db.classifyThread('t2', 'todo', 'do')
        await db.apply(page({ cursor: 21, threads: [thread('t2', 'work', { smartInboxId: 'todo', verdict: 'do', classificationReason: 'user' })] }))

        await db.restoreThread(previous!)

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

    describe('chats', () => {
      const at = (minute: number) => `2026-11-12T10:${String(minute).padStart(2, '0')}:00+00:00`
      // Three chats of one account: Anna (two incoming, one own), Bram (one incoming, read), a group (one message).
      const chatPage = page({
        cursor: 40,
        chatAccounts: [chatAccount('acct')],
        chats: [
          chat('anna', 'acct', { jid: '31611111111@s.whatsapp.net', lastMessageAt: at(3) }),
          chat('bram', 'acct', { jid: '31622222222@s.whatsapp.net', lastMessageAt: at(5), readThrough: at(5) }),
          chat('group', 'acct', { jid: '120363025246125486@g.us', kind: 'group', name: null, lastMessageAt: at(1) }),
        ],
        chatMessages: [
          chatMessage('a2', 'anna', 'acct', at(2)),
          chatMessage('a1', 'anna', 'acct', at(1)),
          chatMessage('a3', 'anna', 'acct', at(3), { fromMe: true }),
          chatMessage('b1', 'bram', 'acct', at(5)),
          chatMessage('g1', 'group', 'acct', at(1), { sender: { id: '31633333333', name: 'Cas' }, mediaKind: 'image', mediaName: 'photo.jpg', mediaSize: 1024 }),
        ],
        chatOutgoing: [chatOutgoing('r2', 'anna', 'acct', { createdAt: at(7) }), chatOutgoing('r1', 'anna', 'acct', { createdAt: at(6), status: 'sent', claimedAt: at(6), sentAt: at(6) })],
      })

      beforeEach(async () => {
        await db.apply(chatPage)
      })

      const ids = (rows: { id: string }[]) => rows.map((row) => row.id)
      const listed = async (options?: { inboxOnly?: boolean; limit?: number }) => (await db.chats(options)).map((summary) => summary.chat.id)

      it('stores all four lists of a page and reads them back as the delta gave them', async () => {
        expect(await db.chatAccounts()).toEqual([chatAccount('acct')])
        const anna = await db.chat('anna')
        expect(anna?.chat).toEqual(chatPage.chats![0])
        expect(ids(anna!.messages)).toEqual(['a1', 'a2', 'a3'])
        expect(ids(anna!.outgoing)).toEqual(['r1', 'r2'])
        expect((await db.chat('group'))?.messages[0]).toEqual(chatPage.chatMessages![4])
        expect(await db.cursor()).toBe(40)
      })

      it('reads a chat in windows, newest first, with every reply and whether older messages exist', async () => {
        const key = (id: string, minute: number) => ({ sentAt: Date.parse(at(minute)), id })
        // Two messages in the same minute as a2, ordered by id around it.
        await db.apply(page({ cursor: 41, chatMessages: [chatMessage('a0', 'anna', 'acct', at(2)), chatMessage('a9', 'anna', 'acct', at(2))] }))

        const newest = await db.chatPage('anna', { limit: 2 })
        expect(ids(newest!.messages)).toEqual(['a9', 'a3'])
        expect(newest!.hasOlder).toBe(true)
        expect(ids(newest!.outgoing)).toEqual(['r1', 'r2'])
        expect(newest!.chat).toEqual(chatPage.chats![0])

        const older = await db.chatPage('anna', { limit: 2, before: key('a9', 2) })
        expect(ids(older!.messages)).toEqual(['a0', 'a2'])
        expect(older!.hasOlder).toBe(true)

        const oldest = await db.chatPage('anna', { limit: 2, before: key('a0', 2) })
        expect(ids(oldest!.messages)).toEqual(['a1'])
        expect(oldest!.hasOlder).toBe(false)

        // From a message on: all of them up to the newest, within the limit, and older ones are said to exist.
        const since = await db.chatPage('anna', { limit: 10, from: key('a2', 2) })
        expect(ids(since!.messages)).toEqual(['a2', 'a9', 'a3'])
        expect(since!.hasOlder).toBe(true)
        expect((await db.chatPage('anna', { limit: 10, from: key('a1', 1) }))!.hasOlder).toBe(false)
        expect(ids((await db.chatPage('anna', { limit: 2, from: key('a1', 1) }))!.messages)).toEqual(['a9', 'a3'])

        // Nothing before the oldest; a limit below one reads one.
        const none = await db.chatPage('anna', { limit: 5, before: key('a1', 1) })
        expect(none!.messages).toEqual([])
        expect(none!.hasOlder).toBe(false)
        expect(ids((await db.chatPage('anna', { limit: 0 }))!.messages)).toEqual(['a3'])
        expect(await db.chatPage('nobody', { limit: 5 })).toBeNull()
        expect((await db.chatPage('group', { limit: 5 }))!.messages[0]).toEqual(chatPage.chatMessages![4])
      })

      it('keeps the file a reply of this device carries, as it was written', async () => {
        const row = chatOutgoing('f1', 'anna', 'acct', { text: 'File: plan.pdf', status: 'sent', claimedAt: at(8), sentAt: at(8), createdAt: at(8), file: { name: 'plan.pdf', size: 4096 } })
        await db.putChatOutgoing([row])
        expect((await db.chat('anna'))!.outgoing.find((reply) => reply.id === 'f1')).toEqual(row)
        expect((await db.chatPage('anna', { limit: 1 }))!.outgoing.find((reply) => reply.id === 'f1')?.file).toEqual({ name: 'plan.pdf', size: 4096 })
      })

      it('stores a page given twice once', async () => {
        await db.apply({ ...chatPage, cursor: 41 })

        expect(await db.chatAccounts()).toHaveLength(1)
        expect(await listed()).toEqual(['bram', 'anna', 'group'])
        expect(ids((await db.chat('anna'))!.messages)).toEqual(['a1', 'a2', 'a3'])
        expect(ids((await db.chat('anna'))!.outgoing)).toEqual(['r1', 'r2'])
        expect(await db.unreadChatCount()).toBe(2)
      })

      it('keeps messages that come before their chat, and shows them once it arrives', async () => {
        await db.apply(page({ cursor: 41, chatMessages: [chatMessage('d1', 'dirk', 'acct', at(8)), chatMessage('d2', 'dirk', 'acct', at(9))] }))
        expect(await db.chat('dirk')).toBeNull()
        expect(await listed()).toEqual(['bram', 'anna', 'group'])

        await db.apply(page({ cursor: 42, chats: [chat('dirk', 'acct', { jid: '31644444444@s.whatsapp.net', lastMessageAt: at(9) })] }))

        expect(ids((await db.chat('dirk'))!.messages)).toEqual(['d1', 'd2'])
        expect((await db.chats({ limit: 1 }))[0]).toMatchObject({ chat: { id: 'dirk' }, newest: { id: 'd2' }, unread: 2 })
      })

      it('lists chats newest first with their newest message and unread count, never one left out', async () => {
        const summaries = await db.chats()

        expect(summaries.map((summary) => [summary.chat.id, summary.newest?.id ?? null, summary.unread, summary.lastMessageAt])).toEqual([
          ['bram', 'b1', 0, Date.parse(at(5))],
          ['anna', 'a3', 2, Date.parse(at(3))],
          ['group', 'g1', 1, Date.parse(at(1))],
        ])
        expect(await listed({ limit: 2 })).toEqual(['bram', 'anna'])
        expect(await listed({ limit: 0 })).toEqual([])

        await db.apply(page({ cursor: 41, chats: [chat('anna', 'acct', { jid: '31611111111@s.whatsapp.net', lastMessageAt: at(3), leftOut: true })] }))

        expect(await listed()).toEqual(['bram', 'group'])
        expect(await db.chatByJid('acct', '31611111111@s.whatsapp.net')).toMatchObject({ id: 'anna', leftOut: true })
        expect(await db.unreadChatCount()).toBe(1)
      })

      it("lists an account's chats left out, newest first, and no other", async () => {
        expect(await db.leftOutChats('acct')).toEqual([])

        await db.apply(
          page({
            cursor: 41,
            chats: [
              chat('anna', 'acct', { jid: '31611111111@s.whatsapp.net', lastMessageAt: at(3), leftOut: true }),
              chat('bram', 'acct', { jid: '31622222222@s.whatsapp.net', lastMessageAt: at(5), leftOut: true }),
              chat('other', 'acct-2', { jid: '31633333333@s.whatsapp.net', lastMessageAt: at(4), leftOut: true }),
            ],
          }),
        )

        expect((await db.leftOutChats('acct')).map((left) => left.id)).toEqual(['bram', 'anna'])
        expect((await db.leftOutChats('acct-2')).map((left) => left.id)).toEqual(['other'])
        expect(await db.leftOutChats('none')).toEqual([])
      })

      it('orders chats of the same time by id, newest id first', async () => {
        await db.apply(page({ cursor: 41, chats: [chat('anna', 'acct', { jid: '31611111111@s.whatsapp.net', lastMessageAt: at(5) })] }))

        expect(await listed()).toEqual(['bram', 'anna', 'group'])
      })

      it('keeps archived chats out of the inbox until a message comes in after', async () => {
        await db.apply(page({ cursor: 41, chats: [chat('bram', 'acct', { jid: '31622222222@s.whatsapp.net', lastMessageAt: at(5), readThrough: at(5), archivedThrough: at(5) })] }))
        expect(await listed({ inboxOnly: true })).toEqual(['anna', 'group'])
        expect(await listed()).toEqual(['bram', 'anna', 'group'])

        await db.apply(
          page({
            cursor: 42,
            chats: [chat('bram', 'acct', { jid: '31622222222@s.whatsapp.net', lastMessageAt: at(9), readThrough: at(5), archivedThrough: at(5) })],
            chatMessages: [chatMessage('b2', 'bram', 'acct', at(9))],
          }),
        )
        expect(await listed({ inboxOnly: true })).toEqual(['bram', 'anna', 'group'])
      })

      it('counts chats with incoming messages after what the user read', async () => {
        expect(await db.unreadChatCount()).toBe(2)

        // Read through the second incoming message of Anna: her own message after it is no unread one.
        await db.apply(page({ cursor: 41, chats: [chat('anna', 'acct', { jid: '31611111111@s.whatsapp.net', lastMessageAt: at(3), readThrough: at(2) })] }))
        expect(await db.unreadChatCount()).toBe(1)
        expect((await db.chats()).find((summary) => summary.chat.id === 'anna')?.unread).toBe(0)

        // An archived chat is not in the inbox, so it does not count.
        await db.apply(page({ cursor: 42, chats: [chat('group', 'acct', { jid: '120363025246125486@g.us', kind: 'group', name: null, lastMessageAt: at(1), archivedThrough: at(1) })] }))
        expect(await db.unreadChatCount()).toBe(0)
      })

      it('removes a deleted chat with its messages and replies, and nothing else', async () => {
        await db.apply(page({ cursor: 41, deleted: [{ type: 'chat', id: 'anna' }] }))

        expect(await db.chat('anna')).toBeNull()
        expect(await db.waitingOutgoing()).toEqual([])
        expect(await listed()).toEqual(['bram', 'group'])
        expect(ids((await db.chat('bram'))!.messages)).toEqual(['b1'])
        expect(await db.chatByJid('acct', '31611111111@s.whatsapp.net')).toBeNull()
      })

      it('removes everything of a deleted chat account, also messages stored before their chat', async () => {
        await db.apply(page({ cursor: 41, chatMessages: [chatMessage('d1', 'dirk', 'acct', at(8))] }))

        await db.apply(page({ cursor: 42, deleted: [{ type: 'chatAccount', id: 'acct' }] }))

        expect(await db.chatAccounts()).toEqual([])
        expect(await db.chats()).toEqual([])
        expect(await db.waitingOutgoing()).toEqual([])
        expect(await db.unreadChatCount()).toBe(0)
        // The orphan went too: its chat arriving now shows no message of before.
        await db.apply(page({ cursor: 43, chatAccounts: [chatAccount('acct')], chats: [chat('dirk', 'acct', { jid: '31644444444@s.whatsapp.net', lastMessageAt: at(8) })] }))
        expect((await db.chat('dirk'))?.messages).toEqual([])
      })

      it('removes single messages and replies by their own tombstones', async () => {
        await db.apply(page({ cursor: 41, deleted: [{ type: 'chatMessage', id: 'a1' }, { type: 'chatOutgoing', id: 'r2' }] }))

        const anna = await db.chat('anna')
        expect(ids(anna!.messages)).toEqual(['a2', 'a3'])
        expect(ids(anna!.outgoing)).toEqual(['r1'])
      })

      it('replaces a message stored again under its id', async () => {
        await db.putChatMessages([chatMessage('a1', 'anna', 'acct', at(1), { text: 'Edited' })])
        await db.putChatMessages([chatMessage('a1', 'anna', 'acct', at(1), { text: 'Edited' })])

        const anna = await db.chat('anna')
        expect(ids(anna!.messages)).toEqual(['a1', 'a2', 'a3'])
        expect(anna!.messages[0]!.text).toBe('Edited')
      })

      it('gives a JID one chat per account: a chat made again under a new id takes the place of the old one', async () => {
        await db.putChats([chat('anna-2', 'acct', { jid: '31611111111@s.whatsapp.net', lastMessageAt: at(9) })])

        expect(await db.chat('anna')).toBeNull()
        expect(await db.chatByJid('acct', '31611111111@s.whatsapp.net')).toMatchObject({ id: 'anna-2' })
        expect(await db.waitingOutgoing()).toEqual([])
        expect(await listed()).toEqual(['anna-2', 'bram', 'group'])
        // The same JID in another account is another chat.
        await db.putChats([chat('anna-other', 'acct-2', { jid: '31611111111@s.whatsapp.net' })])
        expect(await db.chatByJid('acct', '31611111111@s.whatsapp.net')).toMatchObject({ id: 'anna-2' })
        expect(await db.chatByJid('acct-2', '31611111111@s.whatsapp.net')).toMatchObject({ id: 'anna-other' })
      })

      it('lists the replies waiting to be sent, oldest first', async () => {
        await db.putChatOutgoing([
          chatOutgoing('r4', 'bram', 'acct', { createdAt: at(4) }),
          chatOutgoing('r3', 'bram', 'acct', { createdAt: at(4) }),
          chatOutgoing('r5', 'bram', 'acct', { createdAt: at(2), status: 'failed', error: 'refused' }),
        ])

        expect(ids(await db.waitingOutgoing())).toEqual(['r3', 'r4', 'r2'])

        await db.putChatOutgoing([chatOutgoing('r3', 'bram', 'acct', { createdAt: at(4), status: 'sending', claimedAt: at(10) })])
        expect(ids(await db.waitingOutgoing())).toEqual(['r4', 'r2'])
      })

      it('lists the replies being sent of accounts on this device only, oldest first', async () => {
        await db.putChatAccount(chatAccount('wa:account'))
        await db.putChats([chat('wa:31655555555@s.whatsapp.net', 'wa:account', { jid: '31655555555@s.whatsapp.net' })])
        await db.putChatOutgoing([
          chatOutgoing('l2', 'wa:31655555555@s.whatsapp.net', 'wa:account', { createdAt: at(6), status: 'sending', claimedAt: at(7) }),
          chatOutgoing('l1', 'wa:31655555555@s.whatsapp.net', 'wa:account', { createdAt: at(5), status: 'sending', claimedAt: at(7) }),
          chatOutgoing('l3', 'wa:31655555555@s.whatsapp.net', 'wa:account', { createdAt: at(5), status: 'waiting' }),
          // A server row being sent (or of an unknown status a newer server sent) is not this device's.
          chatOutgoing('s1', 'bram', 'acct', { createdAt: at(4), status: 'sending', claimedAt: at(7) }),
        ])

        expect(ids(await db.sendingOutgoingHere())).toEqual(['l1', 'l2'])
      })

      it('writes and removes chats of its own, as the "Only this Mac" relay does', async () => {
        await db.putChatAccount(chatAccount('wa:account'))
        await db.putChats([chat('wa:31655555555@s.whatsapp.net', 'wa:account', { jid: '31655555555@s.whatsapp.net', lastMessageAt: at(20) })])
        await db.putChatMessages([chatMessage('wa:31655555555@s.whatsapp.net:X1', 'wa:31655555555@s.whatsapp.net', 'wa:account', at(20))])
        await db.putChatOutgoing([chatOutgoing('0193a000-0000-7000-8000-0000000000aa', 'wa:31655555555@s.whatsapp.net', 'wa:account', { createdAt: at(21) })])

        expect(ids(await db.chatAccounts())).toEqual(['acct', 'wa:account'])
        expect((await db.chats({ limit: 1 }))[0]).toMatchObject({ chat: { id: 'wa:31655555555@s.whatsapp.net' }, unread: 1 })

        await db.removeChat('wa:31655555555@s.whatsapp.net')
        expect(await db.chat('wa:31655555555@s.whatsapp.net')).toBeNull()
        expect(ids(await db.waitingOutgoing())).toEqual(['r2'])

        await db.removeChatAccount('acct')
        expect(ids(await db.chatAccounts())).toEqual(['wa:account'])
        expect(await db.chats()).toEqual([])
      })

      it('keeps chat values apart from the copy, and removes one set to null', async () => {
        expect(await db.chatMeta('cursor')).toBeNull()

        await db.setChatMeta('cursor', '1234')
        expect(await db.chatMeta('cursor')).toBe('1234')
        expect(await db.cursor()).toBe(40)

        await db.setChatMeta('cursor', null)
        expect(await db.chatMeta('cursor')).toBeNull()
        expect(await db.cursor()).toBe(40)
      })

      it('stores a page with chat times that are no times, sorting those rows last, so the sync goes on', async () => {
        const odd = page({
          cursor: 41,
          chats: [chat('eva', 'acct', { jid: '31666666666@s.whatsapp.net', lastMessageAt: 'garbage' }), { ...chat('fay', 'acct', { jid: '31677777777@s.whatsapp.net' }), lastMessageAt: null as unknown as string }],
          chatMessages: [chatMessage('e1', 'eva', 'acct', 'yesterday', { text: 'Secret plans' }), chatMessage('e2', 'eva', 'acct', at(30))],
          chatOutgoing: [chatOutgoing('r9', 'eva', 'acct', { createdAt: 'soon' })],
          messages: [message('m9', 't1', 'work', ['work-inbox'], '2026-10-19T11:00:00+00:00')],
        })

        await db.apply(odd)

        expect(await db.cursor()).toBe(41)
        expect((await db.thread('t1'))?.messages.map((m) => m.id)).toContain('m9')
        expect(await listed()).toEqual(['bram', 'anna', 'group', 'fay', 'eva'])
        expect((await db.chat('fay'))?.chat.lastMessageAt).toBe('')
        const eva = await db.chat('eva')
        expect(eva?.messages.map((m) => m.id).sort()).toEqual(['e1', 'e2'])
        expect((await db.chats()).find((summary) => summary.chat.id === 'eva')?.newest?.id).toBe('e2')
        expect(eva?.outgoing.map((o) => o.id)).toEqual(['r9'])
      })

      it('stores a chat row a newer server shapes differently as far as it can be read', async () => {
        const newer = page({
          cursor: 41,
          chatAccounts: [{ ...chatAccount('acct-new'), channel: 'signal', bridge: 'paused', link: 'expired', notify: undefined, includeGroups: undefined } as unknown as SyncedChatAccount, { channel: 'whatsapp' } as unknown as SyncedChatAccount],
          chats: [
            { id: 'odd', chatAccountId: 'acct', jid: '120363000000000000@g.us', kind: 'community', lastMessageAt: at(20) } as unknown as SyncedChat,
            { jid: 'nobody@s.whatsapp.net' } as unknown as SyncedChat,
          ],
          chatMessages: [
            { ...chatMessage('o1', 'odd', 'acct', at(20)), mediaKind: 'sticker', mediaName: 'x.webp', sender: { name: 'No id' }, reactions: ['+1'] } as unknown as SyncedChatMessage,
            { id: 'o2', chatId: 'odd', chatAccountId: 'acct', sentAt: at(19) } as unknown as SyncedChatMessage,
          ],
          chatOutgoing: [{ ...chatOutgoing('r8', 'odd', 'acct'), status: 'scheduled', error: 'rate_limited' } as unknown as SyncedChatOutgoing],
        })

        await db.apply(newer)

        expect(await db.cursor()).toBe(41)
        expect(await db.chatAccounts()).toContainEqual({ ...chatAccount('acct-new'), channel: 'signal', bridge: 'stopped', link: 'unknown', notify: false, includeGroups: true })
        expect(ids(await db.chatAccounts())).toEqual(['acct', 'acct-new'])
        const odd = await db.chat('odd')
        expect(odd?.chat).toEqual({ id: 'odd', chatAccountId: 'acct', jid: '120363000000000000@g.us', kind: 'group', name: null, lastMessageAt: at(20), readThrough: null, archivedThrough: null, leftOut: false })
        expect(odd?.messages).toEqual([
          { id: 'o2', chatId: 'odd', chatAccountId: 'acct', waId: '', fromMe: false, sender: null, text: '', sentAt: at(19), mediaKind: null, mediaName: null, mediaSize: null },
          { ...chatMessage('o1', 'odd', 'acct', at(20)), mediaKind: 'document', mediaName: 'x.webp', sender: null },
        ])
        // Neither sent again nor offered to retry.
        expect(odd?.outgoing[0]).toMatchObject({ id: 'r8', status: 'sending', error: 'refused' })
        expect(ids(await db.waitingOutgoing())).toEqual(['r2'])
      })

      it('leaves out a chat without a JID, so it never takes the place of another', async () => {
        await db.apply(
          page({
            cursor: 41,
            chats: [
              { ...chat('nojid-1', 'acct'), jid: undefined } as unknown as SyncedChat,
              { ...chat('nojid-2', 'acct'), jid: '' },
              { ...chat('nojid-3', 'acct'), jid: null } as unknown as SyncedChat,
            ],
            chatMessages: [chatMessage('n1', 'nojid-1', 'acct', at(9))],
          }),
        )

        expect(await db.cursor()).toBe(41)
        expect(await db.chat('nojid-1')).toBeNull()
        expect(await db.chat('nojid-2')).toBeNull()
        expect(await listed()).toEqual(['bram', 'anna', 'group'])
        expect(ids((await db.chat('anna'))!.messages)).toEqual(['a1', 'a2', 'a3'])
      })

      it('agrees with inInbox and unreadCount on every chat, also with times that are no times', async () => {
        const rows = page({
          cursor: 41,
          chats: [
            chat('t-odd', 'acct', { lastMessageAt: 'garbage', archivedThrough: at(0) }),
            chat('t-odd-open', 'acct', { lastMessageAt: 'garbage' }),
            chat('t-read', 'acct', { lastMessageAt: at(9), readThrough: at(5), archivedThrough: 'nonsense' }),
            chat('t-bad-read', 'acct', { lastMessageAt: at(9), readThrough: 'nonsense', archivedThrough: at(9) }),
          ],
          chatMessages: [
            chatMessage('o1', 't-odd', 'acct', 'yesterday'),
            chatMessage('o2', 't-odd-open', 'acct', ''),
            chatMessage('r1', 't-read', 'acct', 'yesterday'),
            chatMessage('r2', 't-read', 'acct', at(5)),
            chatMessage('r3', 't-read', 'acct', at(6)),
            chatMessage('r4', 't-read', 'acct', at(7), { fromMe: true }),
            chatMessage('b1', 't-bad-read', 'acct', 'yesterday'),
            chatMessage('b2', 't-bad-read', 'acct', at(8)),
          ],
        })
        await db.apply(rows)

        const all = await db.chats()
        const inbox = new Set((await db.chats({ inboxOnly: true })).map((summary) => summary.chat.id))
        for (const row of rows.chats!) {
          const messages = rows.chatMessages!.filter((message) => message.chatId === row.id)
          expect({ id: row.id, inbox: inbox.has(row.id), unread: all.find((summary) => summary.chat.id === row.id)?.unread }).toEqual({
            id: row.id,
            inbox: inInbox(row),
            unread: unreadCount(row, messages),
          })
        }
        // And the badge counts what those say, with the chats of the first page.
        const expected = [...chatPage.chats!, ...rows.chats!].filter(
          (row) => inInbox(row) && unreadCount(row, [...chatPage.chatMessages!, ...rows.chatMessages!]) > 0,
        ).length
        expect(await db.unreadChatCount()).toBe(expected)
      })

      it('drops messages and replies that come in the same page as the removal of their chat or account', async () => {
        await db.apply(
          page({
            cursor: 41,
            chatMessages: [chatMessage('a9', 'anna', 'acct', at(9)), chatMessage('x1', 'xavi', 'acct-x', at(9))],
            chatOutgoing: [chatOutgoing('r7', 'anna', 'acct')],
            deleted: [
              { type: 'chat', id: 'anna' },
              { type: 'chatAccount', id: 'acct-x' },
            ],
          }),
        )

        expect(await db.chat('anna')).toBeNull()
        expect(ids(await db.waitingOutgoing())).toEqual([])
        // Were they still there, the chat or account arriving again would show them.
        await db.apply(page({ cursor: 42, chatAccounts: [chatAccount('acct-x')], chats: [chat('anna', 'acct', { jid: '31611111111@s.whatsapp.net' }), chat('xavi', 'acct-x')] }))
        expect((await db.chat('anna'))?.messages).toEqual([])
        expect((await db.chat('anna'))?.outgoing).toEqual([])
        expect((await db.chat('xavi'))?.messages).toEqual([])
      })

      it('keeps a message of the page when the same page removes its chat and brings it back', async () => {
        await db.apply(page({ cursor: 41, chats: [chat('anna', 'acct', { jid: '31611111111@s.whatsapp.net', lastMessageAt: at(9) })], chatMessages: [chatMessage('a9', 'anna', 'acct', at(9))], deleted: [{ type: 'chat', id: 'anna' }] }))

        expect(ids((await db.chat('anna'))!.messages)).toEqual(['a9'])
      })

      it('keeps a cancelled reply where it is, never as waiting, and drops it by its tombstone', async () => {
        await db.apply(page({ cursor: 41, chatOutgoing: [chatOutgoing('r2', 'anna', 'acct', { createdAt: at(7), status: 'cancelled' })] }))

        expect((await db.chat('anna'))?.outgoing.find((o) => o.id === 'r2')?.status).toBe('cancelled')
        expect(await db.waitingOutgoing()).toEqual([])

        await db.apply(page({ cursor: 42, deleted: [{ type: 'chatOutgoing', id: 'r2' }] }))
        expect(ids((await db.chat('anna'))!.outgoing)).toEqual(['r1'])
      })

      it('refuses a time that is no time from this device itself, which is a mistake in the relay', async () => {
        await expect(db.putChatMessages([chatMessage('w1', 'anna', 'acct', 'yesterday', { text: 'Secret plans' })])).rejects.toThrow(/sentAt is not a time/)
        await expect(db.putChats([chat('w', 'acct', { lastMessageAt: 'never' })])).rejects.toThrow(/lastMessageAt is not a time/)
        await expect(db.putChatOutgoing([chatOutgoing('w2', 'anna', 'acct', { createdAt: 'later' })])).rejects.toThrow(/createdAt is not a time/)
        const error = await db.putChatMessages([chatMessage('w1', 'anna', 'acct', 'yesterday', { text: 'Secret plans' })]).catch((thrown: unknown) => thrown as Error)
        expect(error?.message).not.toContain('Secret')
        expect(error?.message).not.toContain('yesterday')
        expect(ids((await db.chat('anna'))!.messages)).toEqual(['a1', 'a2', 'a3'])
      })

      it('writes nothing of a chat to the console', async () => {
        const said: unknown[] = []
        const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
        const originals = methods.map((method) => console[method])
        methods.forEach((method) => (console[method] = (...args: unknown[]) => void said.push(...args)))
        try {
          await db.apply({ ...chatPage, cursor: 41 })
          await db.chats()
          await db.chat('anna')
          await db.unreadChatCount()
          await db.waitingOutgoing()
          await db.apply(page({ cursor: 42, deleted: [{ type: 'chatAccount', id: 'acct' }] }))
        } finally {
          methods.forEach((method, index) => (console[method] = originals[index]!))
        }
        expect(said).toEqual([])
      })
    })
  })
}
