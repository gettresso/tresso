import { reactive, shallowReactive } from 'vue'
import { LocalChatBackend, SqliteMailStore, type IncomingChat, type IncomingMessage, type SyncedChatAccount } from '@tresso/core'
import { memorySql } from '@tresso/core/testing/sql'
import type { BridgeState, DownloadedFile, SendResult, WhatsAppConfig } from '@/platform/whatsapp'

/** Shared by the chat screens' tests: a copy with "Only this Mac" chats, and the stores around it as fakes. */

export const NOW = Date.parse('2026-11-12T10:00:00Z')
export const DIRECT = '31612345678@s.whatsapp.net'
export const GROUP = '120363000000000001@g.us'
export const DIRECT_ID = `wa:${DIRECT}`
export const GROUP_ID = `wa:${GROUP}`
export const LINKED: BridgeState = { process: 'owned', port: 8741, loopbackOnly: true, link: 'linked', qr: null, error: null }
export const STOPPED: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }

export const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

export function config(extra: Partial<WhatsAppConfig> = {}): WhatsAppConfig {
  return {
    folder: '/Users/kim/whatsapp-mcp',
    mode: 'local',
    deviceId: '0193a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b',
    deviceName: "Kim's MacBook Pro",
    linkedAt: null,
    importSince: '2026-10-13T10:00:00.000Z',
    includeGroups: true,
    notify: false,
    leftOut: [],
    ...extra,
  }
}

/** The WhatsApp relay store as the chat screens use it. */
export function fakeRelay() {
  return reactive({
    available: true,
    connected: true,
    config: config() as WhatsAppConfig | null,
    bridge: LINKED as BridgeState,
    linked: true,
    relayRunning: true,
    importState: 'done' as 'waiting' | 'reading' | 'done' | 'stuck',
    revision: 0,
    liveFrom: null as number | null,
    senderNames: new Map<string, string>() as ReadonlyMap<string, string>,
    identity: { number: '31698765432', name: 'Kim Visser' } as { number: string; name: string | null } | null,
    busy: null as string | null,
    error: null as string | null,
    /** "All my devices": the server's account in the copy, and whether this Mac relays it. */
    serverAccount: null as SyncedChatAccount | null,
    relaysHere: false,
    modeSwitch: null as unknown,
    pollNow: async () => undefined,
    leaveOut: async (_jid: string) => true,
    takeBackIn: async (_jid: string) => true,
    lookUpNames: async (_ids: readonly string[]) => undefined,
    start: async () => true,
  })
}

/** The mail store as the chat screens use it. */
export function fakeMail() {
  return shallowReactive({
    synced: true,
    ready: true,
    /** The server confirmed the copy's user (writes may go out). */
    confirmed: true,
    chatChanges: 0,
    store: null as SqliteMailStore | null,
    currentStore: () => null as SqliteMailStore | null,
    syncNow: async () => undefined,
  })
}

/** The desktop shell's commands the chat screens call. */
export function fakeShell() {
  return {
    downloadAnswer: (): Promise<DownloadedFile> => Promise.resolve({ path: '/Users/kim/Library/Application Support/app.tresso.desktop/whatsapp-media/abc.jpg', verified: true, sha256: 'a'.repeat(64), size: 3 }),
    sendAnswer: (): Promise<SendResult> => Promise.resolve({ ok: true, message: 'sent' }),
    chosen: { path: '/Users/kim/Documents/plan.pdf', size: 4096 } as { path: string; size: number } | null,
    calls: [] as string[],
    sent: [] as { recipient: string; text: string; mediaPath: string | null }[],
  }
}

/** A copy with the "Only this Mac" account and what `messages` brings in. */
export async function copyWith(chats: IncomingChat[], messages: IncomingMessage[], firstImport = false): Promise<SqliteMailStore> {
  const store = await SqliteMailStore.open(await memorySql())
  const backend = new LocalChatBackend(store, { includeGroups: true, leftOut: [], importSince: 0 }, { number: '31698765432', name: 'Kim', deviceId: config().deviceId, deviceName: config().deviceName }, () => NOW)
  await backend.prepare()
  if (messages.length > 0) {
    await backend.ingest(chats, messages, firstImport)
  }
  return store
}

export function incoming(waId: string, chatJid: string, minutes: number, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return { chatJid, waId, fromMe: false, sender: null, text: `Text ${waId}`, sentAt: at(minutes), media: null, ...extra }
}

export const direct: IncomingChat = { jid: DIRECT, name: 'Bram Visser', kind: 'direct' }
export const group: IncomingChat = { jid: GROUP, name: 'Family', kind: 'group' }
