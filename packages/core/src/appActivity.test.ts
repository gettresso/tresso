import { describe, expect, it } from 'vitest'
import { PERSONAL_ACCESS_TOKEN_SCOPES } from './personalAccessTokens'
import { ASSISTANT_SCOPE_ORDER, ASSISTANT_SCOPES, activeText, activityAppName, activityTime, appActivityPath, durationText, permissionLine, permissionUsed, recentText, recentTime, recentTool, repeatSpan, shortDay, timesText, touched, type AppActivityEntry } from './appActivity'

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
    object: { type: 'Chat', label: 'WhatsApp chats', list: true, id: null, several: false },
    lastOccurredAt: new Date(2026, 9, 20, 10, 38, 12).toISOString(),
    count: 1,
    ...extra,
  }
}

describe('app activity', () => {
  it('lists every scope an assistant can have once, in the words of the consent screen', () => {
    expect(ASSISTANT_SCOPES.map((scope) => scope.value)).toEqual([...ASSISTANT_SCOPE_ORDER])
    expect(new Set(ASSISTANT_SCOPE_ORDER).size).toBe(ASSISTANT_SCOPE_ORDER.length)
    for (const scope of ASSISTANT_SCOPES) {
      expect(scope).toEqual(PERSONAL_ACCESS_TOKEN_SCOPES.find((known) => known.value === scope.value))
    }
    expect(ASSISTANT_SCOPES.find((scope) => scope.value === 'settings:write')!.description).toBe(
      'Change settings such as account names, smart inboxes, rules and notifications, and prepare a list of mail addresses for you to add. Never how a mail account connects, access tokens or connected apps.',
    )
  })

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
    expect(shortDay(new Date(2026, 8, 2, 23, 59))).toBe('2 Sep')
    expect(shortDay(new Date(2027, 0, 31, 0, 0))).toBe('31 Jan')
    expect(shortDay(new Date(2026, 8, 2), NOW)).toBe('2 Sep')
    expect(shortDay(new Date(2025, 8, 2), NOW)).toBe('2 Sep 2025')
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
    expect(touched(entry({ object: { type: 'Chat', label: 'WhatsApp chat', list: false, id: 'chat-1', several: false } }))).toEqual({ label: 'WhatsApp chat', id: 'chat-1' })
    expect(touched(entry({ object: null }))).toBeNull()
    expect(touched(entry({ object: { type: 'SmartInbox', label: 'Smart inbox', list: false, id: null, several: false } }))).toEqual({ label: 'Smart inbox', id: 'No id.' })
    expect(touched(entry({ result: 'failed', kind: 'change', object: { type: 'MailAccount', label: 'Mail account', list: false, id: null, several: false } }))).toEqual({ label: 'Mail account', id: 'No id. Nothing was changed.' })
    expect(activityAppName({ type: 'token', name: null })).toBe('A removed token')
    expect(activityAppName({ type: 'client', name: null })).toBe('A removed app')
    expect(activityAppName({ type: 'client', name: 'Claude' })).toBe('Claude')
    expect(permissionUsed(entry({ permissions: [] }))).toEqual({ label: 'None needed', scopes: '' })
    expect(permissionUsed(entry({ permissions: [{ scope: 'mail:read', label: 'Read mail', held: true }, { scope: 'calendar:read', label: 'See calendar', held: false }] }))).toEqual({ label: 'Read mail and See calendar, off for Claude', scopes: 'mail:read calendar:read' })
    expect(touched(entry({ object: { type: 'SmartInbox', label: 'Smart inbox', list: false, id: null, several: true } }))).toEqual({ label: 'Smart inbox', id: 'Several, not kept one by one' })
    expect(repeatSpan(entry(), NOW)).toBeNull()
    expect(repeatSpan(entry({ count: 3, lastOccurredAt: new Date(2026, 9, 20, 10, 38, 55).toISOString() }), NOW)).toBe('First at 10:38:12, last at 10:38:55')
    expect(timesText(1)).toBeNull()
    expect(timesText(3)).toBe('3 times')
  })

  it('asks for a page with only the filters that are set', () => {
    expect(appActivityPath({ period: '24h', app: 'client:claude', kind: undefined, cursor: '' })).toBe('/api/v1/app-activity?period=24h&app=client%3Aclaude')
    expect(appActivityPath({})).toBe('/api/v1/app-activity')
  })
})
