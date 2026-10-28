import { describe, expect, it } from 'vitest'
import { classificationReasonText, isSenderPattern, normalizeSenderPattern, smartInboxMark, sortSmartInboxes, spamOverruleNotice, verdictLabel } from './smartInboxes'

describe('sender patterns', () => {
  it.each([
    ['anna@example.com', true],
    ['@example.com', true],
    ['  @Example.COM ', true],
    ['example.com', false],
    ['@localhost', false],
    ['a@b@example.com', false],
    ['an na@example.com', false],
  ])('%s is valid: %s', (pattern, valid) => {
    expect(isSenderPattern(pattern)).toBe(valid)
  })

  it('normalizes to trimmed lower case', () => {
    expect(normalizeSenderPattern('  Anna@Example.COM ')).toBe('anna@example.com')
  })
})

describe('smart inboxes', () => {
  it('sort by position, then id', () => {
    const sorted = sortSmartInboxes([
      { id: 'b', position: 1 },
      { id: 'c', position: 0 },
      { id: 'a', position: 1 },
    ])

    expect(sorted.map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })

  it('have a mark', () => {
    expect(smartInboxMark({ builtin: 'todo', name: 'To do' })).toBe('D')
    expect(smartInboxMark({ builtin: null, name: ' invoices' })).toBe('I')
  })
})

describe('labels', () => {
  it('name verdicts the way the product does', () => {
    expect(verdictLabel('delegate')).toBe('Hand over')
  })

  it('explain reasons, also ones another classifier made up', () => {
    expect(classificationReasonText('user')).toBe('You put it here.')
    expect(classificationReasonText('ai')).toBe('Classified automatically.')
    expect(classificationReasonText(null)).toBeNull()
  })
})

describe('spamOverruleNotice', () => {
  it('explains why new mail from the sender still goes to Spam', () => {
    const rule = { id: 'r1', sender: 'news@bank.example', verdict: null }

    expect(spamOverruleNotice({ senderRule: { ...rule, spamOverrules: 'authentication_failed' } })).toContain('fails the checks')
    expect(spamOverruleNotice({ senderRule: { ...rule, spamOverrules: 'server_spam' } })).toContain('Your mail server marks mail from news@bank.example as spam')
    expect(spamOverruleNotice({ senderRule: { ...rule, spamOverrules: null } })).toBeNull()
    expect(spamOverruleNotice({ senderRule: null })).toBeNull()
  })
})
