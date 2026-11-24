import { describe, expect, it } from 'vitest'
import { activeText, activityAppName, activityTime, appActivityPath, durationText, permissionLine, permissionUsed, recentText, recentTime, recentTool, touched, type AppActivityEntry } from './appActivity'

const NOW = new Date(2026, 9, 20, 10, 40, 0)

function entry(extra: Partial<AppActivityEntry> = {}): AppActivityEntry {
  return {
    id: 'e1',
    occurredAt: new Date(2026, 9, 20, 10, 38, 12).toISOString(),
    app: { key: 'client:claude', type: 'client', name: 'Claude', connectedAppId: 'c1', personalAccessTokenId: null },
    channel: 'mcp',
    action: { name: 'list_whatsapp_chats', title: 'List WhatsApp chats' },
    kind: 'read',
    result: 'done',
    reason: null,
    durationMs: 84,
    permissions: [{ scope: 'chat:read', label: 'Read your WhatsApp chats', held: true }],
    object: { type: 'Chat', label: 'WhatsApp chats', list: true, id: null },
    ...extra,
  }
}

describe('app activity', () => {
  it('says what an assistant may do in one line, as the Apps page shows it', () => {
    expect(permissionLine(['mail:read', 'todos:read', 'todos:write', 'settings:read', 'settings:write', 'signatures:read', 'signatures:write'])).toBe('May read mail, change todos and signatures, and change settings.')
    expect(permissionLine(['mail:read', 'todos:read', 'todos:write'])).toBe('May read mail and change todos.')
    expect(permissionLine(['mail:read'])).toBe('May read mail.')
    expect(permissionLine(['mail:read', 'mail:send', 'calendar:read', 'chat:read', 'chat:send'])).toBe('May read and send mail, see calendar, read WhatsApp chats, and send WhatsApp messages.')
    expect(permissionLine([])).toBeNull()
  })

  it('writes times, durations and how recently an app was active', () => {
    expect(activityTime(entry().occurredAt, NOW)).toBe('10:38:12')
    expect(activityTime(new Date(2026, 9, 19, 16, 40, 11).toISOString(), NOW)).toBe('19 Oct 16:40:11')
    expect(recentTime(entry().occurredAt, NOW)).toBe('10:38')
    expect(recentTime(new Date(2026, 9, 19, 16, 40).toISOString(), NOW)).toBe('19 Oct')
    expect(durationText(84)).toBe('84 ms')
    expect(durationText(1200)).toBe('1.2 s')
    expect(activeText(new Date(NOW.getTime() - 4 * 60_000).toISOString(), NOW)).toBe('Active 4 min ago')
    expect(activeText(new Date(NOW.getTime() - 70 * 60_000).toISOString(), NOW)).toBe('Active 1 h ago')
    expect(activeText(new Date(NOW.getTime() - 21 * 86_400_000).toISOString(), NOW)).toBe('Idle for 21 days')
    expect(activeText(null, NOW)).toBeNull()
  })

  it('names a refusal in recent activity', () => {
    const refused = entry({ result: 'refused', reason: { code: 'no_permission', label: 'No permission', sentence: 'x' } })
    expect(recentText(refused)).toBe('List WhatsApp chats, refused')
    expect(recentTool(refused)).toBe('list_whatsapp_chats (no permission)')
    expect(recentText(entry())).toBe('List WhatsApp chats')
    expect(recentTool(entry())).toBe('list_whatsapp_chats')
  })

  it('describes the permission used and what was touched', () => {
    expect(permissionUsed(entry({ permissions: [{ scope: 'chat:send', label: 'Send WhatsApp messages as you', held: false }] }))).toEqual({ label: 'Send WhatsApp messages as you, off for Claude', scopes: 'chat:send' })
    expect(touched(entry())).toEqual({ label: 'WhatsApp chats', id: 'No id. A list has none.' })
    expect(touched(entry({ result: 'refused', object: null }))).toEqual({ label: 'Nothing', id: 'No id. Nothing was read.' })
    expect(touched(entry({ object: { type: 'Chat', label: 'WhatsApp chat', list: false, id: 'chat-1' } }))).toEqual({ label: 'WhatsApp chat', id: 'chat-1' })
    expect(activityAppName({ type: 'token', name: null })).toBe('A removed token')
  })

  it('asks for a page with only the filters that are set', () => {
    expect(appActivityPath({ period: '24h', app: 'client:claude', kind: undefined, cursor: '' })).toBe('/api/v1/app-activity?period=24h&app=client%3Aclaude')
    expect(appActivityPath({})).toBe('/api/v1/app-activity')
  })
})
