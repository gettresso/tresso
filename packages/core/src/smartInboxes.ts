/** Wire format of /api/v1/smart-inboxes, /api/v1/threads/{id}/classification and /api/v1/sender-rules, and helpers. */

import type { Verdict } from './domain'
import type { SyncedSmartInbox } from './sync/types'

export type SmartInbox = SyncedSmartInbox

export interface NewSmartInbox {
  name: string
  instructions: string
  includeSenders: string[]
  excludeSenders: string[]
  verdict: Verdict
  /** New unread mail judged `do` here becomes a todo; only with the `do` verdict. */
  autoCreateTodo: boolean
  /** Hold new mail until the user's next batch time; false when left out. */
  batchDelivery?: boolean
}

/** JSON merge patch: omitted fields stay as they are; the lists are replaced as a whole. */
export type SmartInboxUpdate = Partial<NewSmartInbox>

/**
 * Where the user puts a conversation. Without `verdict` it gets the smart inbox's. With `remember: false` only this
 * conversation moves: no sender rule is made (triage decides one email at a time).
 */
export interface ThreadClassificationRequest {
  smartInboxId: string
  verdict?: Verdict
  remember?: boolean
}

export interface ThreadClassification {
  threadId: string
  smartInboxId: string
  verdict: Verdict
  reason: string
  /** The sender rule the choice was remembered as; null for a conversation with only the user's own mail. */
  senderRule: {
    id: string
    sender: string
    verdict: Verdict | null
    /**
     * Why new mail like this keeps going to Spam despite the rule, or null when the rule applies: it fails
     * authentication (DMARC with a reject or quarantine policy), or the mail server marks it as spam and its sender is
     * not authenticated in a header Tresso can trust. This conversation stays where the user put it either way.
     */
    spamOverrules: SpamOverrule | null
  } | null
  /** This placement; taking it back (`DELETE /threads/{id}/classification?placementId=`) names it. */
  placementId: string
}

/** What keeps sending a sender's mail to Spam whatever the user remembered for them. */
export type SpamOverrule = 'authentication_failed' | 'server_spam'

/** What to tell the user after a correction whose rule cannot help new mail from the sender, or null. */
export function spamOverruleNotice(result: Pick<ThreadClassification, 'senderRule'>): string | null {
  const rule = result.senderRule
  switch (rule?.spamOverrules ?? null) {
    case 'authentication_failed':
      return `Moved. New mail from ${rule!.sender} still goes to Spam: it fails the checks that prove who sent it.`
    case 'server_spam':
      return `Moved. Your mail server marks mail from ${rule!.sender} as spam, so new mail from them still goes to Spam.`
    default:
      return null
  }
}

/** A correction remembered for a sender: their mail goes to the smart inbox, with the verdict when set. */
export interface SenderRule {
  id: string
  /** An address, or `@domain`. */
  sender: string
  smartInboxId: string
  verdict: Verdict | null
  updatedAt: string
}

/** Every verdict, in the order they are offered. */
export const VERDICTS: readonly Verdict[] = ['do', 'delegate', 'know', 'none']

export function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case 'do':
      return 'Do'
    case 'delegate':
      return 'Hand over'
    case 'know':
      return 'Know'
    case 'none':
      return 'None'
  }
}

/** Mirrors App\Classification\SenderPattern::REGEX: an address, or `@` and a domain with at least one dot. */
export const SENDER_PATTERN = /^[^@\s]*@[^@\s.]+(\.[^@\s.]+)+$/

export function normalizeSenderPattern(pattern: string): string {
  return pattern.trim().toLowerCase()
}

export function isSenderPattern(pattern: string): boolean {
  return SENDER_PATTERN.test(normalizeSenderPattern(pattern))
}

/** Sidebar order. */
export function sortSmartInboxes<T extends Pick<SyncedSmartInbox, 'position' | 'id'>>(smartInboxes: T[]): T[] {
  return [...smartInboxes].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
}

/** The line icon of a smart inbox, named as the web app's AppIcon names it. */
export type SmartInboxIcon = 'do' | 'know' | 'bell' | 'news' | 'shieldAlert' | 'filter'

/**
 * The icon of a smart inbox in the sidebar and in Settings. It follows the built-in kind only, never the name: a smart
 * inbox the user made and called "Spam" still gets the icon of the user's own smart inboxes.
 */
export function smartInboxIcon(smartInbox: Pick<SyncedSmartInbox, 'builtin'>): SmartInboxIcon {
  switch (smartInbox.builtin) {
    case 'todo':
      return 'do'
    case 'informational':
      return 'know'
    case 'notification':
      return 'bell'
    case 'advertise':
      return 'news'
    case 'spam':
      return 'shieldAlert'
    case null:
      return 'filter'
  }
}

/** Why a conversation is in its smart inbox, in words; mirrors App\Classification\ClassificationReason. */
export function classificationReasonText(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null
    case 'user':
      return 'You put it here.'
    case 'sender_rule':
      return 'You put mail from this sender here before.'
    case 'include_list':
      return 'The sender is on the include list.'
    case 'server_spam':
      return 'The mail server marked it as junk.'
    case 'authentication_failed':
      return 'It failed the checks that prove who sent it.'
    case 'automated':
      return 'A machine sent it.'
    case 'marketing_sender':
      return 'It comes from a marketing address.'
    case 'bulk':
      return 'It was sent in bulk.'
    case 'notification_sender':
      return 'It comes from an address that takes no replies.'
    case 'unsubscribe_link':
      return 'It has an unsubscribe link.'
    case 'mailing_list':
      return 'It came through a mailing list.'
    case 'direct':
      return 'Someone wrote to you directly.'
    case 'copied':
      return 'You are in copy.'
    default:
      return 'Classified automatically.'
  }
}
