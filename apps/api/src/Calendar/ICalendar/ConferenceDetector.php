<?php

declare(strict_types=1);

namespace App\Calendar\ICalendar;

use App\Calendar\MeetingJoinLine;
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
    /** Join links per provider; the first match in the text wins. */
    private const array LINK_PATTERNS = [
        'teams' => '~https://teams\.(?:microsoft|live)\.com/(?:l/meetup-join|meet)/[^\s<>"\')\]]+~i',
        'meet' => '~https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?[^\s<>"\')\]]*)?~i',
        'zoom' => '~https://(?:[a-z0-9-]+\.)?zoom\.us/(?:j|my|w)/[^\s<>"\')\]]+~i',
        'webex' => '~https://[a-z0-9-]+\.webex\.com/(?:meet|join|[a-z0-9-]+/j\.php)[^\s<>"\')\]]*~i',
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

    public static function providerOf(string $url): string
    {
        foreach (self::LINK_PATTERNS as $provider => $pattern) {
            if (1 === preg_match($pattern, $url)) {
                return $provider;
            }
        }

        return 'other';
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
