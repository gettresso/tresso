<?php

declare(strict_types=1);

namespace App\Tests\Unit\Calendar;

use App\Calendar\MeetingJoinLine;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The join line Tresso keeps at the end of an event's description for a link it knows.
 */
final class MeetingJoinLineTest extends TestCase
{
    private const string ROOM = 'https://meet.company.example/kim';
    /** Shared with the sync workers, which read the line by the same rule (apps/sync/internal/graphcal). */
    private const string FIXTURE = __DIR__.'/../../Fixtures/meeting-join-lines.json';

    /**
     * @return iterable<string, array{string, ?string}>
     */
    public static function sharedCases(): iterable
    {
        $cases = json_decode((string) file_get_contents(self::FIXTURE), true, flags: \JSON_THROW_ON_ERROR);
        self::assertIsArray($cases);
        foreach ($cases as $case) {
            self::assertIsArray($case);
            self::assertIsString($case['name']);
            self::assertIsString($case['description']);
            self::assertTrue(null === $case['link'] || \is_string($case['link']));
            yield $case['name'] => [$case['description'], $case['link']];
        }
    }

    #[DataProvider('sharedCases')]
    public function testTheLinkIsFoundByTheRuleTheWorkersShare(string $description, ?string $link): void
    {
        self::assertSame($link, MeetingJoinLine::find($description));
    }

    public function testALineAsExchangeGivesItBackIsReplacedByOneClean(): void
    {
        $returned = "Agenda\n\nJoin the meeting: ".self::ROOM.' <'.self::ROOM.'>';

        self::assertSame("Agenda\n\nJoin the meeting: ".self::ROOM, MeetingJoinLine::with($returned, self::ROOM, 'other'));
        self::assertSame('Agenda', MeetingJoinLine::strip($returned));
    }

    public function testTheLineGoesAfterAnEmptyLineAtTheEnd(): void
    {
        self::assertSame("Agenda\n- budget\n\nJoin the meeting: ".self::ROOM, MeetingJoinLine::with("Agenda\n- budget", self::ROOM, 'other'));
        self::assertSame("Agenda\n\nJoin the meeting: ".self::ROOM, MeetingJoinLine::with("Agenda\n\n\n", self::ROOM, 'other'), 'Empty lines at the end make way.');
    }

    public function testAnEmptyDescriptionGetsOnlyTheLine(): void
    {
        self::assertSame('Join the meeting: '.self::ROOM, MeetingJoinLine::with('', self::ROOM, 'other'));
        self::assertSame('Join the meeting: '.self::ROOM, MeetingJoinLine::with("  \n", self::ROOM, 'other'));
    }

    public function testTheLineNamesAKnownApp(): void
    {
        self::assertSame('Join with Zoom: https://zoom.us/j/123', MeetingJoinLine::with('', 'https://zoom.us/j/123', 'zoom'));
        self::assertSame('Join with Microsoft Teams: https://teams.microsoft.com/l/meetup-join/x', MeetingJoinLine::label('teams', 'https://teams.microsoft.com/l/meetup-join/x'));
        self::assertSame('Join with Google Meet:', MeetingJoinLine::prefix('meet'));
        self::assertSame('Join with Webex:', MeetingJoinLine::prefix('webex'));
        self::assertSame('Join the meeting:', MeetingJoinLine::prefix('other'));
    }

    public function testWithTwiceGivesOneLine(): void
    {
        $once = MeetingJoinLine::with('Agenda', self::ROOM, 'other');

        self::assertSame($once, MeetingJoinLine::with($once, self::ROOM, 'other'));
        self::assertSame(1, substr_count(MeetingJoinLine::with($once, self::ROOM, 'other'), 'Join the meeting:'));
    }

    public function testADescriptionThatIsOnlyTheLine(): void
    {
        self::assertSame('', MeetingJoinLine::strip('Join the meeting: '.self::ROOM));
        self::assertSame(self::ROOM, MeetingJoinLine::find('Join the meeting: '.self::ROOM));
        self::assertSame('', MeetingJoinLine::with('Join the meeting: '.self::ROOM, null, 'other'));
    }

    public function testALineTheUserEditedIsReplaced(): void
    {
        $edited = "Agenda\n\nJoin the meeting: https://meet.company.example/someone-else";

        self::assertSame("Agenda\n\nJoin the meeting: ".self::ROOM, MeetingJoinLine::with($edited, self::ROOM, 'other'));
    }

    public function testALineInTheMiddleOfTheTextIsRemovedToo(): void
    {
        $description = "Before\nJoin with Zoom: https://zoom.us/j/1\nAfter\n\nJoin the meeting: https://old.example/room\n\n";

        self::assertSame("Before\nAfter", MeetingJoinLine::strip($description));
        self::assertSame("Before\nAfter\n\nJoin the meeting: ".self::ROOM, MeetingJoinLine::with($description, self::ROOM, 'other'));
    }

    public function testFindGivesTheLinkOfTheLastLine(): void
    {
        self::assertSame('https://zoom.us/j/2', MeetingJoinLine::find("Join the meeting: https://a.example/1\nText\nJoin with Zoom: https://zoom.us/j/2"));
        self::assertSame(self::ROOM, MeetingJoinLine::find("Agenda\r\n\r\nJoin the meeting: ".self::ROOM."\r\n"), 'Windows line ends too.');
        self::assertNull(MeetingJoinLine::find('Agenda: https://meet.google.com/abc-defg-hij'));
        self::assertNull(MeetingJoinLine::find('Join the meeting: http://meet.company.example/kim'), 'Only https links.');
        self::assertNull(MeetingJoinLine::find('Please join the meeting: '.self::ROOM), 'Only a line of its own.');
    }

    public function testSpacesAfterTheLinkAreNoPartOfIt(): void
    {
        self::assertSame(self::ROOM, MeetingJoinLine::find("Join the meeting: ".self::ROOM."  \t"));
        self::assertSame(self::ROOM, MeetingJoinLine::find("Join the meeting: ".self::ROOM."\u{A0}"), 'A no-break space is not taken into the link.');
        self::assertNull(MeetingJoinLine::find("Join the meeting: ".self::ROOM."\u{A0}more"), 'Text after it makes it no join line.');
        self::assertSame('Agenda', MeetingJoinLine::strip("Agenda\n\nJoin the meeting: ".self::ROOM." \t\n"));
    }

    public function testADescriptionWithoutALineStaysAsItIs(): void
    {
        self::assertSame("Agenda  \n\n", MeetingJoinLine::strip("Agenda  \n\n"));
        self::assertSame("Agenda  \n\n", MeetingJoinLine::with("Agenda  \n\n", null, 'other'));
    }
}
