import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { fetch as streamingFetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import {
  type AppliedAction,
  type ChangePage,
  type Contact,
  type DraftAttachmentLink,
  type DraftSync,
  type HandOverApi,
  type SyncedHandOver,
  type SendMessageRequest,
  type SqliteMailStore,
  type SyncedDraft,
  type SyncedOutgoingMessage,
  type SyncedSignature,
  type ConversationSummary,
  type MessageAction,
  type MessageBody,
  type RealtimeAccess,
  type SyncedFolder,
  type SyncedMailAccount,
  type SyncedMessage,
  type SyncedSmartInbox,
  type SyncedThread,
  type SyncedTodo,
  type SyncedUnsubscription,
  type MadeTodo,
  type MakeTodoRequest,
  type ThreadClassification,
  type Verdict,
  needsTriage,
} from '@tresso/core'
import { useAuth } from '@/auth/AuthProvider'
import { ApiError } from '@/auth/session'
import { LAST_USER } from '@/auth/secureTokenStore'
import { MailSession, type MailState } from '@/mail/mailSession'
import { deleteSql, openSql } from '@/mail/sql'
import { todoApi } from '@/mail/todoApi'

const LIST_LIMIT = 200
const UNIFIED_INBOX = { kind: 'inbox', mailAccountId: null } as const
/** Wait before asking again who is signed in, after that failed (offline at start, server down). */
const ME_RETRY_MS = 10_000

interface Mail extends MailState {
  mailAccounts(): Promise<SyncedMailAccount[]>
  folders(): Promise<SyncedFolder[]>
  /**
   * Reads, flags, archives, trashes or moves messages: the change shows at once and is undone for the messages the
   * server did not take. Large selections go in batches. Returns the messages before and after, for an undo.
   */
  act(messageIds: string[], action: MessageAction, target?: { folderId?: string; fromFolderId?: string }): Promise<AppliedAction>
  inbox(mailAccountId: string | null): Promise<ConversationSummary[]>
  /** Up to `limit` conversations of the inboxes waiting for triage, newest first. */
  triageWaiting(limit: number): Promise<string[]>
  /** The newest `limit` conversations of the inboxes. */
  newestInInbox(limit: number): Promise<ConversationSummary[]>
  /** The stored summaries of these conversations. */
  summaries(threadIds: string[]): Promise<ConversationSummary[]>
  smartInboxes(): Promise<SyncedSmartInbox[]>
  /** Puts a conversation in a smart inbox with a verdict; see {@link MailSession.classifyThread}. */
  classifyThread(threadId: string, smartInboxId: string, verdict: Verdict, remember: boolean): Promise<ThreadClassification>
  /** Takes back the user's placement of a conversation; see {@link MailSession.releaseThread}. */
  releaseThread(threadId: string, placementId: string): Promise<'released' | 'moved'>
  thread(threadId: string): Promise<{ thread: SyncedThread; messages: SyncedMessage[] } | null>
  body(messageId: string, allowRemoteContent: boolean): Promise<MessageBody>
  /** A link to a received file that could not be scanned, once the user confirmed they accept that. */
  unscannedLink(attachmentId: string): Promise<string>
  syncNow(): Promise<void>
  /** The time on the server's clock (epoch ms), for send times it keeps such as the undo window; see ServerClock. */
  serverNow?(): number
  /** The open copy, for writing mail; null while none is open. */
  store(): SqliteMailStore | null
  drafts: DraftSync
  signatures(): Promise<SyncedSignature[]>
  /** People the user exchanged mail with, whose address or name starts with the query. */
  suggestContacts(query: string): Promise<Contact[]>
  /** POST /api/v1/outgoing-messages */
  send(request: SendMessageRequest): Promise<SyncedOutgoingMessage>
  /** Stops a message that has not gone out yet. */
  cancelOutgoing(id: string): Promise<SyncedOutgoingMessage>
  /** The copy changed outside the sync (a draft written here): screens read it again. */
  touch(): void
  /** Open todos in the user's order, then done ones. */
  todos(): Promise<SyncedTodo[]>
  /** The todos made from the emails of a thread. */
  todosOfThread(threadId: string): Promise<SyncedTodo[]>
  /** The messages with these ids the phone has, e.g. the emails todos link to. */
  messages(ids: string[]): Promise<SyncedMessage[]>
  /** Makes a todo from an email, or returns the one it has (`made` says which); the copy is pulled right after. */
  makeTodo(messageId: string, request?: MakeTodoRequest): Promise<MadeTodo>
  /** Removes a todo; one that is gone already counts as removed. The copy is pulled right after. */
  removeTodo(id: string): Promise<void>
  /** Checks a todo off or opens it again; the copy is pulled right after. */
  setTodoDone(id: string, done: boolean): Promise<void>
  /** Plans a todo at the earliest free time before it is due (again); the copy is pulled right after. */
  planTodo(id: string): Promise<void>
  /** Gives the time a todo holds in the calendar back; the copy is pulled right after. */
  unplanTodo(id: string): Promise<void>
  /** Every hand-over, in "Waiting on" order. */
  handOvers(): Promise<SyncedHandOver[]>
  outgoing(id: string): Promise<SyncedOutgoingMessage | null>
  /** /api/v1/hand-overs */
  handOverApi: HandOverApi
  /** Hand-overs that became overdue and were not told about yet. */
  overdue: SyncedHandOver[]
  /** These were told about. */
  clearOverdue(ids: string[]): void
  /** Answers an invitation (POST /api/v1/calendar-events/{id}/response): the series, or one occurrence. */
  respond(eventId: string, response: 'accepted' | 'tentative' | 'declined', recurrenceId: string | null): Promise<void>
}

function json(method: string, body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

const MailContext = createContext<Mail | null>(null)

/**
 * The signed-in user's mail on the device (see {@link MailSession}): screens read from the copy only. Signing out
 * closes the copy and removes it; a sign-in that expired closes it and keeps it for the next sign-in.
 */
export function MailProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const [state, setState] = useState<MailState>({ userId: null, ready: false, synced: false, version: 0, syncState: 'idle', syncError: null, live: false, pulls: 0 })
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [overdue, setOverdue] = useState<SyncedHandOver[]>([])
  const session = useMemo(
    () =>
      new MailSession({
        openSql,
        deleteSql,
        fetchPage: (since, limit) => auth.session.api<ChangePage>(`/api/v1/sync/changes?since=${since}&limit=${limit}`),
        fetchAccess: () => auth.session.api<RealtimeAccess>('/api/v1/realtime/token'),
        serverNow: () => auth.session.serverNow(),
        postAction: async (request) => {
          await auth.session.api('/api/v1/message-actions', json('POST', request))
        },
        postUnsubscribe: (request) => auth.session.api<SyncedUnsubscription>('/api/v1/unsubscriptions', json('POST', request)),
        classify: (threadId, request) => auth.session.api<ThreadClassification>(`/api/v1/threads/${encodeURIComponent(threadId)}/classification`, json('PUT', request)),
        release: async (threadId, placementId) => {
          try {
            await auth.session.api(`/api/v1/threads/${encodeURIComponent(threadId)}/classification?${new URLSearchParams({ placementId }).toString()}`, json('DELETE'))
            return 'released'
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              return 'moved'
            }
            throw error
          }
        },
        drafts: {
          create: (id, request) => auth.session.api<SyncedDraft>('/api/v1/drafts', json('POST', { ...request, draftId: id })),
          update: (id, request, expectedVersion) => auth.session.api<SyncedDraft>(`/api/v1/drafts/${encodeURIComponent(id)}`, json('PUT', { ...request, expectedVersion })),
          get: (id) => auth.session.api<SyncedDraft & { attachments: DraftAttachmentLink[] }>(`/api/v1/drafts/${encodeURIComponent(id)}`),
          remove: async (id) => {
            await auth.session.api(`/api/v1/drafts/${encodeURIComponent(id)}`, json('DELETE'))
          },
          attach: (id, file) => {
            // React Native's FormData reads the picked file from its URI; fetch sets the multipart boundary.
            const form = new FormData()
            form.append('file', file.body as unknown as Blob)
            return auth.session.api<DraftAttachmentLink>(`/api/v1/drafts/${encodeURIComponent(id)}/attachments`, { method: 'POST', body: form })
          },
          forward: (id, attachmentId) => auth.session.api<DraftAttachmentLink>(`/api/v1/drafts/${encodeURIComponent(id)}/forwarded-attachments`, json('POST', { attachmentId })),
          detach: (id, attachmentId) => auth.session.api<{ draftVersion: number }>(`/api/v1/drafts/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, json('DELETE')),
          unscannedLink: (attachmentId) => auth.session.api<{ url: string }>(`/api/v1/draft-attachments/${encodeURIComponent(attachmentId)}/unscanned-link`, json('POST', { confirmed: true })),
        },
        // expo/fetch streams response bodies, which the realtime connection reads.
        fetch: streamingFetch as unknown as typeof fetch,
        onState: setState,
        onOverdue: (handOvers) => setOverdue((told) => [...told, ...handOvers]),
        foreground: AppState.currentState === 'active',
      }),
    [auth.session],
  )

  // Who is signed in decides whose copy is open. After a launch the last known user's copy opens at once, so mail on
  // the device shows offline too; the server then confirms who it is (asked again until it answers), and a different
  // answer switches to that user's copy, which removes the other. Only a sign-out the user asked for removes the copy
  // when nobody is signed in: an expired sign-in, or one that could not be read, closes it and keeps it on the phone,
  // with the drafts that did not reach the server yet.
  useEffect(() => {
    if (auth.restoring) {
      return
    }
    if (!auth.isAuthenticated) {
      void (auth.ended === 'signedOut' ? session.switchTo(null) : session.closeCopy())
      return
    }
    let current = true
    let answered = false
    let retry: ReturnType<typeof setTimeout> | undefined
    // Tokens from a sign-in made here may be someone else's: only the server's answer opens a copy for them.
    if (auth.restored) {
      void SecureStore.getItemAsync(LAST_USER)
        .then((last) => {
          // Only until the server said who it is: its answer always wins.
          if (current && !answered && last !== null) {
            void session.switchTo(last)
          }
        })
        .catch(() => {})
    }
    const lookUp = () => {
      auth.session
        .me()
        .then((me) => {
          if (current) {
            answered = true
            setLookupError(null)
            void session.switchTo(me.id)
            // Through the session, after a new sign-in's store preparation that forgets the previous user.
            void auth.session.rememberUser(me.id).catch(() => {})
          }
        })
        .catch((error: unknown) => {
          if (current) {
            setLookupError(error instanceof Error ? error.message : String(error))
            retry = setTimeout(lookUp, ME_RETRY_MS)
          }
        })
    }
    lookUp()
    return () => {
      current = false
      clearTimeout(retry)
    }
  }, [auth.restoring, auth.isAuthenticated, auth.ended, auth.restored, auth.session, session])

  // In the background the connection rests; back in front, the copy catches up and listens again.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => session.setForeground(next === 'active'))
    return () => subscription.remove()
  }, [session])

  const mailAccounts = useCallback(async () => (await session.database?.mailAccounts()) ?? [], [session])
  const folders = useCallback(async () => (await session.database?.folders()) ?? [], [session])
  const act = useCallback(
    (messageIds: string[], action: MessageAction, target: { folderId?: string; fromFolderId?: string } = {}) => session.act(messageIds, action, target),
    [session],
  )
  const inbox = useCallback(async (mailAccountId: string | null) => (await session.database?.inbox(mailAccountId, LIST_LIMIT)) ?? [], [session])
  const thread = useCallback(async (threadId: string) => (await session.database?.thread(threadId)) ?? null, [session])
  const triageWaiting = useCallback(async (limit: number) => (await session.database?.listThreadIds(UNIFIED_INBOX, needsTriage, limit)) ?? [], [session])
  const newestInInbox = useCallback(async (limit: number) => (await session.database?.list(UNIFIED_INBOX, limit)) ?? [], [session])
  const summaries = useCallback(async (threadIds: string[]) => (await session.database?.summaries(threadIds)) ?? [], [session])
  const smartInboxes = useCallback(async () => (await session.database?.smartInboxes()) ?? [], [session])
  const classifyThread = useCallback(
    (threadId: string, smartInboxId: string, verdict: Verdict, remember: boolean) => session.classifyThread(threadId, smartInboxId, verdict, remember),
    [session],
  )
  const releaseThread = useCallback((threadId: string, placementId: string) => session.releaseThread(threadId, placementId), [session])
  const body = useCallback(
    (messageId: string, allowRemoteContent: boolean) =>
      auth.session.api<MessageBody>(`/api/v1/messages/${encodeURIComponent(messageId)}/body${allowRemoteContent ? '?remoteContent=allow' : ''}`),
    [auth.session],
  )
  const unscannedLink = useCallback(
    async (attachmentId: string) =>
      (await auth.session.api<{ url: string }>(`/api/v1/attachments/${encodeURIComponent(attachmentId)}/unscanned-link`, json('POST', { confirmed: true }))).url,
    [auth.session],
  )
  const syncNow = useCallback(() => session.syncNow(), [session])
  const store = useCallback(() => session.database, [session])
  const signatures = useCallback(async () => (await session.database?.signatures()) ?? [], [session])
  const suggestContacts = useCallback(async (query: string) => (await session.database?.suggestContacts(query, 8)) ?? [], [session])
  const send = useCallback((request: SendMessageRequest) => auth.session.api<SyncedOutgoingMessage>('/api/v1/outgoing-messages', json('POST', request)), [auth.session])
  const cancelOutgoing = useCallback(
    (id: string) => auth.session.api<SyncedOutgoingMessage>(`/api/v1/outgoing-messages/${encodeURIComponent(id)}/cancel`, json('POST', {})),
    [auth.session],
  )
  const touch = useCallback(() => session.changed(), [session])
  const todosApi = useMemo(() => todoApi((path, init) => auth.session.api(path, init)), [auth.session])
  const todos = useCallback(async () => (await session.database?.todos()) ?? [], [session])
  const todosOfThread = useCallback(async (threadId: string) => (await session.database?.todosOfThread(threadId)) ?? [], [session])
  const messages = useCallback(async (ids: string[]) => (ids.length === 0 ? [] : ((await session.database?.messages(ids)) ?? [])), [session])
  const makeTodo = useCallback(
    async (messageId: string, request: MakeTodoRequest = {}) => {
      const todo = await todosApi.makeFromMessage(messageId, request)
      await session.syncNow()
      return todo
    },
    [todosApi, session],
  )
  const removeTodo = useCallback(
    async (id: string) => {
      try {
        await todosApi.remove(id)
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) {
          throw error
        }
      }
      await session.syncNow()
    },
    [todosApi, session],
  )
  const setTodoDone = useCallback(
    async (id: string, done: boolean) => {
      await todosApi.update(id, { done })
      await session.syncNow()
    },
    [todosApi, session],
  )
  const planTodo = useCallback(
    async (id: string) => {
      await todosApi.plan(id)
      await session.syncNow()
    },
    [todosApi, session],
  )
  const unplanTodo = useCallback(
    async (id: string) => {
      await todosApi.unplan(id)
      await session.syncNow()
    },
    [todosApi, session],
  )
  const handOvers = useCallback(async () => (await session.database?.handOvers()) ?? [], [session])
  const outgoing = useCallback(async (id: string) => (await session.database?.outgoing(id)) ?? null, [session])
  const handOverApi = useMemo<HandOverApi>(
    () => ({
      create: (request) => auth.session.api<SyncedHandOver>('/api/v1/hand-overs', json('POST', request)),
      update: (id, request) => auth.session.api<SyncedHandOver>(`/api/v1/hand-overs/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/merge-patch+json' }, body: JSON.stringify(request) }),
      withdraw: async (id) => {
        await auth.session.api(`/api/v1/hand-overs/${encodeURIComponent(id)}`, json('DELETE'))
      },
      nudge: (id, request) => auth.session.api<SyncedHandOver>(`/api/v1/hand-overs/${encodeURIComponent(id)}/nudge`, json('POST', request)),
    }),
    [auth.session],
  )
  const clearOverdue = useCallback((ids: string[]) => setOverdue((waiting) => waiting.filter((handOver) => !ids.includes(handOver.id))), [])
  const respond = useCallback(
    async (eventId: string, response: 'accepted' | 'tentative' | 'declined', recurrenceId: string | null) => {
      await auth.session.api(`/api/v1/calendar-events/${encodeURIComponent(eventId)}/response`, json('POST', { response, recurrenceId, comment: null, notify: true }))
      await session.syncNow()
    },
    [auth.session, session],
  )
  const { userId, ready, synced, version, syncState, syncError, live, pulls } = state
  const mail = useMemo<Mail>(
    () => ({
      userId,
      ready,
      synced,
      version,
      syncState,
      syncError: syncError ?? lookupError,
      live,
      pulls,
      mailAccounts,
      folders,
      act,
      inbox,
      triageWaiting,
      newestInInbox,
      summaries,
      smartInboxes,
      classifyThread,
      releaseThread,
      thread,
      body,
      unscannedLink,
      syncNow,
      serverNow: () => auth.session.serverNow(),
      store,
      drafts: session.drafts,
      signatures,
      suggestContacts,
      send,
      cancelOutgoing,
      touch,
      todos,
      todosOfThread,
      messages,
      makeTodo,
      removeTodo,
      setTodoDone,
      planTodo,
      unplanTodo,
      handOvers,
      outgoing,
      handOverApi,
      overdue,
      clearOverdue,
      respond,
    }),
    [userId, touch, ready, synced, version, syncState, syncError, lookupError, live, pulls, mailAccounts, folders, act, inbox, triageWaiting, newestInInbox, summaries, smartInboxes, classifyThread, releaseThread, thread, body, unscannedLink, syncNow, auth.session, store, session, signatures, suggestContacts, send, cancelOutgoing, todos, todosOfThread, messages, makeTodo, removeTodo, setTodoDone, planTodo, unplanTodo, handOvers, outgoing, handOverApi, overdue, clearOverdue, respond],
  )

  return <MailContext.Provider value={mail}>{children}</MailContext.Provider>
}

export function useMail(): Mail {
  const mail = useContext(MailContext)
  if (mail === null) {
    throw new Error('useMail() is used outside <MailProvider>.')
  }
  return mail
}
