import { describe, expect, it } from 'vitest'
import { appName, assistantNotice, leftOutPill, leftOutText, doneLine, doneTitle, expiredCounts, listTime, passwordGoesTo, summaryLine } from '../importTexts'

describe('the words of Add several accounts', () => {
  it('writes a time as the boards do', () => {
    expect(listTime('2026-10-21T10:12:00Z', 'UTC')).toBe('Wednesday 21 October at 10:12')
    expect(listTime('2026-10-20T08:05:00Z', 'Europe/Amsterdam')).toBe('Tuesday 20 October at 10:05')
  })

  it('counts in the singular and the plural', () => {
    expect(summaryLine(1, 17)).toBe('1 needs another try. 17 to go.')
    expect(summaryLine(2, 0)).toBe('2 need another try.')
    expect(expiredCounts(1, 1)).toBe('The 1 account you connected stays connected. The other one was not added.')
    expect(expiredCounts(12, 18)).toBe('The 12 accounts you connected stay connected. The other 18 were not added.')
    expect(expiredCounts(0, 3)).toBe('The 3 accounts were not added.')
    expect(expiredCounts(2, 0)).toBe('The 2 accounts you connected stay connected.')
  })

  it('counts only accounts the list added in the ending', () => {
    expect(doneTitle(3, 3, 0, 0)).toBe('All 3 accounts added')
    expect(doneTitle(1, 1, 0, 0)).toBe('1 account added')
    expect(doneTitle(2, 3, 0, 1)).toBe('2 accounts added')
    expect(doneTitle(27, 30, 3, 0)).toBe('27 accounts added')
    expect(doneTitle(0, 2, 1, 1)).toBe('No accounts added')
    expect(doneLine(27, 3)).toBe('3 were skipped. Mail for the new accounts is coming in, newest first.')
    expect(doneLine(0, 1)).toBe('1 was skipped.')
    expect(doneLine(2, 0)).toBe('Mail for the new accounts is coming in, newest first.')
  })

  it('says why the API left an address out', () => {
    const lookalike = { address: 'kim@gmaіl.com', reason: 'lookalike', message: '' } as const
    expect([leftOutPill(lookalike), leftOutText(lookalike)]).toEqual(['Not valid', 'This address uses letters that look like other letters. It is left out.'])
    expect(leftOutText({ address: 'kim@x', reason: 'invalid', message: '' })).toBe('This is not a valid address. It is left out unless you fix it.')
    expect(leftOutText({ address: 'kim', reason: 'invalid', message: '' })).toBe('There is no @ in this address. It is left out unless you fix it.')
    expect(leftOutText({ address: 'kim@x.example', reason: 'duplicate', message: '' })).toBe('It is added once.')
  })

  it('cuts an app name at 60 characters', () => {
    expect(appName('Claude')).toBe('Claude')
    expect(appName('y'.repeat(61))).toBe(`${'y'.repeat(60)}…`)
  })

  it('names where a password goes', () => {
    expect(passwordGoesTo('imap.a.example', 'smtp.a.example')).toBe('Tresso uses this password only to sign in at imap.a.example and smtp.a.example.')
    expect(passwordGoesTo('mail.a.example', 'mail.a.example')).toBe('Tresso uses this password only to sign in at mail.a.example.')
  })

  it('says a list was made with an access token, and by an app', () => {
    expect(assistantNotice('your access token "Script"', true)).toBe('This list was made with your access token "Script". Check the addresses before you sign in.')
    expect(assistantNotice('Claude')).toBe('This list was made by Claude. Check the addresses before you sign in.')
  })
})
