<?php

declare(strict_types=1);

namespace App\Calendar;

/**
 * The one line Tresso keeps at the end of an event's description for a meeting link it knows (the user's own link):
 * "Join the meeting: <url>", or "Join with <App>: <url>" when the link is of a known app. Google and Microsoft take no
 * conference from an API client, so this line is what carries the link through their version of the event, and what
 * guests see in any calendar app and invitation. {@see \App\Calendar\ICalendar\ConferenceDetector} reads it back.
 *
 * The line is managed on every change of the link: every such line is removed, then the current one appended.
 */
final class MeetingJoinLine
{
    /**
     * One line of its own: the link runs up to the first whitespace (also a no-break or other Unicode space), and spaces
     * or tabs may follow it before the line ends.
     */
    public const string PATTERN = '/^Join (?:the meeting|with [^:\r\n]{1,40}): (https:\/\/[^\s\x{A0}\x{1680}\x{2000}-\x{200B}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+)[ \t\x{A0}]*$/mu';

    /** The link of the last join line in the description, or null when it has none. */
    public static function find(string $description): ?string
    {
        if (preg_match_all(self::PATTERN, self::lines($description), $matches) < 1) {
            return null;
        }

        return $matches[1][\count($matches[1]) - 1];
    }

    /**
     * The description without any join line, and without the empty lines that left at its end. A description without
     * a join line comes back as it is.
     */
    public static function strip(string $description): string
    {
        $text = self::lines($description);
        if (1 !== preg_match(self::PATTERN, $text)) {
            return $description;
        }
        $kept = array_filter(explode("\n", $text), static fn (string $line): bool => 1 !== preg_match(self::PATTERN, $line));

        return rtrim(implode("\n", $kept));
    }

    /**
     * The description with exactly one join line for $url at its end (after an empty line), or none when $url is null.
     *
     * @param string $provider the link's app as {@see \App\Calendar\ICalendar\ConferenceDetector::providerOf()} names it
     */
    public static function with(string $description, #[\SensitiveParameter] ?string $url, string $provider): string
    {
        $stripped = self::strip($description);
        if (null === $url) {
            return $stripped;
        }
        $line = self::label($provider, $url);

        return '' === trim($stripped) ? $line : rtrim($stripped)."\n\n".$line;
    }

    public static function label(string $provider, #[\SensitiveParameter] string $url): string
    {
        return self::prefix($provider).' '.$url;
    }

    /** "Join with Microsoft Teams:" and so on, or "Join the meeting:" for a link of no known app. */
    public static function prefix(string $provider): string
    {
        return match ($provider) {
            'teams' => 'Join with Microsoft Teams:',
            'meet' => 'Join with Google Meet:',
            'zoom' => 'Join with Zoom:',
            'webex' => 'Join with Webex:',
            default => 'Join the meeting:',
        };
    }

    /** Line ends as "\n" only, so the pattern's line anchors find every line. */
    private static function lines(string $text): string
    {
        return str_replace(["\r\n", "\r"], "\n", $text);
    }
}
