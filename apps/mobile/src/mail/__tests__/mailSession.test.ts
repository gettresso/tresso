import { describe, expect, it, vi } from 'vitest'
import { MAX_MESSAGES_PER_ACTION, newDraft, PartialActionError, type ChangePage, type MessageActionRequest, type RealtimeAccess, type SyncedHandOver, type SyncedMessage, type SyncedUnsubscription, type ThreadClassificationRequest, type UnsubscribeRequest } from '@tresso/core'
import { databaseName, MailSession, type MailSessionDeps, type MailState } from '../mailSession'
import { CHAT_BACKFILL, SqliteMailStore } from '@tresso/core'
import type { Sql } from '../sql'
import { memorySql } from '@tresso/core/testing/sql'

const account = { id: 'work', emailAddress: 'kim@company.example', displayName: 'Work', provider: 'imap', status: 'active' as const, statusDetail: null, lastSyncedAt: null, defaultSignatureId: null, calendarStatus: 'unknown' as const, calendarStatusDetail: null }

function page(cursor: number, extra: Partial<ChangePage> = {}): ChangePage {
  return { cursor, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [], ...extra }
}

/** Databases by name, as on a device: deleting one that is open fails, as expo-sqlite does. */
function device() {
  const files = new Map<string, Sql>()
  const open = new Map<string, number>()
  let failDelete = false
  return {
    files,
    open,
    set failDelete(value: boolean) {
      failDelete = value
    },
    async openSql(name: string) {
      if (!files.has(name)) {
        files.set(name, await memorySql())
      }
      open.set(name, (open.get(name) ?? 0) + 1)
      const sql = files.get(name)!
      return {
        ...sql,
        close: async () => {
          open.set(name, (open.get(name) ?? 1) - 1)
        },
      }
    },
    async deleteSql(name: string) {
      if ((open.get(name) ?? 0) > 0) {
        throw new Error(`${name} is open`)
      }
      if (failDelete) {
        throw new Error('disk busy')
      }
      files.delete(name)
    },
  }
}

function session(
  disk: ReturnType<typeof device>,
  fetchPage = async (since: number) => page(since === 0 ? 1 : since, since === 0 ? { mailAccounts: [account] } : {}),
  postAction: (request: MessageActionRequest) => Promise<void> = async () => {},
  postUnsubscribe: (request: UnsubscribeRequest) => Promise<SyncedUnsubscription> = () => Promise.reject(new Error('no unsubscribe in this test')),
  onOverdue?: (handOvers: SyncedHandOver[]) => void,
  classification: Pick<MailSessionDeps, 'classify' | 'release'> = {
    classify: () => Promise.reject(new Error('no classification in this test')),
    release: () => Promise.reject(new Error('no classification in this test')),
  },
  fetchAccess: MailSessionDeps['fetchAccess'] = () => Promise.reject(new Error('no realtime in this test')),
  fetchChatAccounts: MailSessionDeps['fetchChatAccounts'] = async () => [],
) {
  const states: MailState[] = []
  const mail = new MailSession({
    openSql: (name) => disk.openSql(name),
    deleteSql: (name) => disk.deleteSql(name),
    fetchPage,
    fetchAccess,
    fetchChatAccounts,
    postAction,
    postUnsubscribe,
    ...classification,
    drafts: {
      create: () => Promise.reject(new Error('no drafts in this test')),
      update: () => Promise.reject(new Error('no drafts in this test')),
      get: () => Promise.reject(new Error('no drafts in this test')),
      remove: () => Promise.reject(new Error('no drafts in this test')),
      attach: () => Promise.reject(new Error('no drafts in this test')),
      forward: () => Promise.reject(new Error('no drafts in this test')),
      detach: () => Promise.reject(new Error('no drafts in this test')),
      unscannedLink: () => Promise.reject(new Error('no drafts in this test')),
    },
    onState: (state) => states.push(state),
    onOverdue,
  })
  return { mail, states, last: () => states[states.length - 1]! }
}

describe('MailSession', () => {
  describe('after the update that added chats', () => {
    /** A copy synced up to cursor 5 and marked by the update, as version 10 leaves a version 9 copy. */
    async function markedCopy(disk: ReturnType<typeof device>): Promise<void> {
      const sql = await disk.openSql(databaseName('kim'))
      const store = await SqliteMailStore.open(sql)
      await store.apply(page(5, { mailAccounts: [account] }))
      await store.setChatMeta(CHAT_BACKFILL, '1')
      await store.close()
    }

    function run(chatAccounts: MailSessionDeps['fetchChatAccounts']) {
      const disk = device()
      const asked: number[] = []
      const fetchPage = async (since: number) => {
        asked.push(since)
        return page(since === 0 ? 7 : since, since === 0 ? { mailAccounts: [account] } : {})
      }
      return { disk, asked, open: () => session(disk, fetchPage, undefined, undefined, undefined, undefined, undefined, chatAccounts) }
    }

    it('goes on from its cursor when the server holds no chat account, and asks only once', async () => {
      let checks = 0
      const { disk, asked, open } = run(async () => (checks++, []))
      await markedCopy(disk)
      const { mail, last } = open()

      await mail.switchTo('kim')
      await vi.waitFor(() => expect(last()).toMatchObject({ synced: true }))

      expect(checks).toBe(1)
      expect(asked[0]).toBe(5)
      expect(await mail.database!.chatMeta(CHAT_BACKFILL)).toBeNull()
      expect(last().status.text).not.toContain('after the update')
    })

    it('syncs from the start when the server holds a chat account', async () => {
      const { disk, asked, open } = run(async () => [{ id: 'acct' }])
      await markedCopy(disk)
      const { mail, last } = open()

      await mail.switchTo('kim')
      await vi.waitFor(() => expect(last()).toMatchObject({ synced: true }))

      expect(asked[0]).toBe(0)
      expect(await mail.database!.chatMeta(CHAT_BACKFILL)).toBeNull()
    })

    it('keeps the mark for the next start when the check fails, and syncs on anyway', async () => {
      const error = console.error
      console.error = () => undefined
      try {
        const { disk, asked, open } = run(() => Promise.reject(new TypeError('Network request failed')))
        await markedCopy(disk)
        const { mail, last } = open()

        await mail.switchTo('kim')
        await vi.waitFor(() => expect(last()).toMatchObject({ synced: true }))

        expect(asked[0]).toBe(5)
        expect(await mail.database!.chatMeta(CHAT_BACKFILL)).toBe('1')
      } finally {
        console.error = error
      }
    })
  })

  it("opens the user's copy, syncs it, and deletes it on sign-out only after closing it", async () => {
    const disk = device()
    const { mail, last } = session(disk)

    await mail.switchTo('kim')
    expect(last()).toMatchObject({ userId: 'kim', ready: true })
    await vi.waitFor(async () => expect((await mail.database?.mailAccounts())?.map((a) => a.id)).toEqual(['work']))
    await vi.waitFor(() => expect(last().syncState).toBe('idle'))

    await mail.switchTo(null)
    expect(last()).toMatchObject({ userId: null, ready: false })
    expect(disk.files.has(databaseName('kim'))).toBe(false)
    expect(mail.database).toBeNull()
  })

  it('says how far the first sync of the phone got, and when it is done, in the words of the other clients', async () => {
    const disk = device()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const fetchPage = async (since: number) => {
      if (since === 0) {
        return { ...page(500, { hasMore: true, mailAccounts: [account] }), latest: 1000 }
      }
      await held
      return { ...page(1000), latest: 1000 }
    }
    const { mail, last, states } = session(disk, fetchPage)

    await mail.switchTo('kim')
    await vi.waitFor(() => expect(last().status.text).toBe('Getting your mail, 50%'))
    expect(last().status).toMatchObject({ kind: 'firstSync', fraction: 0.5 })
    expect(states.map((state) => state.status.text)).toContain('Opening your mail…')

    release()
    // No realtime in this test: up to date, but not live.
    await vi.waitFor(() => expect(last().status.kind).toBe('connecting'))
    expect(last().status.text).toBe('Connecting…')

    await mail.switchTo(null)
    expect(last().status).toMatchObject({ kind: 'closed', text: '' })
  })

  it('says the sync stopped when a pull fails, and when the phone last synced once it opens again', async () => {
    const disk = device()
    const first = session(disk)
    await first.mail.switchTo('kim')
    await vi.waitFor(() => expect(first.last().syncState).toBe('idle'))
    await first.mail.closeCopy()

    const second = session(disk, () => Promise.reject(new Error('Network down')))
    await second.mail.switchTo('kim')
    await vi.waitFor(() => expect(second.last().status.kind).toBe('error'))
    expect(second.last().status.text).toMatch(/^Sync stopped\. Last synced /)
    await second.mail.switchTo(null)
  })

  it('says the sync stopped, not "Opening your mail…" for good, when the copy cannot be opened', async () => {
    const disk = device()
    const openSql = disk.openSql.bind(disk)
    const failing = { ...disk, openSql: async (name: string) => (name === databaseName('kim') ? Promise.reject(new Error('disk full')) : openSql(name)) }
    const { mail, last } = session(failing as unknown as ReturnType<typeof device>)

    await mail.switchTo('kim')

    expect(last().status).toMatchObject({ kind: 'error', problem: 'Sync stopped: disk full' })
    expect(last().syncError).toBe('disk full')
  })

  it('aborts a realtime token request under way at sign-out, so removing the copy does not wait for it', async () => {
    const disk = device()
    let signal: AbortSignal | null = null
    // A token request that never answers until it is aborted, as fetch does.
    const hanging = (aborted: AbortSignal) =>
      new Promise<RealtimeAccess>((_resolve, reject) => {
        signal = aborted
        aborted.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    const { mail, last } = session(disk, undefined, undefined, undefined, undefined, undefined, hanging)
    await mail.switchTo('kim')
    await vi.waitFor(() => expect(signal).not.toBeNull())

    const outcome = await Promise.race([mail.switchTo(null).then(() => 'signed out'), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500))])

    expect(outcome).toBe('signed out')
    expect(signal!.aborted).toBe(true)
    expect(last()).toMatchObject({ userId: null })
    expect(disk.files.has(databaseName('kim'))).toBe(false)
  })

  it("never shows one user's copy to the next, and removes it", async () => {
    const disk = device()
    const { mail } = session(disk)
    await mail.switchTo('kim')

    await mail.switchTo('lisa')

    expect(disk.files.has(databaseName('kim'))).toBe(false)
    expect(disk.files.has(databaseName('lisa'))).toBe(true)
  })

  it('leaves nothing behind when signed out while the copy was still opening', async () => {
    const disk = device()
    let release: () => void = () => {}
    const slow = session(disk, (since) => (since === 0 ? new Promise<ChangePage>((resolve) => (release = () => resolve(page(1, { mailAccounts: [account] })))) : Promise.resolve(page(since))))

    const opening = slow.mail.switchTo('kim')
    await vi.waitFor(() => expect(disk.files.has(databaseName('kim'))).toBe(true))
    // The first pull is still on its way: signing out does not wait for it.
    await opening
    await slow.mail.switchTo(null)
    release()

    expect(disk.files.has(databaseName('kim'))).toBe(false)
    expect(slow.last()).toMatchObject({ userId: null, ready: false })
  })

  it('removes a copy that could not go before, the next time', async () => {
    const disk = device()
    const first = session(disk)
    await first.mail.switchTo('kim')
    disk.failDelete = true
    await first.mail.switchTo(null)
    expect(disk.files.has(databaseName('kim'))).toBe(true)
    expect(first.last().syncError).toContain('could not be removed yet')

    disk.failDelete = false
    const afterRestart = session(disk)
    await afterRestart.mail.switchTo(null)

    expect(disk.files.has(databaseName('kim'))).toBe(false)
  })

  it('an expired session closes the copy and keeps its file, with the drafts in it, for the next sign-in', async () => {
    const disk = device()
    const first = session(disk)
    await first.mail.switchTo('kim')
    await first.mail.database!.saveDraft({ ...newDraft('new', 'work', null, 'draft-1'), subject: 'Not sent yet', pendingSave: true })

    await first.mail.closeCopy()

    expect(first.last()).toMatchObject({ userId: null, ready: false })
    expect(first.mail.database).toBeNull()
    expect(disk.files.has(databaseName('kim'))).toBe(true)
    expect(disk.open.get(databaseName('kim'))).toBe(0)

    const again = session(disk)
    await again.mail.closeCopy()
    expect(disk.files.has(databaseName('kim'))).toBe(true)
    await again.mail.switchTo('kim')
    expect(again.last()).toMatchObject({ userId: 'kim', ready: true })
    expect((await again.mail.database!.drafts()).map((draft) => draft.subject)).toEqual(['Not sent yet'])
    await again.mail.switchTo(null)
  })

  it('removes a copy a sign-out or switch could not remove when the next launch has nobody signed in, and keeps an expired one', async () => {
    const disk = device()
    const first = session(disk)
    await first.mail.switchTo('kim')
    disk.failDelete = true
    await first.mail.switchTo('lisa')
    // Lisa's sign-in expires: her copy stays, Kim's still could not go.
    await first.mail.closeCopy()
    expect(disk.files.has(databaseName('kim'))).toBe(true)

    disk.failDelete = false
    const afterRestart = session(disk)
    await afterRestart.mail.closeCopy()

    expect(disk.files.has(databaseName('kim'))).toBe(false)
    expect(disk.files.has(databaseName('lisa'))).toBe(true)
  })

  it('unmarks a copy that could not be removed when its user opens it again, so it is kept', async () => {
    const disk = device()
    const { mail } = session(disk)
    await mail.switchTo('kim')
    disk.failDelete = true
    await mail.switchTo('lisa')
    await mail.switchTo('kim')
    disk.failDelete = false

    // Kim's sign-in expires: Lisa's copy, still marked, goes; Kim's, open again, stays.
    await mail.closeCopy()

    expect(disk.files.has(databaseName('kim'))).toBe(true)
    expect(disk.files.has(databaseName('lisa'))).toBe(false)
  })

  it('counts the pulls that completed, so a screen knows a missing conversation is really gone', async () => {
    const disk = device()
    const fetchPage = vi.fn(async (since: number) => page(since === 0 ? 1 : since, since === 0 ? { mailAccounts: [account] } : {}))
    const { mail, last } = session(disk, fetchPage)
    await mail.switchTo('kim')
    await vi.waitFor(() => expect(last().pulls).toBeGreaterThan(0))
    const before = last().pulls

    await mail.syncNow()

    expect(last().pulls).toBe(before + 1)
    await mail.switchTo(null)
  })

  it('rests the connection in the background and catches up in front', async () => {
    const disk = device()
    const fetchPage = vi.fn(async (since: number) => page(since === 0 ? 1 : since, since === 0 ? { mailAccounts: [account] } : {}))
    const { mail, last } = session(disk, fetchPage)
    await mail.switchTo('kim')
    await vi.waitFor(() => expect(last().syncState).toBe('idle'))
    const pulls = fetchPage.mock.calls.length

    mail.setForeground(false)
    expect(last().live).toBe(false)
    mail.setForeground(true)
    await vi.waitFor(() => expect(fetchPage.mock.calls.length).toBeGreaterThan(pulls))
    await mail.switchTo(null)
  })

  it('shows an action at once, sends it in batches, and puts back only what the server did not take', async () => {
    const disk = device()
    const ids = Array.from({ length: MAX_MESSAGES_PER_ACTION + 2 }, (_, i) => `m${i}`)
    const message = (id: string): SyncedMessage => ({
      id,
      mailAccountId: 'work',
      threadId: `t-${id}`,
      folderIds: ['inbox'],
      subject: '',
      from: { address: 'a@example.test', name: null },
      recipients: { to: [], cc: [], bcc: [], replyTo: [] },
      snippet: '',
      sentAt: null,
      receivedAt: '2026-10-19T08:00:00Z',
      flags: { seen: false, flagged: false, answered: false, draft: false },
      hasAttachments: false,
      attachmentScan: null,
      smartInboxId: null,
      verdict: null,
      summary: null,
      calendarMethod: null,
    })
    const requests: MessageActionRequest[] = []
    const { mail } = session(
      disk,
      async (since) =>
        since === 0
          ? page(1, {
              mailAccounts: [account],
              folders: [{ id: 'inbox', mailAccountId: 'work', name: 'INBOX', displayName: 'Inbox', role: 'inbox' }],
              threads: ids.map((id) => ({ id: `t-${id}`, mailAccountId: 'work', subject: '', messageCount: 1, lastMessageAt: '2026-10-19T08:00:00Z', smartInboxId: null, verdict: null, classificationReason: null })),
              messages: ids.map(message),
            })
          : page(since),
      async (request) => {
        requests.push(request)
        if (requests.length === 2) {
          throw new Error('Try again later.')
        }
      },
    )
    await mail.switchTo('kim')
    await vi.waitFor(async () => expect((await mail.database?.inbox(null, 1000))?.length).toBe(ids.length))

    const failure = await mail.act(ids, 'markRead').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PartialActionError)
    expect((failure as PartialActionError).rejected).toBe(2)
    expect(requests.map((r) => r.messageIds.length)).toEqual([MAX_MESSAGES_PER_ACTION, 2])
    const seen = async (id: string) => (await mail.database?.thread(`t-${id}`))?.messages[0]?.flags.seen
    expect(await seen('m0')).toBe(true)
    expect(await seen(`m${MAX_MESSAGES_PER_ACTION}`)).toBe(false)
    await mail.switchTo(null)
  })

  it('says so when a refused change cannot be put back, and syncs the copy from the start to put it right', async () => {
    const disk = device()
    const since: number[] = []
    const { mail } = session(
      disk,
      async (from) => {
        since.push(from)
        return page(from === 0 ? 1 : from, from === 0 ? { mailAccounts: [account] } : {})
      },
      async () => {
        throw new Error('Try again later.')
      },
    )
    await mail.switchTo('kim')
    await vi.waitFor(async () => expect(await mail.database?.cursor()).toBe(1))
    vi.spyOn(mail.database!, 'revertAction').mockRejectedValue(new Error('disk full'))
    since.length = 0

    await expect(mail.act(['m1'], 'markRead')).rejects.toThrow('Try again later. This phone shows the change until it has synced your mail again.')

    await vi.waitFor(() => expect(since).toContain(0))
    await mail.switchTo(null)
  })

  it('refuses an action while no copy is open, instead of pretending it worked', async () => {
    const { mail } = session(device())

    await expect(mail.act(['m1'], 'archive')).rejects.toThrow('Your mail is not open on this phone yet.')
  })

  it('unsubscribes from a conversation: the button goes at once and spam is never offered', async () => {
    const disk = device()
    const newsletter = (id: string, threadId: string): SyncedMessage => ({
      id,
      mailAccountId: 'work',
      threadId,
      folderIds: ['inbox'],
      subject: 'Deals',
      from: { address: 'news@shop.example', name: 'Shop' },
      recipients: { to: [], cc: [], bcc: [], replyTo: [] },
      snippet: '',
      sentAt: null,
      receivedAt: '2026-10-19T08:00:00Z',
      flags: { seen: false, flagged: false, answered: false, draft: false },
      hasAttachments: false,
      attachmentScan: null,
      smartInboxId: null,
      verdict: null,
      summary: null,
      calendarMethod: null,
      unsubscribe: 'oneClick',
    })
    const thread = (id: string, smartInboxId: string | null) => ({ id, mailAccountId: 'work', subject: 'Deals', messageCount: 1, lastMessageAt: '2026-10-19T08:00:00Z', smartInboxId, verdict: null, classificationReason: null })
    const requests: UnsubscribeRequest[] = []
    const { mail } = session(
      disk,
      async (since) =>
        since === 0
          ? page(1, {
              mailAccounts: [account],
              smartInboxes: [{ id: 'spam', builtin: 'spam', name: 'Spam', instructions: '', includeSenders: [], excludeSenders: [], verdict: 'none', autoCreateTodo: false, position: 4 }],
              threads: [thread('t1', null), thread('t2', 'spam')],
              messages: [newsletter('m1', 't1'), newsletter('m2', 't2')],
            })
          : page(since),
      undefined,
      async (request) => {
        requests.push(request)
        return { id: 'u1', mailAccountId: 'work', sender: 'news@shop.example', method: 'oneClick', status: 'pending', error: null, requestedAt: '2026-10-19T12:00:00Z', completedAt: null }
      },
    )
    await mail.switchTo('kim')
    await vi.waitFor(async () => expect((await mail.unsubscribeOffer('t1'))?.state).toBe('available'))
    expect(await mail.unsubscribeOffer('t2')).toBeNull()

    await mail.unsubscribe('m1')

    expect(requests).toEqual([{ messageId: 'm1' }])
    expect(await mail.unsubscribeOffer('t1')).toEqual({ state: 'pending', sender: 'news@shop.example' })
  })

  it('refuses to unsubscribe while no copy is open', async () => {
    const { mail } = session(device())

    await expect(mail.unsubscribe('m1')).rejects.toThrow('Your mail is not open on this phone yet.')
  })

  it('tells about the overdue notices the server delivers, each once, but not about those the first pull brings', async () => {
    const handOver = (id: string, notifiedAt: string | null): SyncedHandOver => ({
      id,
      mailAccountId: 'work',
      messageId: null,
      threadId: null,
      subject: `Subject ${id}`,
      delegate: { address: 'lisa@company.example', name: null },
      note: '',
      dueAt: '2026-10-23T15:00:00Z',
      state: 'open',
      forwardId: null,
      overdueAt: notifiedAt,
      notifiedAt,
      notifiedChannels: notifiedAt === null ? [] : ['phone'],
      notifiedSilently: false,
      nudgedAt: null,
      lastNudgeId: null,
      replyMessageId: null,
      createdAt: '2026-10-20T08:00:00Z',
      closedAt: null,
      updatedAt: '2026-10-20T08:00:00Z',
    })
    const told: string[][] = []
    const delivered = new Date().toISOString()
    const disk = device()
    const { mail, last } = session(
      disk,
      async (since) =>
        since === 0
          ? page(1, { mailAccounts: [account], handOvers: [handOver('old', '2026-10-01T15:00:00Z'), handOver('new', null)] })
          : since === 1
            ? page(2, { handOvers: [handOver('new', delivered)] })
            : since === 2
              ? page(3, { handOvers: [{ ...handOver('new', delivered), nudgedAt: delivered }] })
              : page(since),
      async () => {},
      undefined,
      (handOvers) => told.push(handOvers.map((h) => h.id)),
    )

    await mail.switchTo('kim')
    await vi.waitFor(async () => expect((await mail.database?.handOvers())?.length).toBe(2))
    await vi.waitFor(() => expect(last().syncState).toBe('idle'))
    expect(told).toEqual([])

    await mail.syncNow()
    expect(told).toEqual([['new']])

    // The same notice again, with something else changed on the hand-over: told once.
    await mail.syncNow()
    expect(told).toEqual([['new']])
    expect((await mail.database!.handOvers()).map((h) => h.id).sort()).toEqual(['new', 'old'])
    await mail.switchTo(null)
  })

  it('keeps the daily brief on the phone with its conversations as they are now', async () => {
    const thread = { id: 't1', mailAccountId: 'work', subject: 'Release notes', messageCount: 1, lastMessageAt: '2026-10-20T07:00:00Z', smartInboxId: 'info', verdict: 'know' as const, classificationReason: 'mailing_list' }
    const message: SyncedMessage = {
      id: 'm1',
      mailAccountId: 'work',
      threadId: 't1',
      folderIds: ['inbox'],
      subject: 'Release notes',
      from: { address: 'news@lists.example', name: null },
      recipients: { to: [], cc: [], bcc: [], replyTo: [] },
      snippet: 'Version 2 is out',
      sentAt: null,
      receivedAt: '2026-10-20T07:00:00Z',
      flags: { seen: false, flagged: false, answered: false, draft: false },
      hasAttachments: false,
      smartInboxId: 'info',
      verdict: 'know',
      summary: null,
      calendarMethod: null,
      attachmentScan: null,
    }
    const brief = { id: 'b1', coversFrom: '2026-10-19T08:00:00Z', coversUntil: '2026-10-20T07:59:59Z', threadIds: ['t1'], createdAt: '2026-10-20T08:00:00Z' }
    const { mail, last } = session(device(), async (since) =>
      since === 0
        ? page(1, { mailAccounts: [account], folders: [{ id: 'inbox', mailAccountId: 'work', name: 'INBOX', displayName: 'Inbox', role: 'inbox' }], threads: [thread], messages: [message], dailyBriefs: [brief] })
        : page(since),
    )

    await mail.switchTo('kim')
    await vi.waitFor(() => expect(last().syncState).toBe('idle'))

    const database = mail.database!
    expect(await database.dailyBriefs()).toEqual([brief])
    const conversations = await database.conversations(brief.threadIds)
    expect(conversations.map((conversation) => [conversation.subject, conversation.snippet, conversation.inbox])).toEqual([['Release notes', 'Version 2 is out', true]])
    await mail.switchTo(null)
  })

  describe('triage placements', () => {
    const inbox = { id: 'inbox', mailAccountId: 'work', name: 'INBOX', displayName: 'Inbox', role: 'inbox' as const }
    const thread = { id: 't1', mailAccountId: 'work', subject: 'Budget', messageCount: 1, lastMessageAt: '2026-10-19T08:00:00Z', smartInboxId: 'info', verdict: 'know' as const, classificationReason: 'copied' }
    const message: SyncedMessage = {
      id: 'm1',
      mailAccountId: 'work',
      threadId: 't1',
      folderIds: ['inbox'],
      subject: 'Budget',
      from: { address: 'anna@partner.example', name: null },
      recipients: { to: [], cc: [], bcc: [], replyTo: [] },
      snippet: '',
      sentAt: null,
      receivedAt: '2026-10-19T08:00:00Z',
      flags: { seen: false, flagged: false, answered: false, draft: false },
      hasAttachments: false,
      smartInboxId: 'info',
      verdict: 'know',
      summary: null,
      calendarMethod: null,
      attachmentScan: null,
    }
    const smartInboxes = ['todo', 'info'].map((id, position) => ({ id, builtin: null, name: id, instructions: '', includeSenders: [], excludeSenders: [], verdict: 'know' as const, autoCreateTodo: false, position }))

    function triageSession(server: { refuse?: boolean; released?: ChangePage }) {
      const requests: { threadId: string; request?: ThreadClassificationRequest; placementId?: string }[] = []
      let released: ChangePage | null = null
      const { mail } = session(
        device(),
        async (since) => {
          if (since === 0) {
            return page(1, { mailAccounts: [account], folders: [inbox], smartInboxes, threads: [thread], messages: [message] })
          }
          return released !== null && since < released.cursor ? released : page(since)
        },
        undefined,
        undefined,
        undefined,
        {
          classify: async (threadId, request) => {
            requests.push({ threadId, request })
            if (server.refuse === true) {
              throw new Error('Try again later.')
            }
            return { threadId, smartInboxId: request.smartInboxId, verdict: request.verdict ?? 'know', reason: 'user', senderRule: null, placementId: 'p1' }
          },
          release: async (threadId, placementId) => {
            requests.push({ threadId, placementId })
            released = server.released ?? null
            return 'released'
          },
        },
      )
      return { mail, requests }
    }

    async function placement(mail: MailSession) {
      const stored = await mail.database?.thread('t1')
      return [stored?.thread.smartInboxId, stored?.thread.verdict, stored?.thread.classificationReason]
    }

    it('says when the first pull is over, also when it failed', async () => {
      const disk = device()
      let fail = true
      const { mail, last } = session(disk, async (since) => {
        if (fail) {
          throw new Error('offline')
        }
        return page(since === 0 ? 1 : since)
      })

      await mail.switchTo('kim')
      expect(last()).toMatchObject({ ready: true })
      await vi.waitFor(() => expect(last()).toMatchObject({ synced: true, syncState: 'error' }))
      fail = false
      await mail.switchTo(null)
      expect(last()).toMatchObject({ ready: false, synced: false })
    })

    it('shows a placement for this conversation only at once', async () => {
      const { mail, requests } = triageSession({})
      await mail.switchTo('kim')
      await vi.waitFor(async () => expect(await mail.database?.cursor()).toBe(1))

      await mail.classifyThread('t1', 'info', 'do', false)

      expect(requests).toEqual([{ threadId: 't1', request: { smartInboxId: 'info', verdict: 'do', remember: false } }])
      expect(await placement(mail)).toEqual(['info', 'do', 'user'])
      await mail.switchTo(null)
    })

    it('puts a refused placement back', async () => {
      const { mail } = triageSession({ refuse: true })
      await mail.switchTo('kim')
      await vi.waitFor(async () => expect(await mail.database?.cursor()).toBe(1))

      await expect(mail.classifyThread('t1', 'todo', 'delegate', false)).rejects.toThrow('Try again later.')

      expect(await placement(mail)).toEqual(['info', 'know', 'copied'])
      await mail.switchTo(null)
    })

    it('takes a placement back and shows where the rules put it once pulled', async () => {
      const { mail, requests } = triageSession({ released: page(2, { threads: [thread] }) })
      await mail.switchTo('kim')
      await vi.waitFor(async () => expect(await mail.database?.cursor()).toBe(1))
      await mail.classifyThread('t1', 'info', 'do', false)

      expect(await mail.releaseThread('t1', 'p1')).toBe('released')

      expect(requests[1]).toEqual({ threadId: 't1', placementId: 'p1' })
      expect(await placement(mail)).toEqual(['info', 'know', 'copied'])
      await mail.switchTo(null)
    })
  })
})
