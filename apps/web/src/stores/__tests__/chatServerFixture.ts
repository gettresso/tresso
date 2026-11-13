import {
  ChatApiError,
  canonicalChatJid,
  chatKindOf,
  type ChatApi,
  type MailStore,
  type RelayImportResponse,
  type SyncedChat,
  type SyncedChatAccount,
  type SyncedChatMessage,
  type SyncedChatOutgoing,
} from '@tresso/core'

/** The server's chat account in the tests. */
export const ACCOUNT_ID = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4aa0'
/** Another desktop of the same user. */
export const OTHER_DEVICE = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'

interface Call {
  name: keyof ChatApi
  args: unknown[]
}

/**
 * The API's chat endpoints as a fake (docs/ARCHITECTURE.md 3.17): one account, chats by JID, messages by chat and
 * WhatsApp id, the reply queue with claims, and the relay rule (409 `not_the_relay` for another device). `deliver`
 * puts what the server holds into a copy, as a pull of the delta would.
 */
export class FakeChatServer implements ChatApi {
  account: SyncedChatAccount | null = null
  readonly chats = new Map<string, SyncedChat>()
  readonly messages = new Map<string, SyncedChatMessage>()
  readonly outgoing = new Map<string, SyncedChatOutgoing>()
  /** Accounts removed since the last delivery (tombstones). */
  removed: string[] = []
  /** Whether a pull (syncNow) brings what the server holds; false holds the delta back. */
  delivering = true
  /** The account's history import is still open (`firstImport` honoured). */
  importsHistory = true
  readonly calls: Call[] = []
  /** Calls that reject, with what (once each unless `always`). */
  failures = new Map<keyof ChatApi, { error: unknown; always: boolean }>()
  /** A call that waits for the test before it answers. */
  held = new Map<keyof ChatApi, Promise<void>>()
  private claims = new Map<string, string>()
  private seq = 0

  private async enter(name: keyof ChatApi, args: unknown[]): Promise<void> {
    this.calls.push({ name, args })
    const hold = this.held.get(name)
    if (hold !== undefined) {
      await hold
    }
    const failure = this.failures.get(name)
    if (failure !== undefined) {
      if (!failure.always) {
        this.failures.delete(name)
      }
      throw failure.error
    }
  }

  fail(name: keyof ChatApi, error: unknown, always = false): void {
    this.failures.set(name, { error, always })
  }

  callsOf(name: keyof ChatApi): unknown[][] {
    return this.calls.filter((call) => call.name === name).map((call) => call.args)
  }

  /** The arguments of the last call of `name`; undefined when there was none. */
  lastCall(name: keyof ChatApi): unknown[] | undefined {
    const calls = this.callsOf(name)
    return calls[calls.length - 1]
  }

  /** The account as another desktop took it over. */
  takenOverBy(deviceId: string, name = 'Office iMac'): void {
    if (this.account !== null) {
      this.account = { ...this.account, relayDeviceId: deviceId, relayDeviceName: name }
      this.importsHistory = true
    }
  }

  /** The account removed elsewhere (another device disconnected WhatsApp). */
  removeElsewhere(): void {
    if (this.account !== null) {
      this.removed.push(this.account.id)
    }
    this.account = null
    this.chats.clear()
    this.messages.clear()
    this.outgoing.clear()
  }

  private relayCheck(accountId: string, deviceId: string): void {
    if (this.account === null || this.account.id !== accountId) {
      throw new ChatApiError(404, 'Not found.')
    }
    if (this.account.relayDeviceId !== deviceId) {
      throw new ChatApiError(409, 'Another device relays.', 'not_the_relay')
    }
  }

  async accounts(): Promise<SyncedChatAccount[]> {
    await this.enter('accounts', [])
    return this.account === null ? [] : [this.account]
  }

  async connect(request: Parameters<ChatApi['connect']>[0]): Promise<SyncedChatAccount> {
    await this.enter('connect', [request])
    this.account =
      this.account === null
        ? {
            id: ACCOUNT_ID,
            channel: 'whatsapp',
            address: request.address,
            displayName: request.displayName,
            relayDeviceId: request.deviceId,
            relayDeviceName: request.deviceName,
            relayOnline: true,
            relayOfflineSince: null,
            bridge: 'running',
            link: 'linked',
            linkedAt: null,
            loopbackOnly: true,
            includeGroups: request.includeGroups,
            notify: request.notify,
          }
        : this.otherNumber(request.address)
          ? (() => {
              throw new ChatApiError(409, 'Another number.', 'other_number')
            })()
          : { ...this.account, relayDeviceId: request.deviceId, relayDeviceName: request.deviceName, address: request.address ?? this.account.address }
    this.importsHistory = true
    return this.account
  }

  /** As the API: another number may not take over an account that holds chats. */
  private otherNumber(address: string | null): boolean {
    return address !== null && this.account?.address != null && address !== this.account.address && this.chats.size > 0
  }

  async updateAccount(id: string, request: Parameters<ChatApi['updateAccount']>[1]): Promise<SyncedChatAccount> {
    await this.enter('updateAccount', [id, request])
    if (this.account === null || this.account.id !== id) {
      throw new ChatApiError(404, 'Not found.')
    }
    this.account = { ...this.account, ...request }
    if (request.includeGroups === false) {
      for (const [jid, chat] of this.chats) {
        if (chat.kind === 'group') {
          this.chats.delete(jid)
          for (const [key, message] of this.messages) {
            if (message.chatId === chat.id) this.messages.delete(key)
          }
        }
      }
    }
    return this.account
  }

  async removeAccount(id: string): Promise<void> {
    await this.enter('removeAccount', [id])
    if (this.account === null || this.account.id !== id) {
      throw new ChatApiError(404, 'Not found.')
    }
    this.removeElsewhere()
  }

  async relayStatus(accountId: string, request: Parameters<ChatApi['relayStatus']>[1]): Promise<{ relay: 'active' }> {
    await this.enter('relayStatus', [accountId, request])
    this.relayCheck(accountId, request.deviceId)
    return { relay: 'active' }
  }

  async relayMessages(accountId: string, request: Parameters<ChatApi['relayMessages']>[1]): Promise<RelayImportResponse> {
    await this.enter('relayMessages', [accountId, request])
    this.relayCheck(accountId, request.deviceId)
    const account = this.account!
    const honour = request.firstImport && this.importsHistory
    if (!request.firstImport) {
      this.importsHistory = false
    }
    const results: RelayImportResponse['results'] = []
    const newest = new Map<string, string>()
    for (const message of request.messages) {
      const jid = canonicalChatJid(message.chatJid)!
      let chat = this.chats.get(jid)
      if (chat?.leftOut || (!account.includeGroups && chatKindOf(jid) === 'group')) {
        results.push('left_out')
        continue
      }
      const key = `${jid}\n${message.waId}`
      if (this.messages.has(key)) {
        results.push('known')
        continue
      }
      if (chat === undefined) {
        const named = request.chats.find((entry) => entry.jid === jid)
        chat = { id: `chat-${jid}`, chatAccountId: account.id, jid, kind: chatKindOf(jid), name: named?.name ?? null, lastMessageAt: message.sentAt, readThrough: null, archivedThrough: null, leftOut: false }
        this.chats.set(jid, chat)
      }
      this.messages.set(key, {
        id: `msg-${++this.seq}`,
        chatId: chat.id,
        chatAccountId: account.id,
        waId: message.waId,
        fromMe: message.fromMe,
        sender: message.sender,
        text: message.text,
        sentAt: message.sentAt,
        mediaKind: message.media?.kind ?? null,
        mediaName: message.media?.name ?? null,
        mediaSize: message.media?.size ?? null,
      })
      if (Date.parse(message.sentAt) > Date.parse(chat.lastMessageAt)) {
        chat.lastMessageAt = message.sentAt
      }
      newest.set(jid, chat.lastMessageAt)
      results.push('stored')
    }
    if (honour) {
      for (const [jid, at] of newest) {
        const chat = this.chats.get(jid)!
        chat.readThrough = at
      }
    }
    const count = (kind: string) => results.filter((result) => result === kind).length
    return { stored: count('stored'), known: count('known'), leftOut: count('left_out'), refused: count('refused'), results }
  }

  async claimReply(accountId: string, request: Parameters<ChatApi['claimReply']>[1]): Promise<Awaited<ReturnType<ChatApi['claimReply']>>> {
    await this.enter('claimReply', [accountId, request])
    this.relayCheck(accountId, request.deviceId)
    const next = [...this.outgoing.values()].filter((row) => row.status === 'waiting').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (next === undefined) {
      return null
    }
    const token = `token-${++this.seq}`
    this.claims.set(next.id, token)
    this.outgoing.set(next.id, { ...next, status: 'sending', claimedAt: new Date().toISOString() })
    const chat = [...this.chats.values()].find((candidate) => candidate.id === next.chatId)!
    return { id: next.id, chatId: next.chatId, chatJid: chat.jid, text: next.text, claimToken: token }
  }

  async reportReply(accountId: string, outgoingId: string, request: Parameters<ChatApi['reportReply']>[2]): Promise<SyncedChatOutgoing> {
    await this.enter('reportReply', [accountId, outgoingId, request])
    const row = this.outgoing.get(outgoingId)
    if (row === undefined) {
      throw new ChatApiError(404, 'Not found.')
    }
    if (this.account?.relayDeviceId !== request.deviceId && !request.sent) {
      throw new ChatApiError(409, 'Another device relays.', 'not_the_relay')
    }
    const next: SyncedChatOutgoing = request.sent ? { ...row, status: 'sent', error: null, sentAt: new Date().toISOString() } : { ...row, status: 'failed', error: request.error }
    this.outgoing.set(outgoingId, next)
    return next
  }

  async queueReply(chatId: string, request: Parameters<ChatApi['queueReply']>[1]): Promise<SyncedChatOutgoing> {
    await this.enter('queueReply', [chatId, request])
    const known = this.outgoing.get(request.id)
    if (known !== undefined) {
      return known
    }
    const chat = [...this.chats.values()].find((candidate) => candidate.id === chatId)
    if (chat === undefined || this.account === null) {
      throw new ChatApiError(404, 'Not found.')
    }
    const row: SyncedChatOutgoing = { id: request.id, chatId, chatAccountId: this.account.id, text: request.text.trim(), status: 'waiting', error: null, createdAt: new Date().toISOString(), claimedAt: null, sentAt: null }
    this.outgoing.set(row.id, row)
    return row
  }

  async cancelReply(id: string): Promise<void> {
    await this.enter('cancelReply', [id])
    this.outgoing.delete(id)
  }

  async retryReply(id: string): Promise<SyncedChatOutgoing> {
    await this.enter('retryReply', [id])
    const row = this.outgoing.get(id)
    if (row === undefined) {
      throw new ChatApiError(404, 'Not found.')
    }
    const next: SyncedChatOutgoing = { ...row, status: 'waiting', error: null, claimedAt: null }
    this.outgoing.set(id, next)
    return next
  }

  async updateChat(id: string, request: Parameters<ChatApi['updateChat']>[1]): Promise<SyncedChat> {
    await this.enter('updateChat', [id, request])
    const chat = [...this.chats.values()].find((candidate) => candidate.id === id)
    if (chat === undefined) {
      throw new ChatApiError(404, 'Not found.')
    }
    if (request.readThrough !== undefined && (chat.readThrough === null || Date.parse(request.readThrough) > Date.parse(chat.readThrough))) {
      chat.readThrough = request.readThrough
    }
    if (request.archivedThrough !== undefined) {
      chat.archivedThrough = request.archivedThrough
    }
    if (request.leftOut !== undefined) {
      chat.leftOut = request.leftOut
      if (request.leftOut) {
        for (const [key, message] of this.messages) {
          if (message.chatId === chat.id) this.messages.delete(key)
        }
      }
    }
    return { ...chat }
  }

  /** What a pull of the delta brings into the copy now: removals, then the rows the server holds. */
  async deliver(store: MailStore): Promise<void> {
    if (!this.delivering) {
      return
    }
    for (const id of this.removed) {
      await store.removeChatAccount(id)
    }
    this.removed = []
    if (this.account === null) {
      return
    }
    await store.putChatAccount({ ...this.account })
    await store.putChats([...this.chats.values()].map((chat) => ({ ...chat })))
    await store.putChatMessages([...this.messages.values()])
    await store.putChatOutgoing([...this.outgoing.values()])
  }
}
