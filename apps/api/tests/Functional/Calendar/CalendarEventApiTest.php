<?php

declare(strict_types=1);

namespace App\Tests\Functional\Calendar;

use App\Calendar\OccurrenceExpander;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\DatabaseTestCase;
use PHPUnit\Framework\Attributes\DataProvider;

final class CalendarEventApiTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use CalendarTestHelpers;

    private const array SCOPES = ['mail:read', 'mail:send', 'calendar:read', 'calendar:write', 'settings:write'];

    /** @var array<string, string> */
    private array $kim;

    private string $calendarId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', self::SCOPES);
        $this->calendarId = $this->localCalendarId($this->kim);
    }

    public function testNewUsersHaveAWritableTressoCalendar(): void
    {
        $calendars = $this->getJson('/api/v1/calendars', $this->kim);

        self::assertCount(1, $calendars);
        self::assertIsArray($calendars[0]);
        self::assertSame('Tresso', $calendars[0]['name']);
        self::assertSame('local', $calendars[0]['source']);
        self::assertTrue($calendars[0]['writable']);
        self::assertTrue($calendars[0]['isDefault']);
    }

    public function testCreatesAnEventAndListsItsOccurrence(): void
    {
        $event = $this->create(['location' => 'Room 4', 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 10, 'channels' => ['phone', 'email']]], 'travelMinutes' => 20, 'description' => 'Agenda: https://meet.google.com/abc-defg-hij']);

        self::assertSame(['dateTime' => '2026-10-19T09:00:00', 'timeZone' => 'Europe/Amsterdam'], $event['start'] ?? null);
        self::assertSame('Room 4', $event['location'] ?? null);
        self::assertSame([['action' => 'display', 'trigger' => '-PT10M', 'relatedTo' => 'start', 'at' => null, 'channels' => ['phone', 'email']]], $event['reminders'] ?? null);
        self::assertFalse($event['defaultReminders'] ?? null);
        self::assertSame(20, $event['travelMinutes'] ?? null);
        self::assertSame(['provider' => 'meet', 'url' => 'https://meet.google.com/abc-defg-hij', 'id' => null, 'dialIn' => null], $event['conference'] ?? null);

        $occurrences = $this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00');
        self::assertCount(1, $occurrences);
        self::assertSame($event['id'], $occurrences[0]['eventId']);
        self::assertNull($occurrences[0]['recurrenceId']);
        self::assertSame(['dateTime' => '2026-10-19T07:00:00+00:00'], $occurrences[0]['start']);
        self::assertSame(['dateTime' => '2026-10-19T07:30:00+00:00'], $occurrences[0]['end']);
        self::assertSame('Europe/Amsterdam', $occurrences[0]['timeZone']);
    }

    public function testAllDayEventsUseDates(): void
    {
        $this->create(['summary' => 'Offsite', 'start' => ['date' => '2026-10-20'], 'end' => ['date' => '2026-10-22']]);

        $occurrences = $this->occurrences($this->kim, '2026-10-20T00:00:00+02:00', '2026-10-23T00:00:00+02:00', 'Europe/Amsterdam');
        self::assertCount(1, $occurrences);
        self::assertTrue($occurrences[0]['allDay']);
        self::assertSame(['date' => '2026-10-20'], $occurrences[0]['start']);
        self::assertSame(['date' => '2026-10-22'], $occurrences[0]['end']);
    }

    public function testWeeklySeriesKeepsItsLocalTimeAcrossDaylightSaving(): void
    {
        $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);

        $starts = array_map(static fn (array $o): mixed => $o['start'], $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00'));

        self::assertSame([
            ['dateTime' => '2026-10-19T07:00:00+00:00'],
            ['dateTime' => '2026-10-26T08:00:00+00:00'],
            ['dateTime' => '2026-11-02T08:00:00+00:00'],
            ['dateTime' => '2026-11-09T08:00:00+00:00'],
        ], $starts);
    }

    public function testEditingOneOccurrenceOverridesOnlyThatOne(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'summary' => 'Weekly sync (moved)',
            'start' => ['dateTime' => '2026-10-26T11:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T11:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        $override = $this->decodedResponse();
        self::assertSame('20261026T080000Z', $override['recurrenceId']);
        self::assertNotSame($series['id'], $override['id']);

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertCount(4, $occurrences);
        self::assertSame('Weekly sync (moved)', $occurrences[1]['summary']);
        self::assertSame(['dateTime' => '2026-10-26T10:00:00+00:00'], $occurrences[1]['start']);
        self::assertSame($override['id'], $occurrences[1]['eventId']);
        self::assertSame('20261026T080000Z', $occurrences[1]['recurrenceId']);
        self::assertSame('Weekly sync', $occurrences[2]['summary']);
        self::assertSame($series['id'], $occurrences[2]['eventId']);
    }

    public function testEditingThisAndFollowingSplitsTheSeries(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=following&recurrenceId=20261102T080000Z', self::event($this->calendarId, [
            'summary' => 'Weekly sync, later',
            'recurrence' => 'FREQ=WEEKLY;COUNT=4',
            'start' => ['dateTime' => '2026-11-02T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-11-02T10:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        $next = $this->decodedResponse();
        self::assertNotSame($series['uid'], $next['uid']);
        self::assertSame('FREQ=WEEKLY;COUNT=2', $next['recurrence'], 'The new series takes over the occurrences that were left.');

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertSame(
            [['Weekly sync', '2026-10-19T07:00:00+00:00'], ['Weekly sync', '2026-10-26T08:00:00+00:00'], ['Weekly sync, later', '2026-11-02T09:00:00+00:00'], ['Weekly sync, later', '2026-11-09T09:00:00+00:00']],
            array_map(static fn (array $o): array => [$o['summary'], \is_array($o['start']) ? $o['start']['dateTime'] : null], $occurrences),
        );

        $original = $this->getJson('/api/v1/calendar-events/'.$series['id'], $this->kim);
        self::assertSame('FREQ=WEEKLY;UNTIL=20261102T075959Z', $original['recurrence']);
    }

    public function testThisAndFollowingFromAMovedOccurrenceKeepsTheSeriesTimeAndCarriesTheOverride(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'start' => ['dateTime' => '2026-10-27T14:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-27T14:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        // From the moved occurrence, shown on Tuesday at 14:00, only the title changes for this and the later ones.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=following&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'summary' => 'Weekly sync, renamed',
            'recurrence' => 'FREQ=WEEKLY;COUNT=4',
            'start' => ['dateTime' => '2026-10-27T14:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-27T14:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertSame(
            ['2026-10-19T07:00:00+00:00', '2026-10-27T13:00:00+00:00', '2026-11-02T08:00:00+00:00', '2026-11-09T08:00:00+00:00'],
            array_map(static fn (array $o): ?string => \is_array($o['start']) && \is_string($o['start']['dateTime'] ?? null) ? $o['start']['dateTime'] : null, $occurrences),
            'The rest of the series stays on Monday at 09:00, and the moved Tuesday shows once.',
        );
        self::assertSame(['Weekly sync, renamed', 'Weekly sync, renamed', 'Weekly sync, renamed'], \array_slice(array_column($occurrences, 'summary'), 1), 'The moved Tuesday takes the new title too.');
        self::assertSame([true, true, true], array_column(\array_slice($occurrences, 1), 'recurring'));
    }

    public function testThisAndFollowingFromAChangedOccurrenceGivesThatOccurrenceTheEdit(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'summary' => 'Planning, room 2',
            'location' => 'Room 2',
            'start' => ['dateTime' => '2026-10-26T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=following&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'summary' => 'Planning, final',
            'location' => 'Room 7',
            'recurrence' => 'FREQ=WEEKLY;COUNT=4',
            'start' => ['dateTime' => '2026-10-26T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertSame(
            [
                ['Weekly sync', '', '2026-10-19T07:00:00+00:00', '2026-10-19T07:30:00+00:00'],
                ['Planning, final', 'Room 7', '2026-10-26T08:00:00+00:00', '2026-10-26T09:00:00+00:00'],
                ['Planning, final', 'Room 7', '2026-11-02T08:00:00+00:00', '2026-11-02T09:00:00+00:00'],
                ['Planning, final', 'Room 7', '2026-11-09T08:00:00+00:00', '2026-11-09T09:00:00+00:00'],
            ],
            array_map(static fn (array $o): array => [$o['summary'], $o['location'], \is_array($o['start']) ? $o['start']['dateTime'] : null, \is_array($o['end']) ? $o['end']['dateTime'] : null], $occurrences),
        );
    }

    public function testThisAndFollowingKeepsWhatTheUserDidNotChangeOnAChangedOccurrence(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'summary' => 'Planning, room 2',
            'location' => 'Room 2',
            'start' => ['dateTime' => '2026-10-26T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        // As the web client sends it: the series' values, the occurrence's start with the series' length, and the
        // one field the user changed.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=following&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'description' => 'Agenda in the doc',
            'recurrence' => 'FREQ=WEEKLY;COUNT=4',
            'start' => ['dateTime' => '2026-10-26T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertSame(
            [
                ['Weekly sync', '', '2026-10-19T07:00:00+00:00', '2026-10-19T07:30:00+00:00'],
                ['Planning, room 2', 'Room 2', '2026-10-26T08:00:00+00:00', '2026-10-26T09:00:00+00:00'],
                ['Weekly sync', '', '2026-11-02T08:00:00+00:00', '2026-11-02T08:30:00+00:00'],
                ['Weekly sync', '', '2026-11-09T08:00:00+00:00', '2026-11-09T08:30:00+00:00'],
            ],
            array_map(static fn (array $o): array => [$o['summary'], $o['location'], \is_array($o['start']) ? $o['start']['dateTime'] : null, \is_array($o['end']) ? $o['end']['dateTime'] : null], $occurrences),
            'The changed occurrence keeps its own title, place and length.',
        );
        foreach (\array_slice($occurrences, 1) as $occurrence) {
            self::assertSame('Agenda in the doc', $this->getJson('/api/v1/calendar-events/'.self::string($occurrence['eventId']), $this->kim)['description']);
        }
    }

    public function testMovingAllEventsToAnotherWeekdayMovesTheRuleAndKeepsTheExceptions(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;BYDAY=MO;COUNT=4']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261102T080000Z', self::event($this->calendarId, [
            'summary' => 'Weekly sync, one off',
            'start' => ['dateTime' => '2026-11-02T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-11-02T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        // Monday 26 October, with the rule untouched, is moved to Tuesday for all events.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=all&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'recurrence' => 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
            'start' => ['dateTime' => '2026-10-27T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-27T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame('FREQ=WEEKLY;BYDAY=TU;COUNT=4', $this->decodedResponse()['recurrence']);

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertSame(
            [['Weekly sync', '2026-10-20T07:00:00+00:00'], ['Weekly sync', '2026-10-27T08:00:00+00:00'], ['Weekly sync, one off', '2026-11-03T08:00:00+00:00'], ['Weekly sync', '2026-11-10T08:00:00+00:00']],
            array_map(static fn (array $o): array => [$o['summary'], \is_array($o['start']) ? $o['start']['dateTime'] : null], $occurrences),
        );
    }

    public function testMovingAllEventsOfEveryWeekdayKeepsTheWeekdays(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10']);
        // Monday 19 October dragged to Tuesday for all events: the series starts a day later, still on weekdays.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=all&recurrenceId=20261019T070000Z', self::event($this->calendarId, [
            'recurrence' => 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10',
            'start' => ['dateTime' => '2026-10-20T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-20T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10', $this->decodedResponse()['recurrence']);

        $days = array_map(static fn (array $o): string => \is_array($o['start']) && \is_string($o['start']['dateTime'] ?? null) ? new \DateTimeImmutable($o['start']['dateTime'])->setTimezone(new \DateTimeZone('Europe/Amsterdam'))->format('D') : '', $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00'));
        self::assertNotContains('Sat', $days);
        self::assertNotContains('Sun', $days);
        self::assertCount(10, $days);
    }

    public function testMovingAllEventsOfADailySeriesKeepsItsWeekdays(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=DAILY;BYDAY=MO,WE,FR;COUNT=6']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=all&recurrenceId=20261019T070000Z', self::event($this->calendarId, [
            'recurrence' => 'FREQ=DAILY;BYDAY=MO,WE,FR;COUNT=6',
            'start' => ['dateTime' => '2026-10-21T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-21T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame('FREQ=DAILY;BYDAY=MO,WE,FR;COUNT=6', $this->decodedResponse()['recurrence']);
    }

    public function testMovingThisAndFollowingToAnotherDayMovesAMonthlyRule(): void
    {
        $series = $this->create([
            'recurrence' => 'FREQ=MONTHLY;BYDAY=3MO;COUNT=4',
            'start' => ['dateTime' => '2026-09-21T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-09-21T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]);
        // The third Monday of October moves to the third Tuesday, and every later one with it.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=following&recurrenceId=20261019T070000Z', self::event($this->calendarId, [
            'recurrence' => 'FREQ=MONTHLY;BYDAY=3MO;COUNT=4',
            'start' => ['dateTime' => '2026-10-20T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-20T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame('FREQ=MONTHLY;BYDAY=3TU;COUNT=3', $this->decodedResponse()['recurrence']);

        $starts = array_map(static fn (array $o): ?string => \is_array($o['start']) && \is_string($o['start']['dateTime'] ?? null) ? $o['start']['dateTime'] : null, $this->occurrences($this->kim, '2026-09-01T00:00:00+00:00', '2027-01-01T00:00:00+00:00'));
        self::assertSame(['2026-09-21T07:00:00+00:00', '2026-10-20T07:00:00+00:00', '2026-11-17T08:00:00+00:00', '2026-12-15T08:00:00+00:00'], $starts);
    }

    public function testDeletesTheOccurrenceAtARepeatedTimeOnTheNightClocksGoBack(): void
    {
        $series = $this->nightSeries();
        $key = $this->recurrenceIdOn($series, '2026-10-25');
        self::assertSame('20261025T013000Z', $key, 'The occurrence is shown at 02:30 CET, the time read back.');

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId='.$key, server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        self::assertSame(['20261023T003000Z', '20261024T003000Z', '20261026T013000Z'], array_column($this->occurrences($this->kim, '2026-10-20T00:00:00+00:00', '2026-10-30T00:00:00+00:00', 'Europe/Amsterdam'), 'recurrenceId'));
    }

    public function testEditsTheOccurrenceAtARepeatedTimeOnTheNightClocksGoBack(): void
    {
        $series = $this->nightSeries();
        $key = $this->recurrenceIdOn($series, '2026-10-25');

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId='.$key, self::event($this->calendarId, [
            'summary' => 'Night watch, later',
            'start' => ['dateTime' => '2026-10-25T05:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-25T05:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $occurrences = $this->occurrences($this->kim, '2026-10-20T00:00:00+00:00', '2026-10-30T00:00:00+00:00', 'Europe/Amsterdam');
        self::assertSame(
            [['Night watch', '20261023T003000Z'], ['Night watch', '20261024T003000Z'], ['Night watch, later', '20261025T013000Z'], ['Night watch', '20261026T013000Z']],
            array_map(static fn (array $o): array => [$o['summary'], $o['recurrenceId']], $occurrences),
        );
        self::assertSame(['dateTime' => '2026-10-25T04:00:00+00:00'], $occurrences[2]['start']);
    }

    public function testEditingAllOccurrencesMovesTheSeriesAndItsExceptions(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=3']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'location' => 'Room 12',
            'start' => ['dateTime' => '2026-10-26T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        // The user drags the third occurrence an hour later and applies it to all.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=all&recurrenceId=20261102T080000Z', self::event($this->calendarId, [
            'recurrence' => 'FREQ=WEEKLY;COUNT=3',
            'start' => ['dateTime' => '2026-11-02T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-11-02T10:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertCount(3, $occurrences);
        self::assertSame(['dateTime' => '2026-10-19T08:00:00+00:00'], $occurrences[0]['start']);
        self::assertSame('Room 12', $occurrences[1]['location'], 'The exception stays attached to its occurrence.');
        self::assertSame('20261026T090000Z', $occurrences[1]['recurrenceId']);
        self::assertSame(['dateTime' => '2026-11-02T09:00:00+00:00'], $occurrences[2]['start']);
    }

    public function testDeletesOneOccurrence(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=3']);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertSame(['20261019T070000Z', '20261102T080000Z'], array_map(static fn (array $o): mixed => $o['recurrenceId'], $occurrences));
        self::assertSame(['20261026T080000Z'], $this->getJson('/api/v1/calendar-events/'.$series['id'], $this->kim)['exdates']);
    }

    public function testDeletesThisAndFollowing(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY']);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$series['id'].'?scope=following&recurrenceId=20261102T080000Z', server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        self::assertCount(2, $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2027-06-01T00:00:00+00:00'));
    }

    public function testDeletesAWholeEvent(): void
    {
        $event = $this->create();

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$event['id'], server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        self::assertSame([], $this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00'));
        $this->client->request('GET', '/api/v1/calendar-events/'.$event['id'], server: $this->kim);
        self::assertResponseStatusCodeSame(404);
    }

    public function testRejectsInvalidEvents(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId, ['end' => ['dateTime' => '2026-10-19T08:00:00', 'timeZone' => 'Europe/Amsterdam']]), $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertSame('end', $this->violationPath());

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId, ['start' => ['dateTime' => '2026-10-19T09:00:00', 'timeZone' => 'Mars/Olympus']]), $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertSame('start', $this->violationPath());

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId, ['recurrence' => 'FREQ=WEEKLY;BYDAY=XX']), $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertSame('recurrence', $this->violationPath());

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId, ['start' => ['date' => '2026-10-19'], 'end' => ['dateTime' => '2026-10-20T00:00:00', 'timeZone' => null]]), $this->kim);
        self::assertResponseStatusCodeSame(422);
    }

    public function testOtherUsersCalendarsAndEventsDoNotExist(): void
    {
        $event = $this->create();
        $this->createUser('lisa@example.test', 'Lisa');
        $lisa = $this->userHeaders('lisa@example.test', self::SCOPES);

        $this->client->request('GET', '/api/v1/calendar-events/'.$event['id'], server: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId), $lisa);
        self::assertResponseStatusCodeSame(422);
        self::assertSame([], $this->occurrences($lisa, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00'));
    }

    public function testOtherUsersCannotChangeAnswerOrReceiveAnEvent(): void
    {
        $event = $this->create();
        $this->createUser('lisa@example.test', 'Lisa');
        $lisa = $this->userHeaders('lisa@example.test', self::SCOPES);
        $lisasCalendar = $this->localCalendarId($lisa);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$event['id'], self::event($lisasCalendar, ['summary' => 'Taken']), $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/calendar-events/'.$event['id'], server: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$event['id'].'/response', ['response' => 'accepted'], $lisa);
        self::assertResponseStatusCodeSame(404);

        // Kim cannot move her event into Lisa's calendar either.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$event['id'], self::event($lisasCalendar), $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertSame('calendarId', $this->violationPath());

        self::assertSame('Weekly sync', $this->getJson('/api/v1/calendar-events/'.$event['id'], $this->kim)['summary']);
        self::assertSame([], $this->occurrences($lisa, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00'));
    }

    public function testRequiresCalendarScopes(): void
    {
        $mailOnly = $this->userHeaders('kim@example.test', ['mail:read']);

        $this->client->request('GET', '/api/v1/calendars', server: $mailOnly);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId), $this->userHeaders('kim@example.test', ['calendar:read']));
        self::assertResponseStatusCodeSame(403);
    }

    public function testLimitsTheOccurrenceRange(): void
    {
        $this->client->request('GET', '/api/v1/calendar-occurrences?'.http_build_query(['from' => '2026-01-01T00:00:00+00:00', 'to' => '2027-06-01T00:00:00+00:00']), server: $this->kim);

        self::assertResponseStatusCodeSame(400);
    }

    public function testAnHourlySeriesFillsTheLongestRange(): void
    {
        $this->create(['recurrence' => 'FREQ=HOURLY']);

        $occurrences = $this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2027-11-01T00:00:00+00:00');

        // Every hour until the end of the range: no series is cut short without a word.
        self::assertGreaterThan(9000, \count($occurrences));
        self::assertSame(['dateTime' => '2027-10-31T23:00:00+00:00'], $occurrences[\count($occurrences) - 1]['start']);
    }

    public function testARangeHoldingTooManyOccurrencesIsRefused(): void
    {
        $this->create(['recurrence' => 'FREQ=HOURLY']);
        $this->create(['recurrence' => 'FREQ=HOURLY', 'summary' => 'Another']);

        $this->client->request('GET', '/api/v1/calendar-occurrences?'.http_build_query(['from' => '2026-10-19T00:00:00+00:00', 'to' => '2027-11-01T00:00:00+00:00']), server: $this->kim);

        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString((string) OccurrenceExpander::MAX_OCCURRENCES, self::string($this->decodedResponse()['detail'] ?? null));
    }

    public function testARangeInAnotherOffsetFindsFloatingEvents(): void
    {
        $this->create([
            'start' => ['dateTime' => '2026-10-19T09:00:00', 'timeZone' => null],
            'end' => ['dateTime' => '2026-10-19T10:00:00', 'timeZone' => null],
        ]);

        // The whole of 19 October in Honolulu, written in +14:00.
        $occurrences = $this->occurrences($this->kim, '2026-10-20T00:00:00+14:00', '2026-10-21T00:00:00+14:00', 'Pacific/Honolulu');

        self::assertCount(1, $occurrences);
        self::assertSame(['dateTime' => '2026-10-19T19:00:00+00:00'], $occurrences[0]['start']);
    }

    public function testAnUnknownTimeZoneIsRefused(): void
    {
        $this->client->request('GET', '/api/v1/calendar-occurrences?'.http_build_query(['from' => '2026-10-19T00:00:00+00:00', 'to' => '2026-10-20T00:00:00+00:00', 'timeZone' => 'Mars/Olympus']), server: $this->kim);

        self::assertResponseStatusCodeSame(422);
        self::assertSame('timeZone', $this->violationPath());
    }

    public function testAnOccurrenceFarIntoADenseSeriesCanBeChanged(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=HOURLY']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?'.http_build_query(['scope' => 'this', 'recurrenceId' => '20400101T000000Z']), self::event($this->calendarId, [
            'summary' => 'New year',
            'start' => ['dateTime' => '2040-01-01T01:30:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2040-01-01T02:00:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $occurrences = $this->occurrences($this->kim, '2039-12-31T23:00:00+00:00', '2040-01-01T02:00:00+00:00');
        self::assertSame(['Weekly sync', 'New year', 'Weekly sync'], array_column($occurrences, 'summary'));
        self::assertSame(['dateTime' => '2040-01-01T00:30:00+00:00'], $occurrences[1]['start']);
    }

    public function testASplitCountsTheOccurrencesAnExceptionRemoved(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->client->request('DELETE', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=following&recurrenceId=20261102T080000Z', self::event($this->calendarId, [
            'summary' => 'Weekly sync, later',
            'recurrence' => 'FREQ=WEEKLY;COUNT=4',
            'start' => ['dateTime' => '2026-11-02T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-11-02T10:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        // COUNT includes the removed occurrence (RFC 5545 3.3.10), so two of the four are left for the new series.
        self::assertSame('FREQ=WEEKLY;COUNT=2', $this->decodedResponse()['recurrence']);
        self::assertCount(3, $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2027-01-01T00:00:00+00:00'));
    }

    public function testEndingAFloatingSeriesKeepsItsEndFloating(): void
    {
        $series = $this->create([
            'recurrence' => 'FREQ=WEEKLY',
            'start' => ['dateTime' => '2026-10-19T09:00:00', 'timeZone' => null],
            'end' => ['dateTime' => '2026-10-19T09:30:00', 'timeZone' => null],
        ]);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$series['id'].'?scope=following&recurrenceId=20261102T090000Z', server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        self::assertSame('FREQ=WEEKLY;UNTIL=20261102T085959', $this->getJson('/api/v1/calendar-events/'.$series['id'], $this->kim)['recurrence']);
        self::assertCount(2, $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2027-01-01T00:00:00+00:00', 'Pacific/Auckland'));
    }

    public function testEditingAllFromAMovedOccurrenceShiftsByWhatTheUserChanged(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=3']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'start' => ['dateTime' => '2026-10-26T11:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T11:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        // The moved occurrence, shown at 11:00, is dragged half an hour later and applied to all.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=all&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'recurrence' => 'FREQ=WEEKLY;COUNT=3',
            'start' => ['dateTime' => '2026-10-26T11:30:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T12:00:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertSame(['dateTime' => '2026-10-19T07:30:00+00:00'], $occurrences[0]['start']);
    }

    public function testAnEventMovedBeforeTheDeltaWindowLeavesTheCopies(): void
    {
        $event = $this->create();
        $cursor = $this->getJson('/api/v1/sync/changes?since=0', $this->kim)['cursor'];
        self::assertIsInt($cursor);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$event['id'], self::event($this->calendarId, [
            'start' => ['dateTime' => '2020-01-06T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2020-01-06T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $delta = $this->getJson('/api/v1/sync/changes?since='.$cursor, $this->kim);
        self::assertSame([], $delta['calendarEvents']);
        self::assertSame([['type' => 'calendarEvent', 'id' => $event['id']]], $delta['deleted']);
        self::assertSame([], $this->getJson('/api/v1/sync/changes?since=0', $this->kim)['calendarEvents'], 'A new copy never gets it.');
    }

    public function testImportantEventsAndWorkCalendarsReachTheClients(): void
    {
        $event = $this->create(['important' => true]);
        self::assertTrue($event['important'] ?? null);

        $this->client->request('PATCH', '/api/v1/calendars/'.$this->calendarId, server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['work' => true], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();

        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['calendarEvents']);
        self::assertSame([true], array_column($delta['calendarEvents'], 'important'));
        self::assertIsArray($delta['calendars']);
        self::assertSame([true], array_column($delta['calendars'], 'work'));

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$event['id'], self::event($this->calendarId), $this->kim);
        self::assertFalse($this->decodedResponse()['important']);
    }

    public function testTheDeltaCarriesCalendarsAndEvents(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=DAILY;COUNT=5']);

        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['calendars']);
        self::assertSame([$this->calendarId], array_column($delta['calendars'], 'id'));
        self::assertIsArray($delta['calendarEvents']);
        self::assertSame([$series['id']], array_column($delta['calendarEvents'], 'id'));
        self::assertSame(['FREQ=DAILY;COUNT=5'], array_column($delta['calendarEvents'], 'recurrence'));
        $cursor = $delta['cursor'];
        self::assertIsInt($cursor);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$series['id'], server: $this->kim);
        $delta = $this->getJson('/api/v1/sync/changes?since='.$cursor, $this->kim);
        self::assertSame([['type' => 'calendarEvent', 'id' => $series['id']]], $delta['deleted']);
    }

    public function testTheDeltaMarksOverridesThatChangeTheFuture(): void
    {
        $calendar = static::getContainer()->get(\App\Repository\CalendarRepository::class)->find($this->calendarId);
        self::assertNotNull($calendar);
        $ical = implode("\r\n", ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
            'BEGIN:VEVENT', 'UID:range@test', 'DTSTAMP:20261019T080000Z', 'DTSTART:20261019T080000Z', 'DURATION:PT30M', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Sync', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:range@test', 'DTSTAMP:20261019T080000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261021T080000Z', 'DTSTART:20261021T090000Z', 'DURATION:PT30M', 'SUMMARY:Sync, later', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:range@test', 'DTSTAMP:20261019T080000Z', 'RECURRENCE-ID:20261020T080000Z', 'DTSTART:20261020T100000Z', 'DURATION:PT30M', 'SUMMARY:Sync, moved', 'END:VEVENT',
            'END:VCALENDAR', '']);
        $entityManager = static::getContainer()->get(\Doctrine\ORM\EntityManagerInterface::class);
        $entityManager->wrapInTransaction(static fn () => static::getContainer()->get(\App\Calendar\CalendarStore::class)->save(new \App\Entity\CalendarObject($calendar, 'range@test', ''), \App\Calendar\ICalendar\CalendarDocument::parse($ical)));

        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['calendarEvents']);
        $marked = array_column($delta['calendarEvents'], 'thisAndFuture', 'summary');
        ksort($marked);
        self::assertSame(['Sync' => false, 'Sync, later' => true, 'Sync, moved' => false], $marked);
    }

    public function testReprojectingGivesRowsFromBeforeTheColumnTheirRange(): void
    {
        $calendar = static::getContainer()->get(\App\Repository\CalendarRepository::class)->find($this->calendarId);
        self::assertNotNull($calendar);
        $ical = implode("\r\n", ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
            'BEGIN:VEVENT', 'UID:old-range@test', 'DTSTAMP:20261019T080000Z', 'DTSTART:20261019T080000Z', 'DURATION:PT30M', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Sync', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:old-range@test', 'DTSTAMP:20261019T080000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261021T080000Z', 'DTSTART:20261021T090000Z', 'DURATION:PT30M', 'SUMMARY:Sync, later', 'END:VEVENT',
            'END:VCALENDAR', '']);
        $entityManager = static::getContainer()->get(\Doctrine\ORM\EntityManagerInterface::class);
        $entityManager->wrapInTransaction(static fn () => static::getContainer()->get(\App\Calendar\CalendarStore::class)->save(new \App\Entity\CalendarObject($calendar, 'old-range@test', ''), \App\Calendar\ICalendar\CalendarDocument::parse($ical)));
        // As a row projected before the column existed has it.
        static::getContainer()->get(\Doctrine\DBAL\Connection::class)->executeStatement('UPDATE calendar_event SET this_and_future = false');
        $entityManager->clear();

        $tester = new \Symfony\Component\Console\Tester\CommandTester(new \Symfony\Bundle\FrameworkBundle\Console\Application($this->client->getKernel())->find('app:calendar:reproject'));
        $tester->execute([]);
        $tester->assertCommandIsSuccessful();

        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['calendarEvents']);
        $marked = array_column($delta['calendarEvents'], 'thisAndFuture', 'summary');
        ksort($marked);
        self::assertSame(['Sync' => false, 'Sync, later' => true], $marked);
    }

    public function testOccurrencesOfEventsWithADurationLastThatLong(): void
    {
        $this->storeIcal('duration@test', [
            'BEGIN:VEVENT', 'UID:duration@test', 'DTSTAMP:20261019T080000Z', 'DTSTART:20261021T140000Z', 'DURATION:PT90M', 'RRULE:FREQ=DAILY;COUNT=2', 'SUMMARY:Review', 'END:VEVENT',
        ]);
        $this->storeIcal('days@test', [
            'BEGIN:VEVENT', 'UID:days@test', 'DTSTAMP:20261019T080000Z', 'DTSTART;VALUE=DATE:20261026', 'DURATION:P3D', 'SUMMARY:Offsite', 'END:VEVENT',
        ]);

        $ends = [];
        foreach ($this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-31T00:00:00+00:00') as $occurrence) {
            $ends[] = [$occurrence['summary'], $occurrence['start'], $occurrence['end']];
        }
        self::assertSame([
            ['Review', ['dateTime' => '2026-10-21T14:00:00+00:00'], ['dateTime' => '2026-10-21T15:30:00+00:00']],
            ['Review', ['dateTime' => '2026-10-22T14:00:00+00:00'], ['dateTime' => '2026-10-22T15:30:00+00:00']],
            ['Offsite', ['date' => '2026-10-26'], ['date' => '2026-10-29']],
        ], $ends);
    }

    public function testANoteFollowsItsOccurrenceWhenItIsChanged(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->putNote($series['id'], '20261026T080000Z', 'Ask about the budget');

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, [
            'summary' => 'Weekly sync, longer',
            'start' => ['dateTime' => '2026-10-26T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        self::assertSame(['2026-10-26' => 'Ask about the budget'], $this->notesByDay());
    }

    public function testANoteFollowsItsOccurrenceWhenTheSeriesMoves(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->putNote($series['id'], '20261026T080000Z', 'Ask about the budget');
        $this->putNote($series['id'], null, 'About the whole series');

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=all', self::event($this->calendarId, [
            'recurrence' => 'FREQ=WEEKLY;COUNT=4',
            'start' => ['dateTime' => '2026-10-19T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-19T10:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        self::assertSame(['2026-10-26' => 'Ask about the budget'], $this->notesByDay());
        self::assertContains([$series['id'], null, 'About the whole series'], $this->notes());
    }

    public function testNotesGoAlongToAnotherCalendarAndToANewSeries(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->putNote($series['id'], '20261026T080000Z', 'Second');
        $this->putNote($series['id'], '20261102T080000Z', 'Third');
        $this->client->jsonRequest('POST', '/api/v1/calendars', ['name' => 'Family', 'color' => '#E0457B'], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $family = $this->responseString('id');

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'], self::event($family, ['recurrence' => 'FREQ=WEEKLY;COUNT=4']), $this->kim);
        self::assertResponseIsSuccessful();
        $moved = self::string($this->decodedResponse()['id']);
        self::assertSame(['2026-10-26' => 'Second', '2026-11-02' => 'Third'], $this->notesByDay());

        // This and following from the third, an hour later: its note goes to the new series, the second's stays.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$moved.'?scope=following&recurrenceId=20261102T080000Z', self::event($family, [
            'recurrence' => 'FREQ=WEEKLY;COUNT=4',
            'start' => ['dateTime' => '2026-11-02T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-11-02T10:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame(['2026-10-26' => 'Second', '2026-11-02' => 'Third'], $this->notesByDay());
    }

    public function testANoteOnAnOccurrenceAThisAndFutureOverrideChangedStaysWhereItShows(): void
    {
        $this->storeIcal('range@test', [
            'BEGIN:VEVENT', 'UID:range@test', 'DTSTAMP:20261019T080000Z', 'DTSTART:20261019T080000Z', 'DURATION:PT30M', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Sync', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:range@test', 'DTSTAMP:20261019T080000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261021T080000Z', 'DTSTART:20261021T090000Z', 'DURATION:PT30M', 'SUMMARY:Sync, later', 'END:VEVENT',
        ]);
        $later = null;
        foreach ($this->occurrences($this->kim, '2026-10-22T00:00:00+00:00', '2026-10-23T00:00:00+00:00') as $occurrence) {
            $later = $occurrence;
        }
        self::assertIsArray($later);
        self::assertSame('Sync, later', $later['summary']);
        $this->putNote(self::string($later['eventId']), self::string($later['recurrenceId']), 'Changed by the range');

        // Any change of the resource projects it again.
        $series = $this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0];
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.self::string($series['eventId']).'?scope=this&recurrenceId=20261019T080000Z', self::event($this->calendarId, [
            'summary' => 'Sync, first',
            'start' => ['dateTime' => '2026-10-19T08:00:00', 'timeZone' => 'UTC'],
            'end' => ['dateTime' => '2026-10-19T08:30:00', 'timeZone' => 'UTC'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        self::assertContains([$later['eventId'], $later['recurrenceId'], 'Changed by the range'], $this->notes());
    }

    public function testTwoNotesThatMeetOnOneOccurrenceAreJoined(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, ['summary' => 'Weekly sync, one off', ...self::secondWeek()]), $this->kim);
        self::assertResponseIsSuccessful();
        $override = self::string($this->decodedResponse()['id']);
        $this->putNote($override, null, 'On the changed one');
        // A note left on the series for that occurrence, as notes were kept before they followed their occurrence.
        $this->connection()->insert('event_note', [
            'id' => \Symfony\Component\Uid\Uuid::v7()->toRfc4122(), 'change_seq' => 0, 'user_id' => $this->kimId(), 'event_id' => $series['id'],
            'occurrence_key' => '20261026T080000Z', 'text' => 'On the series', 'updated_at' => '2026-10-19 08:00:00',
        ]);

        // Any change of the resource projects it again, and the two meet on the override.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$override, self::event($this->calendarId, ['summary' => 'Weekly sync, one off again', ...self::secondWeek()]), $this->kim);
        self::assertResponseIsSuccessful();

        $notes = $this->notes();
        self::assertCount(1, $notes);
        self::assertSame($override, $notes[0][0]);
        self::assertSame("On the changed one\n\nOn the series", $notes[0][2]);
    }

    public function testANoteGoesBackToTheSeriesWhenItsOverrideGoes(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, ['summary' => 'Weekly sync, one off', ...self::secondWeek()]), $this->kim);
        self::assertResponseIsSuccessful();
        $override = self::string($this->decodedResponse()['id']);
        $this->putNote($override, null, 'On the changed one');

        // A new rule starts the series fresh: its override goes, the note stays with the occurrence.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=all', self::event($this->calendarId, ['recurrence' => 'FREQ=WEEKLY;COUNT=5']), $this->kim);
        self::assertResponseIsSuccessful();

        self::assertSame(['2026-10-26' => 'On the changed one'], $this->notesByDay());
    }

    public function testNotesOfADeletedEventLeaveTombstones(): void
    {
        $event = $this->create();
        $this->putNote($event['id'], null, 'Bring the slides');
        $note = $this->notes();
        self::assertCount(1, $note);
        $cursor = $this->getJson('/api/v1/sync/changes?since=0', $this->kim)['cursor'];
        self::assertIsInt($cursor);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$event['id'], server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        $delta = $this->getJson('/api/v1/sync/changes?since='.$cursor, $this->kim);
        self::assertIsArray($delta['deleted']);
        self::assertContains('eventNote', array_column($delta['deleted'], 'type'));
    }

    public function testAnUnknownScopeIsRefusedAndTheSeriesKept(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$series['id'].'?scope=thisAndFollowing&recurrenceId=20261026T080000Z', server: $this->kim);
        self::assertResponseStatusCodeSame(422);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=bogus', self::event($this->calendarId, ['summary' => 'Renamed', 'recurrence' => 'FREQ=WEEKLY;COUNT=4']), $this->kim);
        self::assertResponseStatusCodeSame(422);

        self::assertSame(array_fill(0, 4, 'Weekly sync'), array_column($this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00'), 'summary'));
    }

    public function testAChangedOccurrenceAddressedWithoutAScopeIsOnlyThatOccurrence(): void
    {
        $series = $this->create(['recurrence' => 'FREQ=WEEKLY;COUNT=4']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=this&recurrenceId=20261026T080000Z', self::event($this->calendarId, ['summary' => 'Weekly sync, one off', ...self::secondWeek()]), $this->kim);
        self::assertResponseIsSuccessful();
        $override = self::string($this->decodedResponse()['id']);
        self::assertNotSame($series['id'], $override);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$override, self::event($this->calendarId, ['summary' => 'Weekly sync, renamed once', ...self::secondWeek()]), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame(['Weekly sync', 'Weekly sync, renamed once', 'Weekly sync', 'Weekly sync'], array_column($this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00'), 'summary'));

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$override, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $starts = array_map(static fn (array $o): mixed => \is_array($o['start']) ? $o['start']['dateTime'] : null, $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00'));
        self::assertSame(['2026-10-19T07:00:00+00:00', '2026-11-02T08:00:00+00:00', '2026-11-09T08:00:00+00:00'], $starts, 'Only that occurrence is gone.');
        self::assertSame('FREQ=WEEKLY;COUNT=4', $this->getJson('/api/v1/calendar-events/'.$series['id'], $this->kim)['recurrence']);
    }

    public function testSavingAllOccurrencesKeepsTheEndInItsOwnZone(): void
    {
        $flight = [
            'summary' => 'Flight',
            'recurrence' => 'FREQ=WEEKLY;COUNT=2',
            'start' => ['dateTime' => '2026-10-19T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-19T12:00:00', 'timeZone' => 'America/New_York'],
        ];
        $series = $this->create($flight);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series['id'].'?scope=all', self::event($this->calendarId, ['summary' => 'Flight to New York'] + $flight), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame(['dateTime' => '2026-10-19T12:00:00', 'timeZone' => 'America/New_York'], $this->decodedResponse()['end']);

        $first = $this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0];
        self::assertSame(['dateTime' => '2026-10-19T08:00:00+00:00'], $first['start']);
        self::assertSame(['dateTime' => '2026-10-19T16:00:00+00:00'], $first['end'], 'Still eight hours.');
    }

    /**
     * @return iterable<string, array{?string, ?string}>
     */
    public static function seriesFormChanges(): iterable
    {
        yield 'a floating series gets a zone' => [null, 'Europe/Amsterdam'];
        yield 'a zoned series becomes floating' => ['Europe/Amsterdam', null];
    }

    #[DataProvider('seriesFormChanges')]
    public function testChangingASeriesBetweenFloatingAndZonedKeepsItsExceptions(?string $from, ?string $to): void
    {
        $at = static fn (string $time): string => null === $from ? ':'.$time : ';TZID='.$from.':'.$time;
        $this->storeIcal('floating@test', [
            'BEGIN:VEVENT', 'UID:floating@test', 'DTSTAMP:20261018T080000Z', 'DTSTART'.$at('20261019T090000'), 'DTEND'.$at('20261019T093000'),
            'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE'.$at('20261102T090000'), 'SUMMARY:Standup', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:floating@test', 'DTSTAMP:20261018T080000Z', 'RECURRENCE-ID'.$at('20261026T090000'), 'DTSTART'.$at('20261027T140000'), 'DTEND'.$at('20261027T143000'), 'SUMMARY:Standup, moved', 'END:VEVENT',
        ]);
        $seriesId = $this->occurrences($this->kim, '2026-10-19T00:00:00+02:00', '2026-10-20T00:00:00+02:00', 'Europe/Amsterdam')[0]['eventId'];
        self::assertIsString($seriesId);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$seriesId.'?scope=all', self::event($this->calendarId, [
            'summary' => 'Standup',
            'recurrence' => 'FREQ=WEEKLY;COUNT=4',
            'start' => ['dateTime' => '2026-10-19T09:00:00', 'timeZone' => $to],
            'end' => ['dateTime' => '2026-10-19T09:30:00', 'timeZone' => $to],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00', 'Europe/Amsterdam');
        self::assertSame(
            [['Standup', '2026-10-19T07:00:00+00:00'], ['Standup, moved', '2026-10-27T13:00:00+00:00'], ['Standup', '2026-11-09T08:00:00+00:00']],
            array_map(static fn (array $o): array => [$o['summary'], \is_array($o['start']) ? $o['start']['dateTime'] : null], $occurrences),
            'The changed occurrence shows once, and the deleted one stays deleted.',
        );
    }

    public function testASeriesWithARuleSabreCannotExpandShowsAndCanBeEdited(): void
    {
        $this->storeIcal('extended@test', [
            'BEGIN:VEVENT', 'UID:extended@test', 'DTSTAMP:20261019T080000Z', 'DTSTART:20261019T070000Z', 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY;X-FOO=1', 'SUMMARY:Extended', 'END:VEVENT',
        ]);
        $occurrences = $this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00');
        self::assertSame([['Extended', '2026-10-19T07:00:00+00:00', '2026-10-19T07:30:00+00:00']], array_map(static fn (array $o): array => [$o['summary'], \is_array($o['start']) ? $o['start']['dateTime'] : null, \is_array($o['end']) ? $o['end']['dateTime'] : null], $occurrences), 'The server shows its first occurrence.');
        $seriesId = self::string($occurrences[0]['eventId']);
        self::assertSame('FREQ=WEEKLY;X-FOO=1', $this->getJson('/api/v1/calendar-events/'.$seriesId, $this->kim)['recurrence'], 'Devices get the rule as written.');

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$seriesId.'?scope=all', self::event($this->calendarId, [
            'summary' => 'Extended, renamed',
            'recurrence' => 'FREQ=WEEKLY;X-FOO=1',
            'start' => ['dateTime' => '2026-10-19T07:00:00', 'timeZone' => 'UTC'],
            'end' => ['dateTime' => '2026-10-19T07:30:00', 'timeZone' => 'UTC'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame('Extended, renamed', $this->decodedResponse()['summary']);
        self::assertSame('FREQ=WEEKLY;X-FOO=1', $this->decodedResponse()['recurrence']);

        // A new rule must be one the server can expand.
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId, ['recurrence' => 'FREQ=WEEKLY;X-FOO=1']), $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertSame('recurrence', $this->violationPath());
    }

    public function testManagesLocalCalendars(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/calendars', ['name' => 'Family', 'color' => '#E0457B'], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $family = $this->responseString('id');

        $this->client->request('PATCH', '/api/v1/calendars/'.$family, server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['isDefault' => true, 'visible' => false], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
        self::assertTrue($this->decodedResponse()['isDefault']);
        self::assertFalse($this->decodedResponse()['visible']);
        self::assertSame('#e0457b', $this->decodedResponse()['color']);
        self::assertFalse($this->getJson('/api/v1/calendars/'.$this->calendarId, $this->kim)['isDefault']);

        $this->client->request('DELETE', '/api/v1/calendars/'.$family, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        self::assertTrue($this->getJson('/api/v1/calendars/'.$this->calendarId, $this->kim)['isDefault']);

        $this->client->request('DELETE', '/api/v1/calendars/'.$this->calendarId, server: $this->kim);
        self::assertResponseStatusCodeSame(422);
    }

    /**
     * @return array{start: array{dateTime: string, timeZone: string}, end: array{dateTime: string, timeZone: string}}
     */
    private static function secondWeek(): array
    {
        return [
            'start' => ['dateTime' => '2026-10-26T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ];
    }

    private function kimId(): string
    {
        $id = $this->connection()->fetchOne("SELECT id FROM app_user WHERE email = 'kim@example.test'");
        self::assertIsString($id);

        return $id;
    }

    private function putNote(string $eventId, ?string $recurrenceId, string $text): void
    {
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId.'/note', ['recurrenceId' => $recurrenceId, 'text' => $text], $this->kim);
        self::assertResponseIsSuccessful();
    }

    /**
     * Every note as the delta has it: event, occurrence and text.
     *
     * @return list<array{mixed, mixed, mixed}>
     */
    private function notes(): array
    {
        $notes = $this->getJson('/api/v1/sync/changes?since=0', $this->kim)['eventNotes'];
        self::assertIsArray($notes);

        return array_values(array_map(static fn (mixed $note): array => \is_array($note) ? [$note['eventId'], $note['recurrenceId'], $note['text']] : [null, null, null], $notes));
    }

    /**
     * The notes of shown occurrences, by the occurrence's day in Amsterdam: a note counts when its event and
     * occurrence are the ones the occurrence carries, as clients find it.
     *
     * @return array<string, mixed>
     */
    private function notesByDay(): array
    {
        $notes = $this->notes();
        $byDay = [];
        foreach ($this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00', 'Europe/Amsterdam') as $occurrence) {
            foreach ($notes as [$eventId, $recurrenceId, $text]) {
                $start = $occurrence['start'];
                if ($eventId === $occurrence['eventId'] && null !== $recurrenceId && $recurrenceId === $occurrence['recurrenceId'] && \is_array($start) && \is_string($start['dateTime'] ?? null)) {
                    $byDay[new \DateTimeImmutable($start['dateTime'])->setTimezone(new \DateTimeZone('Europe/Amsterdam'))->format('Y-m-d')] = $text;
                }
            }
        }
        ksort($byDay);

        return $byDay;
    }

    /**
     * Stores a calendar object in the Tresso calendar as a provider or CalDAV client would write it.
     *
     * @param list<string> $events the VEVENT lines
     */
    private function storeIcal(string $uid, array $events): void
    {
        $calendar = static::getContainer()->get(\App\Repository\CalendarRepository::class)->find($this->calendarId);
        self::assertNotNull($calendar);
        $ical = implode("\r\n", ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...$events, 'END:VCALENDAR', '']);
        $entityManager = static::getContainer()->get(\Doctrine\ORM\EntityManagerInterface::class);
        $entityManager->wrapInTransaction(static fn () => static::getContainer()->get(\App\Calendar\CalendarStore::class)->save(new \App\Entity\CalendarObject($calendar, $uid, ''), \App\Calendar\ICalendar\CalendarDocument::parse($ical)));
        $entityManager->clear();
    }

    /**
     * @param array<string, mixed> $overrides
     *
     * @return array{id: string, uid: string, ...}
     */
    private function create(array $overrides = []): array
    {
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId, $overrides), $this->kim);
        self::assertResponseStatusCodeSame(201);
        $event = $this->decodedResponse();
        self::assertIsString($event['id'] ?? null);
        self::assertIsString($event['uid'] ?? null);

        /** @var array{id: string, uid: string, ...} */
        return $event;
    }

    /**
     * A daily series at 02:30 in Amsterdam over the night clocks go back, when 02:30 happens twice.
     *
     * @return array{id: string, uid: string, ...}
     */
    private function nightSeries(): array
    {
        return $this->create([
            'summary' => 'Night watch',
            'recurrence' => 'FREQ=DAILY;COUNT=4',
            'start' => ['dateTime' => '2026-10-23T02:30:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-23T03:00:00', 'timeZone' => 'Europe/Amsterdam'],
        ]);
    }

    /**
     * @param array{id: string, ...} $series
     */
    private function recurrenceIdOn(array $series, string $date): string
    {
        foreach ($this->occurrences($this->kim, '2026-10-20T00:00:00+00:00', '2026-10-30T00:00:00+00:00', 'Europe/Amsterdam') as $occurrence) {
            $start = $occurrence['start'];
            if ($occurrence['eventId'] === $series['id'] && \is_array($start) && \is_string($start['dateTime'] ?? null) && new \DateTimeImmutable($start['dateTime'])->setTimezone(new \DateTimeZone('Europe/Amsterdam'))->format('Y-m-d') === $date) {
                return self::string($occurrence['recurrenceId']);
            }
        }
        self::fail('No occurrence on '.$date);
    }

    private function violationPath(): ?string
    {
        $violations = $this->decodedResponse()['violations'] ?? [];
        self::assertIsArray($violations);
        $first = $violations[0] ?? null;

        return \is_array($first) && \is_string($first['propertyPath'] ?? null) ? $first['propertyPath'] : null;
    }
}
