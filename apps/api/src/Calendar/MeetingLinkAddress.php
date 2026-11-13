<?php

declare(strict_types=1);

namespace App\Calendar;

/**
 * Whether a pasted meeting link (the user's own room link) may be kept and put into events and invitations. The link
 * is never fetched and never changed; this only checks its form, by the same rule as `meetingLinkProblem` in
 * packages/core/src/calendar/meeting.ts (parsed by hand there too, so both read a link the same way):
 *
 * - at most {@see self::MAX_LENGTH} characters, counted as JavaScript counts them (UTF-16 code units);
 * - no whitespace, no control characters and no invisible ones that can disguise where a link leads (zero width,
 *   direction marks, overrides and isolates, Hangul fillers);
 * - it starts with "https://" exactly (an upper case scheme is refused, as on the clients);
 * - no backslash, no user name or password, a port from 1 to 65535 if any;
 * - a named host of two or more labels: no localhost, no IP address, no last label that reads as a number (digits, or
 *   0x and hex digits); labels of letters, digits and inner hyphens (no underscore), at most 63 characters each.
 *
 * A link is a capability, so the messages name what is wrong and never repeat the link.
 */
final class MeetingLinkAddress
{
    public const int MAX_LENGTH = 2048;

    /** The problems, by the codes of packages/core's MeetingLinkProblem. */
    public const string EMPTY = 'empty';
    public const string TOO_LONG = 'too_long';
    public const string WHITESPACE = 'whitespace';
    public const string CONTROL = 'control';
    public const string NOT_HTTPS = 'not_https';
    public const string CREDENTIALS = 'credentials';
    public const string NO_HOST = 'no_host';
    public const string INVALID = 'invalid';

    // JavaScript's \s: what /\s/u finds on the clients.
    private const string WHITESPACE_PATTERN = '/[\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]/u';
    // C0 and C1 controls, DEL, soft hyphen, zero width characters, direction marks, embeddings, overrides and isolates,
    // the interlinear annotation and object replacement characters, and the Hangul fillers that show as nothing.
    private const string HIDDEN_PATTERN = '/[\x{00}-\x{1F}\x{7F}-\x{9F}\x{AD}\x{061C}\x{115F}\x{1160}\x{180E}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{2066}-\x{206F}\x{3164}\x{FEFF}\x{FFA0}\x{FFF9}-\x{FFFC}]/u';
    private const string LABEL_PATTERN = '/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u';

    /**
     * What is wrong with the link, as a code of packages/core's MeetingLinkProblem, or null when it may be used.
     */
    public static function problem(#[\SensitiveParameter] string $value): ?string
    {
        if ('' === $value) {
            return self::EMPTY;
        }
        if (!mb_check_encoding($value, 'UTF-8')) {
            return self::CONTROL;
        }
        if (self::length($value) > self::MAX_LENGTH) {
            return self::TOO_LONG;
        }
        if (1 === preg_match(self::WHITESPACE_PATTERN, $value)) {
            return self::WHITESPACE;
        }
        if (1 === preg_match(self::HIDDEN_PATTERN, $value)) {
            return self::CONTROL;
        }
        if (!str_starts_with($value, 'https://')) {
            return self::NOT_HTTPS;
        }
        if (str_contains($value, '\\')) {
            return self::INVALID;
        }
        $rest = substr($value, \strlen('https://'));
        $authority = substr($rest, 0, strcspn($rest, '/?#'));
        if (str_contains($authority, '@')) {
            return self::CREDENTIALS;
        }
        if (1 !== preg_match('/^([^:]*)(?::(\d*))?$/', $authority, $match)) {
            return str_starts_with($authority, '[') ? self::NO_HOST : self::INVALID;
        }
        $host = $match[1];
        $port = $match[2] ?? null;
        if (null !== $port && ('' === $port || \strlen($port) > 5 || (int) $port < 1 || (int) $port > 65535)) {
            return self::INVALID;
        }
        $labels = explode('.', str_ends_with($host, '.') ? substr($host, 0, -1) : $host);
        // A last label that reads as a number makes the host an IP address to a browser.
        if ('' === $host || \count($labels) < 2 || 1 === preg_match('/^(?:[0-9]+|0[xX][0-9a-fA-F]*)$/', $labels[\count($labels) - 1])) {
            return self::NO_HOST;
        }
        foreach ($labels as $label) {
            if (self::length($label) > 63 || 1 !== preg_match(self::LABEL_PATTERN, $label)) {
                return self::INVALID;
            }
        }

        return null;
    }

    /** The length as JavaScript's String.length gives it: UTF-16 code units. */
    private static function length(string $value): int
    {
        return \intdiv(\strlen((string) mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')), 2);
    }

    /**
     * What the own link field says about the link, or null when it may be used: the texts of packages/core's
     * meetingLinkError, never the value itself.
     */
    public static function violation(#[\SensitiveParameter] string $value): ?string
    {
        return match (self::problem($value)) {
            null => null,
            self::EMPTY => 'Paste your room link.',
            self::TOO_LONG => \sprintf('Use a link of at most %d characters.', self::MAX_LENGTH),
            self::WHITESPACE, self::CONTROL => 'Use a link without spaces, line breaks or hidden characters.',
            self::CREDENTIALS => 'Use a link without a user name or password in it.',
            self::NO_HOST => 'Use a link with a full web address, such as https://meet.example.com/room.',
            default => 'Use a link that starts with https://.',
        };
    }
}
