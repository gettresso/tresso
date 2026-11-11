import { describe, expect, it, vi } from 'vitest'
import type { ConversationSummary } from './sync/conversation'
import type { SyncedFolder, SyncedMessage, SyncedThread } from './sync/types'
import { currentTriage, triageProgress } from './triage'
import type { MadeTodo, MakeTodoRequest } from './todos'
import { TRIAGE_ROUND, TriageSession, todoOnDo, type TriageNotice, type TriageUndo } from './triageSession'

const folders: SyncedFolder[] = [
  { id: 'inbox', mailAccountId: 'work', name: 'INBOX', displayName: 'Inbox', role: 'inbox' },
  { id: 'archive', mailAccountId: 'work', name: 'Archive', displayName: 'Archive', role: 'archive' },
  { id: 'label', mailAccountId: 'work', name: 'Label', displayName: 'Label', role: 'custom' },
]

interface Mail {
  thread: SyncedThread
  messages: SyncedMessage[]
  placementId: string | null
}

function message(id: string, threadId: string, at: number): SyncedMessage {
  return {
    id,
    mailAccountId: 'work',
    threadId,
    folderIds: ['inbox'],
    subject: threadId,
    from: { address: `${id}@example.test`, name: null },
    recipients: { to: [], cc: [], bcc: [], replyTo: [] },
    snippet: '',
    sentAt: null,
    receivedAt: new Date(at).toISOString(),
    flags: { seen: false, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    smartInboxId: null,
    verdict: null,
    summary: null,
    calendarMethod: null,
    attachmentScan: null,
  }
}

/** The copy and the server at once: what the deps read and change. */
function fakeMail(threadIds: string[]) {
  const mail = new Map<string, Mail>()
  let clock = 1_000_000
  function add(threadId: string, at = (clock += 1000)): void {
    mail.set(threadId, {
      thread: { id: threadId, mailAccountId: 'work', subject: threadId, messageCount: 1, lastMessageAt: new Date(at).toISOString(), smartInboxId: 'info', verdict: 'know', classificationReason: 'direct' },
      messages: [message(`m-${threadId}`, threadId, at)],
      placementId: null,
    })
  }
  // Newest first, like the inbox.
  ;[...threadIds].reverse().forEach((threadId) => add(threadId))

  function summary(entry: Mail): ConversationSummary {
    return {
      threadId: entry.thread.id,
      mailAccountId: 'work',
      subject: entry.thread.subject,
      snippet: '',
      lastMessageAt: Date.parse(entry.thread.lastMessageAt),
      messageCount: entry.messages.length,
      unreadCount: entry.messages.filter((m) => !m.flags.seen).length,
      flagged: false,
      hasAttachments: false,
      attachmentsBlocked: false,
      heldUntil: null,
      batchedAt: null,
      senders: [],
      inbox: entry.messages.some((m) => m.folderIds.includes('inbox')),
      active: true,
      smartInboxId: entry.thread.smartInboxId ?? null,
      verdict: entry.thread.verdict ?? null,
      classificationReason: entry.thread.classificationReason ?? null,
    }
  }
  const inboxNewestFirst = () =>
    [...mail.values()]
      .map(summary)
      .filter((c) => c.inbox)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)

  return { mail, add, summary, inboxNewestFirst }
}

function session(threadIds: string[], options: { handOver?: () => Promise<TriageUndo | null>; afterDo?: () => Promise<TriageUndo | null> } = {}) {
  const fake = fakeMail(threadIds)
  const calls: string[] = []
  const notices: TriageNotice[] = []
  /** Requests wait for this when set, so a test can press keys while one runs. */
  let gate: Promise<void> | null = null
  let seq = 0
  const failPlace = { next: false }
  const failRelease = { next: false }
  /** While set, a release reaches the server but not the copy: the conversation still looks placed here. */
  const lag = { release: false }
  const waiting = vi.fn(async (limit: number) =>
    fake
      .inboxNewestFirst()
      .filter((c) => c.classificationReason !== 'user')
      .slice(0, limit)
      .map((c) => c.threadId),
  )
  const triage = new TriageSession({
    waiting,
    newest: async (limit) => fake.inboxNewestFirst().slice(0, limit),
    summaries: async (ids) => ids.flatMap((id) => (fake.mail.has(id) ? [fake.summary(fake.mail.get(id)!)] : [])),
    thread: async (id) => {
      const entry = fake.mail.get(id)
      return entry === undefined ? null : { thread: { ...entry.thread }, messages: entry.messages.map((m) => ({ ...m, folderIds: [...m.folderIds], flags: { ...m.flags } })) }
    },
    smartInboxes: async () => [
      { id: 'todo', builtin: 'todo' },
      { id: 'info', builtin: 'informational' },
    ],
    folders: async () => folders,
    place: async (threadId, smartInboxId, verdict) => {
      calls.push(`place ${threadId} ${verdict}`)
      if (gate !== null) {
        await gate
      }
      if (failPlace.next) {
        failPlace.next = false
        throw new Error('Try again later.')
      }
      const entry = fake.mail.get(threadId)!
      entry.thread = { ...entry.thread, smartInboxId, verdict, classificationReason: 'user' }
      entry.placementId = `p${++seq}`
      return entry.placementId
    },
    release: async (threadId, placementId) => {
      calls.push(`release ${threadId}`)
      if (failRelease.next) {
        failRelease.next = false
        throw new Error('Try again later.')
      }
      const entry = fake.mail.get(threadId)!
      if (entry.placementId !== placementId) {
        return 'moved'
      }
      if (!lag.release) {
        entry.thread = { ...entry.thread, smartInboxId: 'info', verdict: 'know', classificationReason: 'direct' }
      }
      entry.placementId = null
      return 'released'
    },
    act: async (ids, action) => {
      calls.push(`${action} ${ids.join(',')}`)
      const before: SyncedMessage[] = []
      const after: SyncedMessage[] = []
      for (const entry of fake.mail.values()) {
        for (const m of entry.messages) {
          if (!ids.includes(m.id)) {
            continue
          }
          before.push({ ...m, folderIds: [...m.folderIds] })
          if (action === 'archive') {
            m.folderIds = m.folderIds.filter((id) => id !== 'inbox').concat('archive')
          } else {
            m.flags = { ...m.flags, seen: action === 'markRead' }
          }
          after.push({ ...m, folderIds: [...m.folderIds] })
        }
      }
      return { before, after }
    },
    undoMoves: async (moves) => {
      for (const move of moves) {
        calls.push(`move ${move.messageIds.join(',')} to ${move.folderId}`)
        for (const entry of fake.mail.values()) {
          for (const m of entry.messages) {
            if (move.messageIds.includes(m.id)) {
              m.folderIds = m.folderIds.filter((id) => id !== move.fromFolderId).concat(move.folderId)
            }
          }
        }
      }
      return []
    },
    notify: (notice) => notices.push(notice),
    explain: (error) => (error instanceof Error ? error.message : String(error)),
    hooks: {
      handOver: options.handOver ?? (async () => ({ undo: async () => {} })),
      ...(options.afterDo === undefined ? {} : { afterDo: options.afterDo }),
    },
    changed: () => {},
  })
  return {
    triage,
    fake,
    calls,
    notices,
    waiting,
    failPlace,
    failRelease,
    lag,
    hold() {
      let open!: () => void
      gate = new Promise((resolve) => {
        open = () => {
          gate = null
          resolve()
        }
      })
      return open
    },
  }
}

const current = (triage: TriageSession) => (triage.state === null ? null : currentTriage(triage.state))

/** Decides once the email the round is at shows, as a person does. */
async function decideOnScreen(triage: TriageSession, decision: 'do' | 'delegate' | 'know'): Promise<void> {
  await vi.waitFor(() => expect(triage.conversation?.thread.id).toBe(current(triage)))
  triage.decide(decision)
}

describe('TriageSession', () => {
  it('runs D, K and Z pressed in quick succession in order, dropping none', async () => {
    const { triage, calls, hold } = session(['a', 'b', 'c'])
    await triage.begin()
    const open = hold()

    await decideOnScreen(triage, 'do')
    await decideOnScreen(triage, 'know')
    triage.undo()
    expect(current(triage)).toBe('c')
    open()
    await triage.idle()

    expect(calls).toEqual(['place a do', 'markRead m-a', 'archive m-b', 'markRead m-b', 'move m-b to inbox', 'markUnread m-b'])
    expect(current(triage)).toBe('b')
    expect(triageProgress(triage.state!).counts).toEqual({ do: 1, delegate: 0, know: 0 })
  })

  it('ignores a decision while the next email still loads', async () => {
    const { triage, calls } = session(['a', 'b'])
    await triage.begin()

    triage.decide('know')
    triage.decide('know')
    await triage.idle()

    expect(calls).toEqual(['archive m-a', 'markRead m-a'])
    expect(current(triage)).toBe('b')
  })

  it('archives and reads only the messages shown when the user decided, not a reply that came in since', async () => {
    const { triage, fake, calls, hold } = session(['a', 'b'])
    await triage.begin()
    const open = hold()
    await decideOnScreen(triage, 'do')
    await decideOnScreen(triage, 'know')
    // A reply in b arrives while do on a is still on its way.
    fake.mail.get('b')!.messages.push(message('m-b2', 'b', 2_000_000))
    open()
    await triage.idle()

    expect(calls.filter((call) => call.includes('m-b'))).toEqual(['archive m-b', 'markRead m-b'])
    expect(fake.mail.get('b')!.messages.find((m) => m.id === 'm-b2')).toMatchObject({ folderIds: ['inbox'], flags: { seen: false } })
  })

  it("keeps the decision when what its hook did cannot be taken back, and the mail read as it was", async () => {
    let fail = true
    const { triage, calls, notices } = session(['a', 'b'], {
      afterDo: async () => ({
        undo: async () => {
          if (fail) {
            throw new Error('The todo could not be removed.')
          }
          calls.push('remove todo')
        },
      }),
    })
    await triage.begin()
    await decideOnScreen(triage, 'do')
    await triage.idle()

    triage.undo()
    await triage.idle()

    expect(calls).toEqual(['place a do', 'markRead m-a', 'markUnread m-a', 'markRead m-a'])
    expect(notices.at(-1)?.text).toBe('This could not be undone: The todo could not be removed.')
    expect(current(triage)).toBe('b')

    fail = false
    triage.undo()
    await triage.idle()
    expect(calls.slice(4)).toEqual(['markUnread m-a', 'remove todo', 'release a'])
    expect(current(triage)).toBe('a')
  })

  it('goes on after a decision that failed, and shows that conversation again', async () => {
    const { triage, calls, notices, failPlace } = session(['a', 'b', 'c'])
    await triage.begin()
    failPlace.next = true

    await decideOnScreen(triage, 'do')
    await decideOnScreen(triage, 'know')
    await triage.idle()

    expect(notices.map((n) => n.text)).toEqual(['Try again later.', 'Noted and archived.'])
    expect(calls).toEqual(['place a do', 'archive m-b', 'markRead m-b'])
    expect(current(triage)).toBe('a')
  })

  it("undoes by decision: an old notice's undo leaves a later decision on the same conversation alone", async () => {
    const { triage, calls, notices } = session(['a', 'b'])
    await triage.begin()
    await decideOnScreen(triage, 'do')
    await triage.idle()
    const first = notices[0]!.action!
    first.run()
    await triage.idle()
    await decideOnScreen(triage, 'know')
    await triage.idle()
    calls.length = 0

    first.run()
    await triage.idle()

    expect(calls).toEqual([])
    expect(current(triage)).toBe('b')
  })

  it('does not show conversations decided after an earlier decision that was undone', async () => {
    const { triage, calls, notices } = session(['a', 'b', 'c', 'd'])
    await triage.begin()
    await decideOnScreen(triage, 'do')
    await decideOnScreen(triage, 'know')
    await decideOnScreen(triage, 'know')
    await triage.idle()
    notices[0]!.action!.run()
    await triage.idle()
    expect(current(triage)).toBe('a')
    calls.length = 0

    await decideOnScreen(triage, 'do')
    await triage.idle()

    expect(current(triage)).toBe('d')
    expect(calls).toEqual(['place a do', 'markRead m-a'])
  })

  it('places a handed-over conversation only once the hook says it was handed over, and goes on meanwhile', async () => {
    let handedOver!: (undo: TriageUndo | null) => void
    const { triage, calls } = session(['a', 'b'], {
      handOver: () =>
        new Promise((resolve) => {
          handedOver = resolve
        }),
    })
    await triage.begin()

    await decideOnScreen(triage, 'delegate')
    await decideOnScreen(triage, 'know')
    await vi.waitFor(() => expect(calls).toEqual(['archive m-b', 'markRead m-b']))

    const withdraw = vi.fn(async () => {})
    handedOver({ undo: withdraw })
    await triage.idle()
    expect(calls).toEqual(['archive m-b', 'markRead m-b', 'place a delegate', 'markRead m-a'])

    triage.undo()
    triage.undo()
    await triage.idle()
    expect(withdraw).toHaveBeenCalledOnce()
    expect(calls.slice(4)).toEqual(['move m-b to inbox', 'markUnread m-b', 'markUnread m-a', 'release a'])
  })

  it('leaves no placement when the hand-over is cancelled, and shows the conversation again', async () => {
    const { triage, calls } = session(['a', 'b'], { handOver: async () => null })
    await triage.begin()

    await decideOnScreen(triage, 'delegate')
    await triage.idle()

    expect(calls).toEqual([])
    expect(current(triage)).toBe('a')
    expect(triage.state?.decided).toEqual([])
  })

  it('reports a hand-over that throws and keeps going', async () => {
    const { triage, calls, notices } = session(['a', 'b'], {
      handOver: async () => {
        throw new Error('The forward could not be opened.')
      },
    })
    await triage.begin()

    await decideOnScreen(triage, 'delegate')
    await triage.idle()
    await decideOnScreen(triage, 'know')
    await triage.idle()

    expect(notices[0]?.text).toBe('The forward could not be opened.')
    expect(calls).toEqual(['archive m-a', 'markRead m-a'])
  })

  it('takes back the todo a do made and the read before the placement, so the rules see the mail as it was', async () => {
    const { triage, calls } = session(['a'], {
      afterDo: async () => ({
        undo: async () => {
          calls.push('remove todo')
        },
      }),
    })
    await triage.begin()
    await decideOnScreen(triage, 'do')
    await triage.idle()

    triage.undo()
    await triage.idle()

    expect(calls).toEqual(['place a do', 'markRead m-a', 'markUnread m-a', 'remove todo', 'release a'])
  })

  it('goes on from where an undo stopped when it is tried again', async () => {
    const removeTodo = vi.fn(async () => {})
    const { triage, calls, notices, failRelease } = session(['a'], { afterDo: async () => ({ undo: removeTodo }) })
    await triage.begin()
    await decideOnScreen(triage, 'do')
    await triage.idle()
    failRelease.next = true

    triage.undo()
    await triage.idle()
    expect(notices.at(-1)?.text).toBe('This could not be undone: Try again later.')
    triage.undo()
    await triage.idle()

    expect(removeTodo).toHaveBeenCalledOnce()
    expect(calls.filter((call) => call.startsWith('markUnread'))).toEqual(['markUnread m-a'])
    expect(calls.filter((call) => call.startsWith('release'))).toEqual(['release a', 'release a'])
    expect(current(triage)).toBe('a')
  })

  it('keeps a choice made again elsewhere, and the next undo goes for the decision before', async () => {
    const { triage, fake, calls, notices } = session(['a', 'b', 'c'])
    await triage.begin()
    await decideOnScreen(triage, 'know')
    await decideOnScreen(triage, 'do')
    await triage.idle()
    fake.mail.get('b')!.placementId = 'from another device'

    triage.undo()
    await triage.idle()
    expect(notices.at(-1)?.text).toBe('Undone, but this conversation was moved again since, so it stays where it was moved.')

    triage.undo()
    await triage.idle()
    expect(calls.slice(-2)).toEqual(['move m-a to inbox', 'markUnread m-a'])
    expect(current(triage)).toBe('a')
  })

  it('takes mail arriving during the round in at its end, reading only the round and the newest mail', async () => {
    const { triage, fake, waiting } = session(['a'])
    await triage.begin()
    await decideOnScreen(triage, 'know')
    await triage.idle()
    expect(current(triage)).toBeNull()

    fake.add('new')
    await triage.follow()

    expect(current(triage)).toBe('new')
    expect(waiting).toHaveBeenCalledOnce()
  })

  it('passes over mail decided on another device during the round', async () => {
    const { triage, fake } = session(['a', 'b', 'c'])
    await triage.begin()
    fake.mail.get('b')!.thread.classificationReason = 'user'

    await decideOnScreen(triage, 'do')
    await triage.idle()
    await triage.follow()

    expect(current(triage)).toBe('c')
    expect(triageProgress(triage.state!)).toMatchObject({ shown: 2, total: 2 })
  })

  it('brings an undone conversation back at the end once the copy has synced the undo', async () => {
    const { triage, fake, notices, lag } = session(['a', 'b'])
    await triage.begin()
    await decideOnScreen(triage, 'do')
    await triage.idle()
    lag.release = true

    triage.undo()
    await triage.idle()
    expect(notices.at(-1)?.text).toBe('Undone. The conversation comes back in this round once your mail has synced.')
    expect(current(triage)).toBe('b')

    // The copy syncs.
    const synced = fake.mail.get('a')!
    synced.thread = { ...synced.thread, classificationReason: 'direct' }
    await decideOnScreen(triage, 'know')
    await triage.idle()
    await triage.follow()
    expect(current(triage)).toBe('a')
  })

  it('takes at most a round of conversations and says when more wait', async () => {
    const ids = Array.from({ length: TRIAGE_ROUND + 2 }, (_, i) => `t${i}`)
    const { triage } = session(ids)
    await triage.begin()

    expect(triage.state?.queue).toHaveLength(TRIAGE_ROUND)
    expect(triage.more).toBe(true)
  })
})

describe('todoOnDo', () => {
  const conversation = (froms: string[]) => ({
    thread: { id: 't', mailAccountId: 'work', subject: 's', messageCount: froms.length, lastMessageAt: '2026-10-19T08:00:00Z', smartInboxId: null, verdict: null, classificationReason: null } satisfies SyncedThread,
    messages: froms.map((from, i) => ({ ...message(`m${i}`, 't', 1_000 + i), from: { address: from, name: null } })),
  })
  const made = (made: boolean) => ({ id: 'todo-1', made }) as unknown as MadeTodo

  it("makes the conversation's todo from the newest email someone else sent, once per conversation", async () => {
    const makeFromMessage = vi.fn(async (_id: string, _request: MakeTodoRequest) => made(true))
    const remove = vi.fn(async () => {})
    const hook = todoOnDo({ makeFromMessage, remove, ownAddresses: async () => ['kim@company.example'] })

    const undo = await hook(conversation(['anna@partner.example', 'Kim@Company.example']))

    expect(makeFromMessage).toHaveBeenCalledWith('m0', { perConversation: true })
    await undo?.undo()
    expect(remove).toHaveBeenCalledWith('todo-1')
  })

  it('leaves a todo it did not make alone', async () => {
    const remove = vi.fn(async () => {})
    const hook = todoOnDo({ makeFromMessage: async () => made(false), remove, ownAddresses: async () => [] })

    expect(await hook(conversation(['anna@partner.example']))).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })
})
