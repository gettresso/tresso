<?php

declare(strict_types=1);

namespace App\Notification;

/**
 * An event's place as notifications show it, rules read it and travel is estimated to: without links, since a meeting
 * link is often written there and is a capability (anyone with it may join), and the geocoder must never get one.
 *
 * Every step is linear in the length of the place: a place is free text from anyone who sends an invitation, has no
 * length limit, and is read for every occurrence that is planned.
 */
final class EventPlace
{
    /** Stands where a link was taken out, so what it stood in can be found afterwards. Private use, never in input. */
    private const string MARK = "\u{E000}";

    /** A link with a scheme (also msteams:// and other app schemes, and one glued to a word), or one starting with "www.". */
    private const string LINK = '~://|(?:^|[^\p{L}\p{N}])www\.~iu';

    /**
     * A link written without its scheme: a host followed by a path, query, fragment or port. Its host is in lower case
     * (as a typed host practically always is), so place names with a dot and a slash ("St.Pauli/Hamburg",
     * "Dept.Sales/HR", "U.S./Canada room") are not taken for one. Also an IPv4 address with a path or port, and an IPv6
     * address in brackets.
     */
    private const string BARE_LINK = '~(?<![\p{L}\p{N}.\-])(?:[\p{Ll}\p{N}\-]+\.)+(?:xn--[a-z0-9\-]+|\p{Ll}{2,})(?::\d+)?[/?#]'
        .'|(?<![\p{L}\p{N}.\-])(?:[\p{Ll}\p{N}\-]+\.)+(?:xn--[a-z0-9\-]+|\p{Ll}{2,}):\d+(?!\p{L})'
        .'|(?<![\p{N}.])(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?[/?#:]'
        .'|\[[0-9a-fA-F]*:[0-9a-fA-F]*:[0-9a-fA-F:]*\]~u';

    /** The names of the apps, and the words their places are written with ("Microsoft Teams Meeting"). */
    private const string ONLY_A_MEETING = '/^(?:microsoft teams|teams|google meet|meet|zoom|webex|online)(?:[ \-](?:meeting|vergadering|besprechung|réunion|reunión|call|link))?$/iu';

    /**
     * The place without links. Words are split at whitespace, commas and semicolons; every word that holds a link goes
     * as a whole. What the links stood in goes too: a bracket group with at most a label word beside the link ("(see
     * <link>)", "[link: <link>]"), brackets left empty, separators left doubled or at either end, a colon at the end, a
     * bracket left open at the end or closed at the start. A place without any letter or digit left is no place: "".
     */
    public static function withoutLinks(string $location): string
    {
        $pieces = preg_split('/(\s+|[,;])/u', mb_scrub(str_replace(self::MARK, '', $location), 'UTF-8'), -1, \PREG_SPLIT_DELIM_CAPTURE | \PREG_SPLIT_NO_EMPTY);
        $place = '';
        foreach (\is_array($pieces) ? $pieces : [] as $piece) {
            $place .= 1 === preg_match(self::LINK, $piece) || 1 === preg_match(self::BARE_LINK, $piece) ? self::MARK : $piece;
        }
        $place = (string) preg_replace(
            [
                '/[(\[<（]\s*(?:\p{L}+:?\s+)?'.self::MARK.'[\s,;:.]*(?:[)\]>）]|$)/u',
                '/'.self::MARK.'/u',
                '/\s+/u',
                '/\(\s*\)|\[\s*\]|<\s*>|（\s*）/u',
                '/\s*([,;|])(?:\s*[,;|])+/u',
                '/^[\s,;|:\-)\]>）]+/u',
            ],
            ['', '', ' ', '', '$1', ''],
            $place,
        );
        $place = 1 === preg_match('/^.*[^\s,;|:\-(\[<（]/su', $place, $match) ? $match[0] : '';

        return 1 === preg_match('/[\p{L}\p{N}]/u', $place) ? $place : '';
    }

    /**
     * Whether a place only says the event is online: an app's name (or its last word), or "online", alone or with one
     * of the words a meeting is written with ("Microsoft Teams Meeting" as Outlook writes it, "Microsoft
     * Teams-vergadering", "Zoom Meeting", "Online meeting"). "Zoom Room" or "Meet Kim" is a place.
     */
    public static function namesOnlyAMeeting(string $place): bool
    {
        return 1 === preg_match(self::ONLY_A_MEETING, $place);
    }

    /** The place to travel to and to match place rules with: without links, and "" for one that only says "online". */
    public static function toTravelTo(string $location): string
    {
        $place = self::withoutLinks($location);

        return self::namesOnlyAMeeting($place) ? '' : $place;
    }
}
