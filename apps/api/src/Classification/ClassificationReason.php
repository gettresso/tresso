<?php

declare(strict_types=1);

namespace App\Classification;

/**
 * Why mail is in its smart inbox. Clients show it, so they explain the outcome. Another classifier may use its own
 * reasons (an AI classifier would use `ai`); clients show those as "classified automatically".
 */
final class ClassificationReason
{
    /** The user put this conversation here. Automatic classification leaves it alone from then on. */
    public const string USER = 'user';
    /** The user once moved mail from this sender (or domain) here. */
    public const string SENDER_RULE = 'sender_rule';
    /** The sender is on the smart inbox's include list. */
    public const string INCLUDE_LIST = 'include_list';
    /** The mail server put it in a junk folder, flagged it as junk, or its spam filter said so. */
    public const string SERVER_SPAM = 'server_spam';
    /** The sender's domain says to reject or quarantine mail that fails authentication, and this mail failed. */
    public const string AUTHENTICATION_FAILED = 'authentication_failed';
    /** Auto-Submitted or Precedence says a machine sent it. */
    public const string AUTOMATED = 'automated';
    /** The sender's address is one marketing mail comes from (newsletter@, news., promo., ...). */
    public const string MARKETING_SENDER = 'marketing_sender';
    /** Bulk mail headers: Precedence: bulk, or an unsubscribe link with a feedback id. */
    public const string BULK = 'bulk';
    /** The sender's address is one that does not take replies (noreply@, notifications@, alerts., ...). */
    public const string NOTIFICATION_SENDER = 'notification_sender';
    /** It has an unsubscribe link and nothing that marks it as written by a person. */
    public const string UNSUBSCRIBE_LINK = 'unsubscribe_link';
    /** It came through a mailing list. */
    public const string MAILING_LIST = 'mailing_list';
    /** A person wrote to the user directly (the user is in To). */
    public const string DIRECT = 'direct';
    /** A person wrote it, and the user is only in Cc or Bcc. */
    public const string COPIED = 'copied';
}
