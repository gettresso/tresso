<?php

declare(strict_types=1);

namespace App\Tests\Unit\Notification;

use App\Notification\EventPlace;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The place notifications show, rules read and travel is estimated to: every link goes, ordinary places stay as they
 * are, and a place that only says "online" is no place to travel to.
 */
final class EventPlaceTest extends TestCase
{
    /**
     * @return iterable<string, array{string, string}>
     */
    public static function places(): iterable
    {
        yield 'a room with a dot' => ['Room 3.2', 'Room 3.2'];
        yield 'a house number with a slash' => ['Herengracht 12/3', 'Herengracht 12/3'];
        yield 'a slash between words' => ['A/B room', 'A/B room'];
        yield 'an abbreviation' => ["St. John's", "St. John's"];
        yield 'an abbreviation with dots' => ['e.g. Room 4', 'e.g. Room 4'];
        yield 'a closing bracket of its own' => ['Herengracht office (3rd floor)', 'Herengracht office (3rd floor)'];
        yield 'a place in brackets' => ['(TBD)', '(TBD)'];
        yield 'non-Latin' => ['غرفة ٣', 'غرفة ٣'];
        yield 'a link in brackets' => ['Room 2 (https://teams.microsoft.com/l/meetup-join/x)', 'Room 2'];
        yield 'a link in fullwidth brackets' => ['会議室 3 （https://a.example/x）', '会議室 3'];
        yield 'a link in angle brackets' => ['<https://a.example/x>', ''];
        yield 'a link between separators' => ['Room 1, https://a.example/x, floor 2', 'Room 1, floor 2'];
        yield 'two links' => ['https://a.example/x, https://b.example/y', ''];
        yield 'a link before a no-break space' => ["https://a.example/x\u{A0}Room 9", 'Room 9'];
        yield 'upper case' => ['HTTPS://Teams.microsoft.com/x', ''];
        yield 'plain http' => ['http://teams.microsoft.com/l/meetup-join/secret', ''];
        yield 'an unknown app' => ['https://jitsi.example.org/SecretRoom', ''];
        yield 'a passcode in the query' => ['https://zoom.us/s/123?pwd=abc', ''];
        yield 'without a scheme' => ['teams.microsoft.com/l/meetup-join/19%3asecret', ''];
        yield 'an app scheme' => ['msteams://teams.microsoft.com/l/meetup-join/secret', ''];
        yield 'another app scheme' => ['Room 1 zoommtg://zoom.us/join?confno=1', 'Room 1'];
        yield 'glued to a word' => ['Roomhttps://teams.microsoft.com/l/meetup-join/secret', ''];
        yield 'starting with www' => ['Room 1 (www.example.com)', 'Room 1'];
        yield 'only dots' => ['...', ''];
        yield 'separators at either end' => ['- Room 5 -', 'Room 5'];
        yield 'a bracket left open' => ['Room ( https://a.example/x', 'Room'];
        yield 'a passcode typed as text stays' => ['Zoom ID 123 456 7890 Passcode 4321', 'Zoom ID 123 456 7890 Passcode 4321'];
        yield 'a dot and a slash in a place name' => ['St.Pauli/Hamburg', 'St.Pauli/Hamburg'];
        yield 'an abbreviated church' => ['H.Hart/kerk', 'H.Hart/kerk'];
        yield 'departments' => ['Dept.Sales/HR', 'Dept.Sales/HR'];
        yield 'a town after a slash' => ['St.Jan/Den Bosch', 'St.Jan/Den Bosch'];
        yield 'a floor' => ['Raum E.OG/1', 'Raum E.OG/1'];
        yield 'a district' => ['Kantoor Amsterdam.Zuid/WTC', 'Kantoor Amsterdam.Zuid/WTC'];
        yield 'two names' => ['Dr.Smith/Jones office', 'Dr.Smith/Jones office'];
        yield 'a building and a room' => ['Gebouw B.12/3', 'Gebouw B.12/3'];
        yield 'a hall' => ['Zaal 1.A/B', 'Zaal 1.A/B'];
        yield 'countries' => ['U.S./Canada room', 'U.S./Canada room'];
        yield 'a lower case abbreviation' => ['a.s.r./Utrecht', 'a.s.r./Utrecht'];
        yield 'a bare host stays' => ['zoom.us', 'zoom.us'];
        yield 'an unknown host with a capital stays' => ['Jitsi.example.org/room', 'Jitsi.example.org/room'];
        yield 'a lower case place written like a host loses that word' => ['kamer 2.og/3', 'kamer'];
        yield 'an IPv4 address with a path' => ['192.168.1.5/room?pwd=1', ''];
        yield 'an IPv4 address with a port' => ['Room 10.0.0.1:8443/join', 'Room'];
        yield 'an IPv6 address' => ['[2001:db8::1]/room', ''];
        yield 'a non-Latin top level domain' => ['example.рф/room', ''];
        yield 'a punycode top level domain' => ['example.xn--p1ai/room', ''];
        yield 'a host with a port' => ['meet.example.com:8443', ''];
        yield 'a host with a query' => ['zoom.us?pwd=abc', ''];
        yield 'a host with a fragment' => ['meet.google.com#abc', ''];
        // Commas and semicolons belong to links, so a word with a link goes whole, also what was glued to it.
        yield 'a link before a comma without a space' => ['https://a.example/x,Room 1', '1'];
        yield 'a semicolon in a query' => ['https://zoom.us/j/1?pwd=a;tk=SECRET', ''];
        yield 'a Teams context' => ['https://teams.microsoft.com/l/meetup-join/19%3ax/0?context={"Tid":"t-1","Oid":"o-2"}', ''];
        yield 'a map position' => ['Dam 1 https://www.google.com/maps/place/Dam/@52.3730796,4.8924534,17z/data=!3m1!4b1', 'Dam 1'];
        yield 'a map query' => ['https://maps.google.com/?q=52.37,4.89', ''];
        yield 'a semicolon in a path' => ['Room 1; https://x.example/a;b', 'Room 1'];
        yield 'a link without a scheme after a comma' => ['Room 1,zoom.us/j/1', 'Room 1'];
        yield 'a capital Zoom host' => ['Zoom.us/j/123456789?pwd=abc', ''];
        yield 'a capital Teams host' => ['Teams.Microsoft.com/l/meetup-join/x', ''];
        yield 'a capital Meet host' => ['Meet.google.com/abc-defg-hij', ''];
        yield 'an upper case Meet host' => ['MEET.GOOGLE.COM/abc-defg-hij', ''];
        yield 'a capital Webex host' => ['Room 1 Acme.webex.com/meet/kim', 'Room 1'];
        yield 'a label in brackets in the middle' => ['(see https://a.example/x) x', 'x'];
        yield 'two labels in brackets' => ['Room (see https://a.example/x) and (see https://b.example/y) hall', 'Room and hall'];
        yield 'a label in brackets with the link' => ['Room (see https://a.example/x)', 'Room'];
        yield 'a label with a colon in brackets' => ['Room 3 [link: https://a.example/x ]', 'Room 3'];
        yield 'a colon before the link' => ['Room 1: https://a.example/x', 'Room 1'];
        yield 'sentence punctuation stays' => ['Room 1!', 'Room 1!'];
    }

    #[DataProvider('places')]
    public function testLeavesThePlaceWithoutLinks(string $location, string $expected): void
    {
        self::assertSame($expected, EventPlace::withoutLinks($location));
    }

    public function testALongPlaceIsReadQuicklyAndKeptWhole(): void
    {
        $long = trim(str_repeat('Long place ', 2000));
        $started = microtime(true);

        self::assertSame($long, EventPlace::withoutLinks($long));
        self::assertSame(str_repeat('a.', 5000).'x', EventPlace::withoutLinks(str_repeat('a.', 5000).'x'));
        self::assertSame('', EventPlace::withoutLinks(str_repeat('x.yy', 3000).'/'));
        self::assertSame('', EventPlace::withoutLinks(str_repeat('(', 100000)));
        self::assertSame('', EventPlace::withoutLinks(str_repeat(')', 100000)));
        self::assertSame('', EventPlace::withoutLinks(str_repeat('( https://a.example/x ', 5000)));
        self::assertSame('', EventPlace::withoutLinks(str_repeat('Zoom.', 30000).'us/j/1'));
        self::assertSame(str_repeat('a.zoom.', 20000), EventPlace::withoutLinks(str_repeat('a.zoom.', 20000)));
        self::assertLessThan(1.0, microtime(true) - $started, 'No runaway backtracking.');
    }

    /**
     * @return iterable<string, array{string, bool}>
     */
    public static function meetingPlaces(): iterable
    {
        yield 'as Outlook writes it' => ['Microsoft Teams Meeting', true];
        yield 'in Dutch' => ['Microsoft Teams-vergadering', true];
        yield 'the last word of the app' => ['Teams', true];
        yield 'with meeting' => ['Teams Meeting', true];
        yield 'online' => ['Online', true];
        yield 'online meeting' => ['Online meeting', true];
        yield 'Zoom meeting' => ['Zoom Meeting', true];
        yield 'a call' => ['Webex call', true];
        yield 'with a period' => ['Microsoft Teams Meeting.', true];
        yield 'the word first' => ['Réunion Teams', true];
        yield 'the word first in Dutch' => ['Vergadering Teams', true];
        yield 'a meeting room' => ['Meeting Room', false];
        yield 'a Zoom room' => ['Zoom Room', false];
        yield 'a Webex room' => ['Webex Room', false];
        yield 'a Teams room' => ['Teams room', false];
        yield 'a Teams room in Dutch' => ['Teams-kamer', false];
        yield 'a department' => ['Online Marketing', false];
        yield 'a person' => ['Meet Kim', false];
    }

    #[DataProvider('meetingPlaces')]
    public function testKnowsAPlaceThatOnlySaysOnline(string $place, bool $expected): void
    {
        self::assertSame($expected, EventPlace::namesOnlyAMeeting($place));
        self::assertSame($expected ? '' : $place, EventPlace::toTravelTo($place));
    }
}
