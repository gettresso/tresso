<?php

declare(strict_types=1);

namespace App\Calendar;

/**
 * Whether a pasted meeting link (the user's own room link) may be kept and put into events and invitations. The link
 * is never fetched; this only checks its form. The same cases are in packages/core/src/calendar/meeting-links.json,
 * which the clients check their own rule against.
 *
 * A link is a capability, so the messages name what is wrong and never repeat the link.
 */
final class MeetingLinkAddress
{
    public const int MAX_LENGTH = 2048;

    public const string NOT_HTTPS = 'Use a link that starts with https://.';
    public const string HAS_CREDENTIALS = 'Use a link without a name or password in it.';
    public const string TOO_LONG = 'Use a link of at most 2048 characters.';

    /**
     * What is wrong with the link, or null when it may be used: it starts with https://, has a host of two or more
     * non-empty parts separated by dots, no name or password before the host, no whitespace, control characters or
     * backslashes, and at most {@see self::MAX_LENGTH} characters.
     */
    public static function violation(#[\SensitiveParameter] string $value): ?string
    {
        if (!mb_check_encoding($value, 'UTF-8')) {
            return self::NOT_HTTPS;
        }
        if (mb_strlen($value, 'UTF-8') > self::MAX_LENGTH) {
            return self::TOO_LONG;
        }
        // Whitespace and control characters (also the Unicode ones), and the backslash, which browsers read as a slash
        // and parse_url() does not: a link must mean the same host to both.
        if (1 === preg_match('/[\p{Cc}\p{Cf}\p{Z}\\\\]/u', $value) || !str_starts_with($value, 'https://')) {
            return self::NOT_HTTPS;
        }
        $parts = parse_url($value);
        if (false === $parts) {
            return self::NOT_HTTPS;
        }
        if (isset($parts['user']) || isset($parts['pass'])) {
            return self::HAS_CREDENTIALS;
        }
        // A host with a dot between two non-empty parts: no "localhost", no ".example".
        if (1 !== preg_match('/^[^.]+(\.[^.]+)+$/', $parts['host'] ?? '')) {
            return self::NOT_HTTPS;
        }

        return null;
    }
}
