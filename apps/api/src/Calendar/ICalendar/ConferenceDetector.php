<?php

declare(strict_types=1);

namespace App\Calendar\ICalendar;

use App\Calendar\MeetingJoinLine;
use App\Enum\CalendarSource;
use Sabre\VObject\Component\VEvent;

/**
 * Finds the online meeting of an event: first in the properties providers write for it (RFC 7986 CONFERENCE, Google's
 * X-GOOGLE-CONFERENCE, Microsoft's Teams properties), then in Tresso's join line at the end of the description
 * ({@see MeetingJoinLine}), then in links in the location, URL and description.
 *
 * @phpstan-import-type Conference from EventData
 */
final class ConferenceDetector
{
    /**
     * Join links per provider in free text; the first match wins. A link counts only where a link starts (at the start,
     * after whitespace, a quote, an angle bracket or a parenthesis), never inside another link's path or query.
     */
    private const array LINK_PATTERNS = [
        'teams' => '~(?<![^\s<>"\'(\[])https://teams\.(?:microsoft|live)\.com/(?:l/meetup-join|meet)/[^\s<>"\')\]]+~i',
        'meet' => '~(?<![^\s<>"\'(\[])https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?[^\s<>"\')\]]*)?~i',
        'zoom' => '~(?<![^\s<>"\'(\[])https://(?:[a-z0-9-]+\.)?zoom\.us/(?:j|my|w)/[^\s<>"\')\]]+~i',
        'webex' => '~(?<![^\s<>"\'(\[])https://[a-z0-9-]+\.webex\.com/(?:meet|join|[a-z0-9-]+/j\.php)[^\s<>"\')\]]*~i',
    ];

    /** The hosts of each app: exactly these, or (with a leading dot) any name under them. */
    private const array HOSTS = [
        'teams' => ['teams.microsoft.com', 'teams.live.com'],
        'meet' => ['meet.google.com'],
        'zoom' => ['zoom.us', '.zoom.us'],
        'webex' => ['.webex.com'],
    ];

    /**
     * @return Conference|null
     */
    public static function detect(VEvent $event): ?array
    {
        foreach (['X-GOOGLE-CONFERENCE' => 'meet', 'X-MICROSOFT-SKYPETEAMSMEETINGURL' => 'teams', 'X-MICROSOFT-ONLINEMEETINGCONFLINK' => 'teams'] as $property => $provider) {
            $url = self::text($event, $property);
            if (null !== $url && str_starts_with(strtolower($url), 'https://')) {
                return ['provider' => $provider, 'url' => $url, 'id' => null, 'dialIn' => self::dialIn($event)];
            }
        }

        foreach (Props::all($event, 'CONFERENCE') as $conference) {
            $url = trim(Props::value($conference));
            if (str_starts_with(strtolower($url), 'https://')) {
                return ['provider' => self::providerOf($url), 'url' => $url, 'id' => null, 'dialIn' => self::dialIn($event)];
            }
        }

        // The line Tresso keeps in the description for a link it knows: what carries that link through Google's and
        // Microsoft's version of the event. It wins over other meeting links in the text.
        $url = MeetingJoinLine::find(self::text($event, 'DESCRIPTION') ?? '');
        if (null !== $url) {
            return ['provider' => self::providerOf($url), 'url' => $url, 'id' => null, 'dialIn' => null];
        }

        $text = implode("\n", array_filter([self::text($event, 'LOCATION'), self::text($event, 'URL'), self::text($event, 'DESCRIPTION'), self::text($event, 'X-ALT-DESC')]));
        foreach (self::LINK_PATTERNS as $provider => $pattern) {
            if (1 === preg_match($pattern, $text, $match)) {
                return ['provider' => $provider, 'url' => html_entity_decode($match[0], \ENT_QUOTES | \ENT_HTML5), 'id' => null, 'dialIn' => null];
            }
        }

        return null;
    }

    /**
     * The app of a meeting link, by its host alone: an https link whose host is one of the app's (or under one), without
     * a user name before it. Anything else is `other`, also a link that carries an app's link in its path or query.
     */
    public static function providerOf(string $url): string
    {
        $parts = parse_url($url);
        if (false === $parts || 'https' !== strtolower($parts['scheme'] ?? '') || isset($parts['user']) || isset($parts['pass']) || !str_starts_with(strtolower($url), 'https://')) {
            return 'other';
        }
        $host = strtolower(rtrim($parts['host'] ?? '', '.'));
        foreach (self::HOSTS as $provider => $hosts) {
            foreach ($hosts as $known) {
                if (str_starts_with($known, '.') ? str_ends_with($host, $known) && \strlen($host) > \strlen($known) : $host === $known) {
                    return $provider;
                }
            }
        }

        return 'other';
    }

    /**
     * Whether Tresso can take the event's meeting off it: not a Teams meeting Microsoft made on its own calendar's event
     * (Graph keeps it until the event is deleted).
     */
    public static function removable(VEvent $event, CalendarSource $source): bool
    {
        return !(CalendarSource::Microsoft === $source && null !== self::text($event, 'X-MICROSOFT-SKYPETEAMSMEETINGURL'));
    }

    private static function dialIn(VEvent $event): ?string
    {
        foreach (Props::all($event, 'CONFERENCE') as $conference) {
            $url = trim(Props::value($conference));
            if (str_starts_with(strtolower($url), 'tel:')) {
                return substr($url, 4);
            }
        }

        return null;
    }

    private static function text(VEvent $event, string $property): ?string
    {
        return Props::text($event, $property);
    }
}
