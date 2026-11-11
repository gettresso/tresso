import type { Address, SyncedMessage } from './sync/types'

/** POST /api/v1/outgoing-messages */
export interface SendMessageRequest {
  /**
   * The id the client chose for the message (a UUIDv7 made when the user pressed Send): the server queues one message
   * per id, so the same request sent again after its answer was lost returns that message. A server that does not
   * know the field ignores it.
   */
  outgoingId?: string
  mailAccountId: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  inReplyToMessageId?: string
  /** ISO 8601; omitted sends right away. */
  sendAt?: string
  /** The draft it was written in; the server removes it once the message is queued. */
  draftId?: string
  /** The user confirmed sending the draft's files that could not be scanned for malware. */
  acceptUnscanned?: boolean
}

/** POST /api/v1/drafts (with `draftId`) and PUT /api/v1/drafts/{id} (with `expectedVersion`). */
export interface DraftRequest {
  draftId?: string
  expectedVersion?: number
  mailAccountId: string | null
  kind: 'new' | 'reply' | 'replyAll' | 'forward'
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  signatureId: string | null
  quoteHtml: string
  inReplyToMessageId: string | null
}

const REPLY_PREFIX = /^\s*((re|aw|sv|antw|vs|r)\s*(\[\d+\])?\s*:\s*)+/i
const FORWARD_PREFIX = /^\s*((fwd?|wg|doorst|tr|rv)\s*:\s*)+/i

export function replySubject(subject: string): string {
  const base = subject.replace(REPLY_PREFIX, '').trim()
  return `Re: ${base}`
}

export function forwardSubject(subject: string): string {
  const base = subject.replace(FORWARD_PREFIX, '').trim()
  return `Fwd: ${base}`
}

function key(address: Address): string {
  return address.address.trim().toLowerCase()
}

function unique(addresses: Address[], exclude: Set<string>): Address[] {
  const seen = new Set(exclude)
  const result: Address[] = []
  for (const address of addresses) {
    const k = key(address)
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    result.push(address)
  }
  return result
}

/**
 * Who a reply goes to. A reply goes to Reply-To (or the sender); reply all adds everyone else on To and Cc. The
 * user's own addresses never get mail from themselves, except when they reply to a message they sent: then it goes
 * to that message's recipients again.
 */
export function replyRecipients(message: SyncedMessage, ownAddresses: string[], all: boolean): { to: Address[]; cc: Address[] } {
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()))
  const fromSelf = own.has(key(message.from))
  const primary = fromSelf ? message.recipients.to : message.recipients.replyTo.length > 0 ? message.recipients.replyTo : [message.from]
  const to = unique(primary, own)
  if (!all) {
    return { to: to.length > 0 ? to : unique([message.from], new Set()), cc: [] }
  }
  const taken = new Set([...own, ...to.map(key)])
  const others = fromSelf ? message.recipients.cc : [...message.recipients.to, ...message.recipients.cc]

  return { to: to.length > 0 ? to : unique([message.from], new Set()), cc: unique(others, taken) }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatAddress(address: Address): string {
  return address.name ? `${address.name} <${address.address}>` : address.address
}

/**
 * The quoted original below a reply or forward. `body` is the original's sanitized HTML from the API (or its text,
 * escaped). Dates are written in the writer's locale.
 */
export function quotedOriginal(message: SyncedMessage, body: { html: string | null; text: string | null }, kind: 'reply' | 'forward', locale?: string): string {
  const date = new Date(message.receivedAt).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short' })
  const content = body.html ?? `<p>${escapeHtml(body.text ?? '').replace(/\n/g, '<br>')}</p>`
  if (kind === 'reply') {
    return `<p>On ${escapeHtml(date)}, ${escapeHtml(formatAddress(message.from))} wrote:</p><blockquote>${content}</blockquote>`
  }
  const lines = [
    `From: ${formatAddress(message.from)}`,
    `Date: ${date}`,
    `Subject: ${message.subject}`,
    `To: ${message.recipients.to.map(formatAddress).join(', ')}`,
    ...(message.recipients.cc.length > 0 ? [`Cc: ${message.recipients.cc.map(formatAddress).join(', ')}`] : []),
  ]
  return `<p>---------- Forwarded message ----------<br>${lines.map(escapeHtml).join('<br>')}</p>${content}`
}

/** A rough check before sending; the API validates for real. */
export function isPlausibleAddress(value: string): boolean {
  return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(value.trim())
}

/**
 * Parses what users paste: "Name <a@b.c>", "a@b.c", several separated by commas, semicolons or line breaks. A quoted
 * name may hold those itself, as in the "Doe, John" <john@example.com> that Outlook copies.
 */
export function parseAddresses(input: string): Address[] {
  const result: Address[] = []
  for (const part of splitAddresses(input)) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const match = /^(.*?)<([^>]+)>$/.exec(trimmed)
    if (match) {
      const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(match[1]!.trim())
      const name = quoted === null ? match[1]!.trim() : quoted[1]!.replace(/\\(.)/g, '$1')
      result.push({ address: match[2]!.trim(), name: name === '' ? null : name })
    } else {
      result.push({ address: trimmed, name: null })
    }
  }
  return result
}

/** The addresses of a pasted list, cut at commas, semicolons and line breaks outside quotes and angle brackets. */
function splitAddresses(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angle = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    if (quoted && char === '\\' && index + 1 < input.length) {
      current += char + input[index + 1]!
      index++
      continue
    }
    if (char === '"' && !angle) {
      quoted = !quoted
    } else if (!quoted && char === '<') {
      angle = true
    } else if (!quoted && char === '>') {
      angle = false
    } else if (!quoted && !angle && (char === ',' || char === ';' || char === '\n')) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (quoted || angle) {
    // A quote or bracket that never closes is no name: every separator counts, as typed.
    return input.split(/[,;\n]/)
  }
  parts.push(current)
  return parts
}

/**
 * The HTML that is sent: what the user wrote, then the signature, then the quoted original, as mail clients expect
 * in a reply. The signature and quote are kept apart while writing so changing the sending account can swap the
 * signature without touching the text.
 */
export function composeBody(html: string, signatureHtml: string | null, quoteHtml: string): string {
  const parts = [html]
  if (signatureHtml !== null && signatureHtml.trim() !== '') {
    parts.push(`<div class="tresso-signature">${signatureHtml}</div>`)
  }
  if (quoteHtml.trim() !== '') {
    parts.push(`<div class="tresso-quote">${quoteHtml}</div>`)
  }
  return parts.join('')
}

export type SendLaterKey = 'thisEvening' | 'tomorrowMorning' | 'tomorrowAfternoon' | 'mondayMorning'

function onDay(now: Date, days: number, hour: number): Date {
  const date = new Date(now)
  date.setDate(date.getDate() + days)
  date.setHours(hour, 0, 0, 0)
  return date
}

/**
 * The times "Send later" offers, in the device's time zone: this evening (until 17:00), tomorrow morning and
 * afternoon, and next Monday morning (a week ahead on a Monday; not on a Sunday, when it is tomorrow morning). Each
 * client words them itself.
 */
export function sendLaterOptions(now: Date = new Date()): { key: SendLaterKey; at: Date }[] {
  const nextMonday = (8 - now.getDay()) % 7 || 7
  const options: { key: SendLaterKey; at: Date }[] = [
    { key: 'tomorrowMorning', at: onDay(now, 1, 8) },
    { key: 'tomorrowAfternoon', at: onDay(now, 1, 13) },
  ]
  // On a Sunday, tomorrow morning is Monday morning already.
  if (nextMonday !== 1) {
    options.push({ key: 'mondayMorning', at: onDay(now, nextMonday, 8) })
  }
  if (now.getHours() < 17) {
    options.unshift({ key: 'thisEvening', at: onDay(now, 0, 18) })
  }
  return options
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', equals: '=' }

/** An attribute's value as a browser reads it: `&amp;`, `&#61;` and the like written out. */
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity: string, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
    return ENTITIES[name.toLowerCase()] ?? entity
  })
}

const TAG = /<([a-z][a-z0-9-]*)\b[^>]*>/gi
const IMAGE_ATTRIBUTE = /(\s(src|background|style)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
const CSS_URL = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi

/**
 * Every image source in the HTML, read as a browser reads it, with a way to give it another one: an image's src, any
 * element's background, and url() in inline styles (the body sanitizer resolves all three).
 */
function mapImageSources(html: string, change: (source: string) => string | null): string {
  return html.replace(TAG, (tag: string, name: string) =>
    tag.replace(IMAGE_ATTRIBUTE, (whole: string, before: string, attribute: string, double?: string, single?: string, bare?: string) => {
      const kind = attribute.toLowerCase()
      if (kind === 'src' && name.toLowerCase() !== 'img') {
        return whole
      }
      const value = decodeAttribute(double ?? single ?? bare ?? '')
      if (kind === 'style') {
        let changed = false
        const style = value.replace(CSS_URL, (url: string, quote: string, source: string) => {
          const next = change(source.trim())
          if (next === null) {
            return url
          }
          changed = true
          return `url(${quote}${next}${quote})`
        })
        return changed ? `${before}"${escapeAttribute(style)}"` : whole
      }
      const next = change(value)
      return next === null ? whole : `${before}"${escapeAttribute(next)}"`
    }),
  )
}

function imageSources(html: string): Set<string> {
  const sources = new Set<string>()
  mapImageSources(html, (source) => {
    sources.add(source)
    return null
  })
  return sources
}

/**
 * The quote with one inline image referred to by its content id instead of the signed link the body was shown with:
 * links expire within the hour, while the image goes along with the message.
 */
export function quoteWithContentId(quoteHtml: string, url: string, contentId: string): string {
  return mapImageSources(quoteHtml, (source) => (source === url ? `cid:${contentId}` : null))
}

/** The inline images of a body that a quote shows, by their signed link. */
export function quotedInlineImages<T extends { inline: boolean; contentId: string | null; url: string | null }>(quoteHtml: string, attachments: T[]): (T & { contentId: string; url: string })[] {
  const sources = imageSources(quoteHtml)
  return attachments.filter(
    (attachment): attachment is T & { contentId: string; url: string } => attachment.inline && attachment.contentId !== null && attachment.url !== null && sources.has(attachment.url),
  )
}

/** For showing a draft on screen: its cid: images through the given links (fresh ones, from the draft's endpoint). */
export function withInlineLinks(html: string, links: { contentId?: string | null; url: string | null }[]): string {
  const byContentId = new Map<string, string>()
  for (const link of links) {
    if (link.contentId && link.url) {
      byContentId.set(`cid:${link.contentId}`, link.url)
    }
  }
  return byContentId.size === 0 ? html : mapImageSources(html, (source) => byContentId.get(source) ?? null)
}
