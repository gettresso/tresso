<?php

declare(strict_types=1);

namespace App\Tests\Unit\Notification;

use App\Notification\NotificationPlanner;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The place notifications show and travel is estimated to: every link goes, ordinary places stay as they are.
 */
final class PlaceWithoutLinksTest extends TestCase
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
    }

    #[DataProvider('places')]
    public function testLeavesThePlaceWithoutLinks(string $location, string $expected): void
    {
        self::assertSame($expected, NotificationPlanner::placeWithoutLinks($location));
    }

    public function testALongPlaceIsReadQuicklyAndKeptWhole(): void
    {
        $long = trim(str_repeat('Long place ', 2000));
        $started = microtime(true);

        self::assertSame($long, NotificationPlanner::placeWithoutLinks($long));
        self::assertSame(str_repeat('a.', 5000).'x', NotificationPlanner::placeWithoutLinks(str_repeat('a.', 5000).'x'));
        self::assertSame('', NotificationPlanner::placeWithoutLinks(str_repeat('x.yy', 3000).'/'));
        self::assertLessThan(1.0, microtime(true) - $started, 'No runaway backtracking.');
    }
}
