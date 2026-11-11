import { describe, expect, it } from 'vitest'
import type { SyncedMessage } from './sync/types'
import { composeBody, forwardSubject, parseAddresses, quotedInlineImages, quotedOriginal, quoteWithContentId, replyRecipients, replySubject, sendLaterOptions, withInlineLinks } from './compose'

function message(overrides: Partial<SyncedMessage> = {}): SyncedMessage {
  return {
    id: 'm1',
    mailAccountId: 'a1',
    threadId: 't1',
    folderIds: [],
    subject: 'Q4 budget',
    from: { address: 'anna@finance.example', name: 'Anna de Vries' },
    recipients: {
      to: [{ address: 'kim@company.example', name: 'Kim' }, { address: 'pieter@company.example', name: 'Pieter' }],
      cc: [{ address: 'Lisa@Company.example', name: 'Lisa' }],
      bcc: [],
      replyTo: [],
    },
    snippet: '',
    sentAt: null,
    receivedAt: '2026-10-19T08:00:00+00:00',
    flags: { seen: true, flagged: false, answered: false, draft: false },
    hasAttachments: false,
    attachmentScan: null,
    smartInboxId: null,
    verdict: null,
    summary: null,
    calendarMethod: null,
    ...overrides,
  }
}

describe('subjects', () => {
  it('adds one prefix whatever the original had', () => {
    expect(replySubject('Q4 budget')).toBe('Re: Q4 budget')
    expect(replySubject('RE: Re: AW: Q4 budget')).toBe('Re: Q4 budget')
    expect(replySubject('Re[2]: Q4 budget')).toBe('Re: Q4 budget')
    expect(forwardSubject('Fw: FWD: Q4 budget')).toBe('Fwd: Q4 budget')
  })
})

describe('replyRecipients', () => {
  it('replies to the sender', () => {
    expect(replyRecipients(message(), ['kim@company.example'], false)).toEqual({ to: [{ address: 'anna@finance.example', name: 'Anna de Vries' }], cc: [] })
  })

  it('prefers Reply-To', () => {
    const withReplyTo = message({ recipients: { ...message().recipients, replyTo: [{ address: 'team@finance.example', name: null }] } })
    expect(replyRecipients(withReplyTo, ['kim@company.example'], false).to).toEqual([{ address: 'team@finance.example', name: null }])
  })

  it('reply all copies everyone except the user, without duplicates', () => {
    const result = replyRecipients(message(), ['KIM@company.example'], true)

    expect(result.to.map((a) => a.address)).toEqual(['anna@finance.example'])
    expect(result.cc.map((a) => a.address)).toEqual(['pieter@company.example', 'Lisa@Company.example'])
  })

  it('replying to your own message goes to its recipients', () => {
    const own = message({ from: { address: 'kim@company.example', name: 'Kim' }, recipients: { to: [{ address: 'anna@finance.example', name: null }], cc: [{ address: 'pieter@company.example', name: null }], bcc: [], replyTo: [] } })

    expect(replyRecipients(own, ['kim@company.example'], true)).toEqual({ to: [{ address: 'anna@finance.example', name: null }], cc: [{ address: 'pieter@company.example', name: null }] })
  })
})

describe('quotedOriginal', () => {
  it('quotes a reply and escapes the header', () => {
    const html = quotedOriginal(message({ from: { address: 'a@x.example', name: '<b>Evil</b>' } }), { html: '<p>Hi</p>', text: null }, 'reply', 'en-GB')

    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt; &lt;a@x.example&gt; wrote:')
    expect(html).toContain('<blockquote><p>Hi</p></blockquote>')
  })

  it('writes the forwarded headers and falls back to escaped text', () => {
    const html = quotedOriginal(message(), { html: null, text: 'Line 1\n<script>' }, 'forward', 'en-GB')

    expect(html).toContain('Subject: Q4 budget')
    expect(html).toContain('Cc: Lisa &lt;Lisa@Company.example&gt;')
    expect(html).toContain('<p>Line 1<br>&lt;script&gt;</p>')
  })
})

describe('parseAddresses', () => {
  it('reads pasted lists', () => {
    expect(parseAddresses('Anna de Vries <anna@finance.example>; pieter@company.example, "Lisa B" <lisa@x.example>')).toEqual([
      { address: 'anna@finance.example', name: 'Anna de Vries' },
      { address: 'pieter@company.example', name: null },
      { address: 'lisa@x.example', name: 'Lisa B' },
    ])
  })

  it('keeps quoted names with commas and semicolons together, as Outlook copies them', () => {
    expect(parseAddresses('"Doe, John" <john@example.com>; "Smith; Ann" <ann@example.com>,\n"O\\"Brien, Pat" <pat@example.com>')).toEqual([
      { address: 'john@example.com', name: 'Doe, John' },
      { address: 'ann@example.com', name: 'Smith; Ann' },
      { address: 'pat@example.com', name: 'O"Brien, Pat' },
    ])
    expect(parseAddresses('a@b.c, d@e.f')).toEqual([
      { address: 'a@b.c', name: null },
      { address: 'd@e.f', name: null },
    ])
    // A quote that never closes is no name: the separators count.
    expect(parseAddresses('"Doe, a@b.c')).toEqual([
      { address: '"Doe', name: null },
      { address: 'a@b.c', name: null },
    ])
  })
})

describe('composeBody', () => {
  it('puts the signature between the text and the quote', () => {
    expect(composeBody('<p>Approved.</p>', '<p>Kim</p>', '<blockquote>Q</blockquote>')).toBe(
      '<p>Approved.</p><div class="tresso-signature"><p>Kim</p></div><div class="tresso-quote"><blockquote>Q</blockquote></div>',
    )
  })

  it('leaves out what is empty', () => {
    expect(composeBody('<p>Hi</p>', null, '')).toBe('<p>Hi</p>')
    expect(composeBody('<p>Hi</p>', '  ', '')).toBe('<p>Hi</p>')
  })
})

describe('sendLaterOptions', () => {
  it('offers this evening only before five, then tomorrow and next Monday, in local time', () => {
    // A Wednesday afternoon.
    const options = sendLaterOptions(new Date(2026, 9, 21, 14, 30))
    expect(options.map((option) => [option.key, option.at.getDate(), option.at.getHours()])).toEqual([
      ['thisEvening', 21, 18],
      ['tomorrowMorning', 22, 8],
      ['tomorrowAfternoon', 22, 13],
      ['mondayMorning', 26, 8],
    ])
    expect(sendLaterOptions(new Date(2026, 9, 21, 17, 0)).map((option) => option.key)).not.toContain('thisEvening')
  })

  it('leaves Monday out on a Sunday, when tomorrow morning is Monday morning', () => {
    expect(sendLaterOptions(new Date(2026, 9, 25, 18, 0)).map((option) => option.key)).toEqual(['tomorrowMorning', 'tomorrowAfternoon'])
  })

  it('takes Monday a week ahead when it is Monday already', () => {
    const monday = sendLaterOptions(new Date(2026, 9, 19, 9, 0)).find((option) => option.key === 'mondayMorning')
    expect(monday?.at.getDate()).toBe(26)
  })
})

describe('inline images in a quote', () => {
  const url = 'https://api.example.test/content/attachments/a1?_expiration=1&_hash=x'
  // As the body sanitizer writes it: `&` and `=` as entities.
  const quote = '<blockquote><img src="https://api.example.test/content/attachments/a1?_expiration&#61;1&amp;_hash&#61;x" alt="Logo" /></blockquote>'
  const image = { id: 'a1', inline: true, contentId: 'logo@example.test', url }

  it('finds the images a quote shows by their signed link, however it is written', () => {
    expect(quotedInlineImages(quote, [image, { ...image, id: 'a2', url: 'https://api.example.test/other' }, { ...image, id: 'a3', inline: false }])).toEqual([image])
    expect(quotedInlineImages(quote, [{ ...image, contentId: null }])).toEqual([])
    expect(quotedInlineImages(`<p>${url}</p>`, [image]), 'A link in the text is no image.').toEqual([])
  })

  it('refers to an image by its content id, and shows it again through a fresh link', () => {
    const sent = quoteWithContentId(quote, url, 'logo@example.test')
    expect(sent).toBe('<blockquote><img src="cid:logo@example.test" alt="Logo" /></blockquote>')
    expect(withInlineLinks(sent, [{ contentId: 'logo@example.test', url: 'https://fresh.test/a?b=1&c=2' }])).toBe('<blockquote><img src="https://fresh.test/a?b=1&amp;c=2" alt="Logo" /></blockquote>')
    expect(withInlineLinks(sent, [{ contentId: 'logo@example.test', url: null }])).toBe(sent)
  })

  it('also finds an image used as a background', () => {
    const table = `<table background="${url.replace('&', '&amp;')}"><tr><td><img alt="x" src='${url}'></td></tr></table><script src="${url}"></script>`
    expect(quotedInlineImages(table, [image])).toEqual([image])
    expect(quoteWithContentId(table, url, 'logo@example.test')).toBe(`<table background="cid:logo@example.test"><tr><td><img alt="x" src="cid:logo@example.test"></td></tr></table><script src="${url}"></script>`)
  })

  it('also finds an image an inline style shows', () => {
    const cell = `<td style="color:red;background-image:url(&quot;${url.replace(/&/g, '&amp;')}&quot;)">x</td>`
    expect(quotedInlineImages(cell, [image])).toEqual([image])
    const sent = quoteWithContentId(cell, url, 'logo@example.test')
    expect(sent).toBe('<td style="color:red;background-image:url(&quot;cid:logo@example.test&quot;)">x</td>')
    expect(withInlineLinks(sent, [{ contentId: 'logo@example.test', url: 'https://fresh.test/a?b=1&c=2' }])).toBe('<td style="color:red;background-image:url(&quot;https://fresh.test/a?b=1&amp;c=2&quot;)">x</td>')
  })

  it('does not take one content id for another that starts with it', () => {
    const html = '<img src="cid:a@b"><img src="cid:a@bc">'
    expect(withInlineLinks(html, [{ contentId: 'a@b', url: 'https://fresh.test/1' }])).toBe('<img src="https://fresh.test/1"><img src="cid:a@bc">')
  })
})
