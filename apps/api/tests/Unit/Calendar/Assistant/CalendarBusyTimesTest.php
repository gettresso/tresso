<?php

declare(strict_types=1);

namespace App\Tests\Unit\Calendar\Assistant;

use App\ApiResource\CalendarOccurrence;
use App\Calendar\Assistant\BusyTime;
use App\Calendar\Assistant\CalendarBusyTimes;
use App\Calendar\Assistant\MeetingTimeQuery;
use App\Calendar\Assistant\SchedulingRules;
use App\Calendar\Assistant\SlotSearch;
use App\Calendar\Assistant\WeeklyTime;
use PHPUnit\Framework\TestCase;

final class CalendarBusyTimesTest extends TestCase
{
    public function testATimedOccurrenceIsBusyForItsInstants(): void
    {
        $busy = self::busy(self::occurrence());

        self::assertSame('2026-10-19T07:00:00+00:00', $busy->start->setTimezone(new \DateTimeZone('UTC'))->format(\DATE_ATOM));
        self::assertSame('2026-10-19T07:30:00+00:00', $busy->end->setTimezone(new \DateTimeZone('UTC'))->format(\DATE_ATOM));
        self::assertSame('Weekly sync', $busy->label);
        self::assertSame(['event-1', 'event-1:20261019T070000Z'], $busy->references);
    }

    public function testAnAllDayOccurrenceTakesItsDaysInTheZone(): void
    {
        $busy = self::busy(self::occurrence(allDay: true, start: ['date' => '2026-10-24'], end: ['date' => '2026-10-26']), 'Europe/Amsterdam');

        // Saturday starts at +02:00, Monday at +01:00: the weekend lasts 49 hours.
        self::assertSame('2026-10-23T22:00:00+00:00', $busy->start->setTimezone(new \DateTimeZone('UTC'))->format(\DATE_ATOM));
        self::assertSame('2026-10-25T23:00:00+00:00', $busy->end->setTimezone(new \DateTimeZone('UTC'))->format(\DATE_ATOM));
    }

    public function testAnAllDayOccurrenceClosesTheWorkingDay(): void
    {
        $busy = self::busy(self::occurrence(allDay: true, start: ['date' => '2026-10-19'], end: ['date' => '2026-10-20']), 'Europe/Amsterdam');
        $rules = new SchedulingRules(new \DateTimeZone('Europe/Amsterdam'), [new WeeklyTime([1, 2, 3, 4, 5], '09:00', '17:00')]);
        $query = new MeetingTimeQuery(new \DateTimeImmutable('2026-10-19T00:00:00Z'), new \DateTimeImmutable('2026-10-21T00:00:00Z'), 30, limit: 1);

        $result = SlotSearch::find($rules, $query, new \DateTimeImmutable('2026-01-01T00:00:00Z'), [$busy]);

        self::assertSame('2026-10-20T07:00:00+00:00', $result->slots[0]->start->format(\DATE_ATOM));
    }

    public function testFreeCancelledAndDeclinedOccurrencesLeaveTheUserFree(): void
    {
        self::assertNull(CalendarBusyTimes::fromOccurrence(self::occurrence(transparency: 'free'), new \DateTimeZone('UTC')));
        self::assertNull(CalendarBusyTimes::fromOccurrence(self::occurrence(status: 'cancelled'), new \DateTimeZone('UTC')));
        self::assertNull(CalendarBusyTimes::fromOccurrence(self::occurrence(selfResponse: 'declined'), new \DateTimeZone('UTC')));
        self::assertNotNull(CalendarBusyTimes::fromOccurrence(self::occurrence(selfResponse: 'tentative'), new \DateTimeZone('UTC')));
        self::assertNotNull(CalendarBusyTimes::fromOccurrence(self::occurrence(selfResponse: 'needs-action'), new \DateTimeZone('UTC')));
    }

    public function testAnEventsOwnTravelTimeComesAlong(): void
    {
        self::assertSame(20, self::busy(self::occurrence(), travelMinutes: 20)->travelMinutes);
    }

    public function testAFocusBlockIsTheUsersOwnTimedFocusEvent(): void
    {
        self::assertTrue(self::busy(self::occurrence(summary: ' Focus: write the report'))->focus);
        self::assertFalse(self::busy(self::occurrence(summary: 'Focus group', attendeeCount: 3))->focus);
        self::assertFalse(self::busy(self::occurrence(summary: 'Focus', allDay: true, start: ['date' => '2026-10-19'], end: ['date' => '2026-10-20']))->focus);
        self::assertFalse(self::busy(self::occurrence())->focus);
    }

    public function testAPlaceIsALocationToTravelTo(): void
    {
        $teams = ['provider' => 'teams', 'url' => 'https://teams.microsoft.com/l/meetup-join/1', 'id' => null, 'dialIn' => null];

        self::assertTrue(CalendarBusyTimes::atPlace('Room 4, Keizersgracht 1', null));
        self::assertTrue(CalendarBusyTimes::atPlace('Café Loos', $teams));
        self::assertFalse(CalendarBusyTimes::atPlace('', null));
        self::assertFalse(CalendarBusyTimes::atPlace('  ', null));
        self::assertFalse(CalendarBusyTimes::atPlace('https://zoom.us/j/123', null));
        self::assertFalse(CalendarBusyTimes::atPlace('Microsoft Teams Meeting', $teams));
    }

    private static function busy(CalendarOccurrence $occurrence, string $zone = 'UTC', ?int $travelMinutes = null): BusyTime
    {
        $busy = CalendarBusyTimes::fromOccurrence($occurrence, new \DateTimeZone($zone), $travelMinutes);
        self::assertNotNull($busy);

        return $busy;
    }

    /**
     * @param array{date: string}|array{dateTime: string} $start
     * @param array{date: string}|array{dateTime: string} $end
     */
    private static function occurrence(
        string $transparency = 'busy',
        string $status = 'confirmed',
        ?string $selfResponse = null,
        bool $allDay = false,
        array $start = ['dateTime' => '2026-10-19T07:00:00+00:00'],
        array $end = ['dateTime' => '2026-10-19T07:30:00+00:00'],
        string $summary = 'Weekly sync',
        int $attendeeCount = 0,
    ): CalendarOccurrence {
        return new CalendarOccurrence(
            'event-1:20261019T070000Z',
            'event-1',
            'calendar-1',
            '20261019T070000Z',
            true,
            $allDay,
            $start,
            $end,
            $allDay ? null : 'Europe/Amsterdam',
            $status,
            $summary,
            '',
            $transparency,
            'public',
            null,
            $attendeeCount,
            $selfResponse,
            null,
            null,
        );
    }
}
