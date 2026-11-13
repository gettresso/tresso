import type { BridgeRow } from '@tresso/core'
import type { BridgeInspection, BridgeRows, BridgeState, SendResult, WhatsAppCommands, WhatsAppConfig } from '@/platform/whatsapp'

/** The desktop shell's WhatsApp commands as a fake, shared by the relay store's tests (both modes). */

export const NOW = Date.parse('2026-11-12T10:00:00Z')
export const DAY = 24 * 60 * 60 * 1000
export const FOLDER = '/Users/kim/whatsapp-mcp'
export const DIRECT = '31612345678@s.whatsapp.net'
export const GROUP = '120363000000000001@g.us'
export const MESSAGE_TEXT = 'Secret dinner plans'

export const STOPPED: BridgeState = { process: 'stopped', port: null, loopbackOnly: null, link: 'unknown', qr: null, error: null }
export const RUNNING: BridgeState = { process: 'owned', port: 8741, loopbackOnly: true, link: 'unknown', qr: null, error: null }
export const LINKED: BridgeState = { ...RUNNING, link: 'linked' }
export const WAITING: BridgeState = { ...RUNNING, link: 'waiting_for_scan', qr: ['1'.repeat(29)] }
export const GOOD_FOLDER: BridgeInspection = { found: true, built: true, hasStore: true, safe: true }

/** The desktop shell: a bridge whose state the test sets, a store of rows, and every command recorded. */
export class FakeShell {
  state: BridgeState = STOPPED
  rows: BridgeRow[] = []
  storeId = 'store-1'
  configs = new Map<string, WhatsAppConfig>()
  readFails: unknown = null
  sendAnswer: () => Promise<SendResult> = async () => ({ ok: true, message: 'sent' })
  available = true
  /** A start answers once this resolves. */
  startHeld: Promise<void> = Promise.resolve()
  listener: ((state: BridgeState) => void) | null = null
  readonly calls: string[] = []
  /** Commands that reject, with what. */
  failures: Record<string, unknown> = {}
  readonly saved: WhatsAppConfig[] = []
  readonly sent: { recipient: string; text: string }[] = []
  /** When each read began. */
  readonly readTimes: number[] = []

  emit(state: BridgeState): void {
    this.state = state
    this.listener?.(state)
  }

  add(id: string, chatJid: string, minutesAgo: number, extra: Partial<BridgeRow> = {}): void {
    this.rows.push({
      rowid: this.rows.length + 1,
      id,
      chatJid,
      chatName: chatJid === GROUP ? 'Family' : 'Kim',
      sender: chatJid === GROUP ? '31699999999' : chatJid.split('@')[0]!,
      text: MESSAGE_TEXT,
      sentAt: Date.now() - minutesAgo * 60_000,
      fromMe: false,
      mediaType: null,
      filename: null,
      fileLength: null,
      ...extra,
    })
  }

  commands(): WhatsAppCommands {
    const record = <T>(name: string, answer: () => T | Promise<T>): Promise<T> => {
      this.calls.push(name)
      return name in this.failures ? Promise.reject(this.failures[name]) : Promise.resolve().then(answer)
    }
    return {
      available: () => record('available', () => this.available),
      device: () => record('device', () => ({ name: "Kim's MacBook Pro" })),
      loadConfig: (userId) => record('loadConfig', () => this.configs.get(userId) ?? null),
      saveConfig: (userId, config) =>
        record('saveConfig', () => {
          this.saved.push(config)
          this.configs.set(userId, config)
        }),
      clearConfig: (userId) =>
        record('clearConfig', () => {
          this.configs.delete(userId)
        }),
      keepOnlyConfig: (userId) =>
        record('keepOnlyConfig', () => {
          for (const user of this.configs.keys()) {
            if (user !== userId) this.configs.delete(user)
          }
        }),
      chooseFolder: () => record('chooseFolder', () => FOLDER),
      inspect: () => record('inspect', () => GOOD_FOLDER),
      start: () =>
        record('start', async () => {
          await this.startHeld
          this.state = RUNNING
          return this.state
        }),
      stop: () =>
        record('stop', () => {
          this.state = STOPPED
          return this.state
        }),
      state: () => record('state', () => this.state),
      identity: () => record('identity', () => ({ number: '31698765432', name: 'Kim Visser' })),
      read: (_folder, afterRowid, limit) =>
        record('read', (): BridgeRows => {
          this.readTimes.push(Date.now())
          if (this.readFails !== null) {
            throw this.readFails
          }
          const rows = this.rows.filter((row) => row.rowid > afterRowid).slice(0, limit)
          return { rows, maxRowid: this.rows.length, storeId: this.storeId }
        }),
      names: (_folder, ids) => record('names', () => Object.fromEntries(ids.map((id) => [id, { number: id, name: null }]))),
      send: (recipient, text) =>
        record('send', () => {
          this.sent.push({ recipient, text })
          return this.sendAnswer()
        }),
      download: () => record('download', () => ({ path: '/tmp/x', verified: true })),
      openFile: () => record('openFile', () => undefined),
      chooseFile: () => record('chooseFile', () => null),
      onState: (handle) =>
        record('onState', () => {
          this.listener = handle
          return () => (this.listener = null)
        }),
    }
  }
}
