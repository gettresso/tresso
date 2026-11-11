<?php

declare(strict_types=1);

namespace App\Tests\Functional\Calendar;

use App\Calendar\CalendarStore;
use App\Repository\CalendarObjectRepository;
use App\Repository\CalendarOperationRepository;
use App\Repository\CalendarRepository;
use App\Sync\Calendar\CalendarSynchronizer;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\DatabaseTestCase;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\NullLogger;
use Symfony\Component\DependencyInjection\ContainerInterface;

final class SyncCalendarTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use CalendarTestHelpers;

    private const string HOME = 'https://caldav.company.example/dav/calendars/kim/home/';
    private const string HOLIDAYS = 'https://caldav.company.example/dav/calendars/kim/holidays/';

    /** @var array<string, string> */
    private array $kim;

    /** @var array<string, string> */
    private array $worker;

    private string $accountId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'calendar:read', 'calendar:write', 'settings:read', 'settings:write']);
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@company.example',
            'displayName' => 'Kim Visser',
            'username' => 'kim@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        $this->accountId = $this->responseString('id');
        $this->worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        self::assertResponseIsSuccessful();
    }

    public function testReportsCalendarsAndChoosesTheProviderDefault(): void
    {
        $calendars = $this->reportCalendars();

        self::assertSame([self::HOME, self::HOLIDAYS], array_column($calendars, 'remoteId'));
        self::assertSame([null, null], array_column($calendars, 'cursor'));

        $listed = array_values(array_filter($this->getJson('/api/v1/calendars', $this->kim), static fn (mixed $c): bool => \is_array($c) && null !== $c['mailAccountId']));
        self::assertSame(['Home', 'Holidays'], array_column($listed, 'name'));
        self::assertSame([true, false], array_column($listed, 'isDefault'));
        self::assertSame([true, false], array_column($listed, 'writable'));
        self::assertSame(['caldav', 'caldav'], array_column($listed, 'source'));
        self::assertSame('https://caldav.company.example/dav/', $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim)['calendarUrl']);
    }

    public function testTheCalendarStatusTellsTheUserWhatIsWrong(): void
    {
        self::assertSame('unknown', $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim)['calendarStatus']);

        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'auth_failed', 'detail' => 'The calendar server refused the login. iCloud needs an app-specific password.'], $this->worker);
        self::assertResponseIsSuccessful();
        $account = $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim);
        self::assertSame('auth_failed', $account['calendarStatus']);
        self::assertSame('The calendar server refused the login. iCloud needs an app-specific password.', $account['calendarStatusDetail']);
        self::assertSame('active', $account['status'], 'Mail is not affected.');

        $this->reportCalendars();
        $account = $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim);
        self::assertSame('active', $account['calendarStatus']);
        self::assertNull($account['calendarStatusDetail']);

        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'unconfirmed', 'detail' => 'A calendar server was found at https://company.example/.well-known/caldav.'], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame('unconfirmed', $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim)['calendarStatus']);

        // `active` ends only a sync error: an address to confirm stays until the list shows it is solved.
        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'active'], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame('unconfirmed', $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim)['calendarStatus']);
    }

    public function testAFoundCalendarServerIsOfferedWithItsAddress(): void
    {
        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'unconfirmed', 'detail' => 'A calendar server was found.', 'url' => 'https://dav.company.example/caldav/?user=kim'], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame('https://dav.company.example/caldav/?user=kim', $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim)['calendarFoundUrl']);

        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'unconfirmed', 'url' => 'http://dav.company.example/'], $this->worker);
        self::assertResponseStatusCodeSame(422, 'Only https addresses are offered.');

        $this->reportCalendars();
        self::assertNull($this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim)['calendarFoundUrl'], 'Gone once the calendars sync.');
    }

    public function testAnIncompleteCalendarListRemovesNothing(): void
    {
        $this->reportCalendars();

        $this->client->jsonRequest('POST', $this->base().'/calendars', ['workerId' => 'w1', 'calendars' => []], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame(['Holidays', 'Home'], $this->remoteCalendarNames());

        // The first list from another server keeps the calendars; the next one from there is believed.
        $other = ['workerId' => 'w1', 'serverUrl' => 'https://dav.elsewhere.example/', 'calendars' => [['remoteId' => 'https://dav.elsewhere.example/kim/main/', 'name' => 'Main']]];
        $this->client->jsonRequest('POST', $this->base().'/calendars', $other, $this->worker);
        self::assertSame(['Holidays', 'Home', 'Main'], $this->remoteCalendarNames());
        $this->client->jsonRequest('POST', $this->base().'/calendars', $other, $this->worker);
        self::assertSame(['Main'], $this->remoteCalendarNames());
    }

    public function testACalendarWithWritesToMakeIsKept(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->storeObject($home, 'standup.ics', '"1"', 'standup@company.example', 'Standup');
        $eventId = self::string($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($home, ['summary' => 'Standup (short)']), $this->kim);
        self::assertResponseIsSuccessful();

        $this->client->jsonRequest('POST', $this->base().'/calendars', ['workerId' => 'w1', 'calendars' => [['remoteId' => self::HOLIDAYS, 'name' => 'Holidays', 'writable' => false]]], $this->worker);
        self::assertSame(['Holidays', 'Home'], $this->remoteCalendarNames());
        self::assertCount(1, $this->claim(), 'The write is still there.');
    }

    public function testRemovesCalendarsTheProviderNoLongerHas(): void
    {
        $this->reportCalendars();
        $this->client->jsonRequest('POST', $this->base().'/calendars', ['workerId' => 'w1', 'calendars' => [['remoteId' => self::HOME, 'name' => 'Home']]], $this->worker);
        self::assertResponseIsSuccessful();

        $names = array_column(array_filter($this->getJson('/api/v1/calendars', $this->kim), static fn (mixed $c): bool => \is_array($c) && null !== $c['mailAccountId']), 'name');
        self::assertSame(['Home'], $names);
    }

    public function testStoresChangedObjectsKeepsTheCursorAndRemovesDeletedOnes(): void
    {
        $home = $this->reportCalendars()[0]['id'];

        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'cursor' => 'sync-token-1', 'changed' => [
            ['remoteId' => self::HOME.'standup.ics', 'etag' => '"1"', 'ical' => self::object('standup@company.example', 'Standup')],
            ['remoteId' => self::HOME.'todo.ics', 'etag' => '"1"', 'ical' => "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VTODO\r\nUID:t\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame(['stored' => 1, 'removed' => 0, 'skipped' => 1], $this->decodedResponse());

        $occurrences = $this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00');
        self::assertSame(['Standup'], array_column($occurrences, 'summary'));
        self::assertSame('sync-token-1', $this->reportCalendars()[0]['cursor']);

        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'cursor' => 'sync-token-2', 'removed' => [self::HOME.'standup.ics']], $this->worker);
        self::assertSame(['stored' => 0, 'removed' => 1, 'skipped' => 0], $this->decodedResponse());
        self::assertSame([], $this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00'));
    }

    public function testInventoryNamesWhatToFetchAndRemovesWhatIsGone(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->storeObject($home, 'a.ics', '"1"', 'a@company.example', 'A');
        $this->storeObject($home, 'b.ics', '"1"', 'b@company.example', 'B');

        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/inventory', ['workerId' => 'w1', 'objects' => [
            ['remoteId' => self::HOME.'a.ics', 'etag' => '"1"'],
            ['remoteId' => self::HOME.'c.ics', 'etag' => '"1"'],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame(['fetch' => [self::HOME.'c.ics'], 'removed' => 1], $this->decodedResponse());
        self::assertSame(['A'], array_column($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00'), 'summary'));
    }

    public function testAPartialInventoryRemovesNothing(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->storeObject($home, 'a.ics', '"1"', 'a@company.example', 'A');
        $this->storeObject($home, 'b.ics', '"1"', 'b@company.example', 'B');

        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/inventory', ['workerId' => 'w1', 'partial' => true, 'objects' => [
            ['remoteId' => self::HOME.'a.ics', 'etag' => '"2"'],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame(['fetch' => [self::HOME.'a.ics'], 'removed' => 0], $this->decodedResponse());
        $summaries = array_column($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00'), 'summary');
        sort($summaries);
        self::assertSame(['A', 'B'], $summaries);
    }

    public function testAPlainHttpServerAddressIsRefusedAndShownToTheUser(): void
    {
        $container = self::getContainer();
        $container->set(CalendarSynchronizer::class, new CalendarSynchronizer(
            self::service($container, EntityManagerInterface::class),
            self::service($container, CalendarRepository::class),
            self::service($container, CalendarObjectRepository::class),
            self::service($container, CalendarOperationRepository::class),
            self::service($container, CalendarStore::class),
            self::service($container, \App\Calendar\EventNotes::class),
            new NullLogger(),
            false,
        ));

        $this->client->jsonRequest('POST', $this->base().'/calendars', ['workerId' => 'w1', 'serverUrl' => 'http://caldav.company.example/dav/', 'calendars' => [['remoteId' => self::HOME, 'name' => 'Home']]], $this->worker);

        self::assertResponseStatusCodeSame(422);
        $account = $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim);
        self::assertSame('error', $account['calendarStatus']);
        self::assertSame('The calendar server address must use https.', $account['calendarStatusDetail']);
        self::assertNull($account['calendarUrl']);
        self::assertSame([], $this->remoteCalendarNames());
    }

    public function testAReportedSyncErrorStaysUntilTheWorkerSaysTheSyncWorksAgain(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'error', 'detail' => 'Calendars could not be synced; trying again.'], $this->worker);
        self::assertResponseIsSuccessful();

        // The next round lists the calendars again before the failing one fails again, and another one syncs.
        $this->reportCalendars();
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'cursor' => 'sync-token-1'], $this->worker);
        $account = $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim);
        self::assertSame('error', $account['calendarStatus'], 'Neither makes it look active for a minute.');
        self::assertSame('Calendars could not be synced; trying again.', $account['calendarStatusDetail']);

        // A round in which every calendar synced, also when none had changes.
        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'active'], $this->worker);
        self::assertResponseIsSuccessful();
        self::assertSame('active', $this->decodedResponse()['status']);
        $account = $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim);
        self::assertSame('active', $account['calendarStatus']);
        self::assertNull($account['calendarStatusDetail']);
    }

    public function testActiveNeverEndsAStatusTheUserMustActOn(): void
    {
        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'not_granted', 'detail' => 'Allow calendar access.'], $this->worker);
        self::assertResponseIsSuccessful();

        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'active'], $this->worker);

        self::assertResponseIsSuccessful();
        self::assertSame('not_granted', $this->decodedResponse()['status']);
        self::assertSame('not_granted', $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->kim)['calendarStatus']);
    }

    public function testUserEditsAreWrittenByTheLeasingWorker(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->storeObject($home, 'standup.ics', '"1"', 'standup@company.example', 'Standup');
        $eventId = self::string($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($home, ['summary' => 'Standup (short)']), $this->kim);
        self::assertResponseIsSuccessful();

        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        self::assertSame([$this->accountId], $this->decodedResponse()['outbox']);

        $operations = $this->claim();
        self::assertCount(1, $operations);
        self::assertSame('put', $operations[0]['kind']);
        self::assertSame(self::HOME, $operations[0]['calendarRemoteId']);
        self::assertSame(self::HOME.'standup.ics', $operations[0]['remoteId']);
        self::assertSame('"1"', $operations[0]['ifMatch']);
        self::assertIsString($operations[0]['ical']);
        self::assertStringContainsString('SUMMARY:Standup (short)', $operations[0]['ical']);
        self::assertStringContainsString('X-PROVIDER-PRIVATE:kept', $operations[0]['ical'], 'Properties Tresso does not model survive an edit.');
        self::assertSame([], $this->claim(), 'A claimed operation is not handed out twice.');

        $this->report($operations[0]['id'], ['outcome' => 'done', 'etag' => '"2"']);
        self::assertSame(['status' => 'done'], $this->decodedResponse());

        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/inventory', ['workerId' => 'w1', 'objects' => [['remoteId' => self::HOME.'standup.ics', 'etag' => '"2"']]], $this->worker);
        self::assertSame([], $this->decodedResponse()['fetch'], 'The stored version is the one the provider confirmed.');
    }

    public function testASecondEditWaitsForTheFirstAndUsesItsEtag(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->storeObject($home, 'standup.ics', '"1"', 'standup@company.example', 'Standup');
        $eventId = self::string($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($home, ['summary' => 'Standup (short)']), $this->kim);
        $first = $this->claim();
        self::assertSame('"1"', $first[0]['ifMatch']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($home, ['summary' => 'Standup (cancelled?)']), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame([], $this->claim(), 'The second write waits while the first is under way.');

        $this->report($first[0]['id'], ['outcome' => 'done', 'etag' => '"2"']);
        $second = $this->claim();
        self::assertCount(1, $second);
        self::assertSame(self::HOME.'standup.ics', $second[0]['remoteId']);
        self::assertSame('"2"', $second[0]['ifMatch'], 'Sent with the etag the first write got back, not a stale one.');
        self::assertIsString($second[0]['ical']);
        self::assertStringContainsString('SUMMARY:Standup (cancelled?)', $second[0]['ical']);
    }

    public function testADeleteDuringAWriteUsesTheVersionThatWriteMade(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->storeObject($home, 'standup.ics', '"1"', 'standup@company.example', 'Standup');
        $eventId = self::string($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($home, ['summary' => 'Standup (short)']), $this->kim);
        $write = $this->claim();

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $this->report($write[0]['id'], ['outcome' => 'done', 'etag' => '"2"']);

        $operations = $this->claim();
        self::assertCount(1, $operations, 'One delete, not one per version.');
        self::assertSame('delete', $operations[0]['kind']);
        self::assertSame(self::HOME.'standup.ics', $operations[0]['remoteId']);
        self::assertSame('"2"', $operations[0]['ifMatch']);
    }

    public function testAnEditOfANewEventUpdatesTheResourceItsCreationMade(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($home), $this->kim);
        $eventId = self::string($this->decodedResponse()['id'] ?? null);
        $create = $this->claim();
        self::assertNull($create[0]['remoteId']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($home, ['summary' => 'Renamed']), $this->kim);
        $this->report($create[0]['id'], ['outcome' => 'done', 'remoteId' => self::HOME.'new.ics', 'etag' => '"1"']);

        $update = $this->claim();
        self::assertSame(self::HOME.'new.ics', $update[0]['remoteId'], 'Not a second resource.');
        self::assertSame('"1"', $update[0]['ifMatch']);
    }

    public function testShiftingASeriesMovesItsExceptionsGivenInUtc(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'changed' => [['remoteId' => self::HOME.'daily.ics', 'etag' => '"1"', 'ical' => implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Provider//EN', 'BEGIN:VEVENT', 'UID:daily@company.example', 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T091500', 'RRULE:FREQ=DAILY;COUNT=5',
            // 21 October 09:00 in Amsterdam, written in UTC as some servers do.
            'EXDATE:20261021T070000Z', 'SUMMARY:Daily', 'END:VEVENT', 'END:VCALENDAR', '',
        ])]]], $this->worker);
        self::assertResponseIsSuccessful();
        $eventId = self::string($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId.'?scope=all', self::event($home, [
            'summary' => 'Daily',
            'recurrence' => 'FREQ=DAILY;COUNT=5',
            'start' => ['dateTime' => '2026-10-19T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-19T10:15:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();

        $starts = array_column($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-25T00:00:00+00:00'), 'start');
        self::assertSame([
            ['dateTime' => '2026-10-19T08:00:00+00:00'],
            ['dateTime' => '2026-10-20T08:00:00+00:00'],
            ['dateTime' => '2026-10-22T08:00:00+00:00'],
            ['dateTime' => '2026-10-23T08:00:00+00:00'],
        ], $starts, 'The 21st stays excluded at its new time.');
    }

    /**
     * One resource the API cannot store is skipped: the batch is taken and the cursor moves on, so the calendar keeps
     * syncing.
     */
    public function testAResourceTheApiCannotStoreIsSkippedAndTheBatchTaken(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $good = self::object('standup@company.example', 'Standup');
        $replace = static fn (string $uid, string $from, string $to): string => str_replace($from, $to, self::object($uid, 'Bad'));
        $start = 'DTSTART;TZID=Europe/Amsterdam:20261019T090000';
        $end = 'DTEND;TZID=Europe/Amsterdam:20261019T091500';
        $bad = [
            'dashes' => $replace('dashes@company.example', $start, 'DTSTART:2026-10-19T09:00:00'),
            'duration' => $replace('duration@company.example', $end, 'DURATION:1H'),
            'uid' => self::object(str_repeat('x', 1025), 'Long'),
            'rule' => $replace('rule@company.example', 'SUMMARY:', "RRULE:garbage\r\nSUMMARY:"),
            'year10000' => $replace('year10000@company.example', $start."\r\n".$end, "DTSTART:99991231T230000Z\r\nDURATION:P2D"),
            'interval' => $replace('interval@company.example', $end, 'DURATION:P99999999999999999999D'),
            'key' => $replace('key@company.example', 'SUMMARY:', "RECURRENCE-ID;TZID=America/Los_Angeles:99991231T230000\r\nSUMMARY:"),
            'year0' => $replace('year0@company.example', $start."\r\n".$end, 'DTSTART:00000101T000000Z'),
            'nul' => $replace('nul@company.example', 'SUMMARY:Bad', "SUMMARY:B\0d"),
        ];
        // Kept: devices expand the rule themselves, the server shows its first occurrence.
        $fortnightly = str_replace('SUMMARY:', "RRULE:FREQ=FORTNIGHTLY;COUNT=3\r\nSUMMARY:", self::object('fortnightly@company.example', 'Fortnightly'));
        $changed = [
            ['remoteId' => self::HOME.'standup.ics', 'etag' => '"1"', 'ical' => $good],
            ['remoteId' => self::HOME.'fortnightly.ics', 'etag' => '"1"', 'ical' => $fortnightly],
        ];
        foreach ($bad as $name => $ical) {
            $changed[] = ['remoteId' => self::HOME.$name.'.ics', 'etag' => '"1"', 'ical' => $ical];
        }
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'cursor' => 'sync-token-1', 'changed' => $changed], $this->worker);

        self::assertResponseIsSuccessful();
        self::assertSame(['stored' => 2, 'removed' => 0, 'skipped' => \count($bad)], $this->decodedResponse());
        self::assertSame('sync-token-1', $this->reportCalendars()[0]['cursor']);
        $summaries = array_column($this->occurrences($this->kim, '2026-10-01T00:00:00+00:00', '2026-12-01T00:00:00+00:00'), 'summary');
        sort($summaries);
        self::assertSame(['Fortnightly', 'Standup'], $summaries, 'The rule sabre cannot expand shows its first occurrence.');
        self::assertSame('FREQ=FORTNIGHTLY;COUNT=3', $this->connection()->fetchOne("SELECT rrule FROM calendar_event WHERE uid = 'fortnightly@company.example'"), 'Devices get the rule as written.');
    }

    public function testANoteStaysWithAnEventTheProviderReportsUnderANewUid(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'changed' => [
            ['remoteId' => self::HOME.'standup.ics', 'etag' => '"1"', 'ical' => self::object('standup@company.example', 'Standup')],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        $eventId = self::string($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId.'/note', ['text' => 'Bring the numbers'], $this->kim);
        self::assertResponseIsSuccessful();

        // The same resource, now under another UID (a provider that rewrote it).
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'changed' => [
            ['remoteId' => self::HOME.'standup.ics', 'etag' => '"2"', 'ical' => self::object('standup-2@company.example', 'Standup')],
        ]], $this->worker);
        self::assertSame(['stored' => 1, 'removed' => 0, 'skipped' => 0], $this->decodedResponse());

        $newId = self::string($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        self::assertNotSame($eventId, $newId);
        $notes = $this->getJson('/api/v1/sync/changes?since=0', $this->kim)['eventNotes'];
        self::assertIsArray($notes);
        self::assertSame([[$newId, 'Bring the numbers']], array_map(static fn (mixed $note): array => \is_array($note) ? [$note['eventId'], $note['text']] : [], $notes));
    }

    public function testASequenceLargerThanTheColumnIsStored(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'changed' => [
            ['remoteId' => self::HOME.'standup.ics', 'etag' => '"1"', 'ical' => str_replace('SUMMARY:', "SEQUENCE:3000000000\r\nSUMMARY:", self::object('standup@company.example', 'Standup'))],
        ]], $this->worker);

        self::assertResponseIsSuccessful();
        self::assertSame(['stored' => 1, 'removed' => 0, 'skipped' => 0], $this->decodedResponse());
        self::assertEquals(2147483647, $this->connection()->fetchOne("SELECT sequence FROM calendar_event WHERE uid = 'standup@company.example'"));
    }

    public function testSeriesRepeatingMoreOftenThanHourlyAreSkipped(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'changed' => [['remoteId' => self::HOME.'minutely.ics', 'etag' => '"1"', 'ical' => implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Provider//EN', 'BEGIN:VEVENT', 'UID:minutely@company.example', 'DTSTAMP:20261018T080000Z',
            'DTSTART:20261019T090000Z', 'DURATION:PT1M', 'RRULE:FREQ=MINUTELY', 'SUMMARY:Spin', 'END:VEVENT', 'END:VCALENDAR', '',
        ])]]], $this->worker);

        self::assertResponseIsSuccessful();
        self::assertSame(['stored' => 0, 'removed' => 0, 'skipped' => 1], $this->decodedResponse());
    }

    public function testNewEventsAndDeletesReachTheProvider(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($home), $this->kim);
        self::assertResponseStatusCodeSame(201);
        $eventId = self::string($this->decodedResponse()['id'] ?? null);

        $operations = $this->claim();
        self::assertNull($operations[0]['remoteId']);
        self::assertNull($operations[0]['ifMatch']);
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => self::HOME.'new.ics', 'etag' => '"1"']);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId, server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        $operations = $this->claim();
        self::assertSame('delete', $operations[0]['kind']);
        self::assertSame(self::HOME.'new.ics', $operations[0]['remoteId']);
        self::assertSame('"1"', $operations[0]['ifMatch']);
        self::assertNull($operations[0]['ical']);
    }

    public function testAConflictKeepsTheProviderVersionAndTellsTheUser(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->storeObject($home, 'standup.ics', '"1"', 'standup@company.example', 'Standup');
        $eventId = self::string($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($home, ['summary' => 'Mine']), $this->kim);

        $operation = $this->claim()[0];
        $this->report($operation['id'], ['outcome' => 'conflict', 'current' => ['remoteId' => self::HOME.'standup.ics', 'etag' => '"3"', 'ical' => self::object('standup@company.example', 'Theirs')]]);
        self::assertSame(['status' => 'failed'], $this->decodedResponse());

        $event = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->kim);
        self::assertSame('Theirs', $event['summary']);
        self::assertSame('This event was changed elsewhere at the same time; that version was kept.', $event['syncError']);
    }

    public function testProviderChangesWaitForAPendingWrite(): void
    {
        $home = $this->reportCalendars()[0]['id'];
        $this->storeObject($home, 'standup.ics', '"1"', 'standup@company.example', 'Standup');
        $eventId = self::string($this->occurrences($this->kim, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($home, ['summary' => 'Mine']), $this->kim);

        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'changed' => [['remoteId' => self::HOME.'standup.ics', 'etag' => '"2"', 'ical' => self::object('standup@company.example', 'Theirs')]]], $this->worker);
        self::assertSame(['stored' => 0, 'removed' => 0, 'skipped' => 1], $this->decodedResponse());
        self::assertSame('Mine', $this->getJson('/api/v1/calendar-events/'.$eventId, $this->kim)['summary']);
    }

    public function testOnlyTheLeasingWorkerMayReport(): void
    {
        $home = $this->reportCalendars()[0]['id'];

        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$home.'/objects', ['workerId' => 'w2', 'changed' => []], $this->worker);
        self::assertResponseStatusCodeSame(404);
        $this->client->jsonRequest('POST', $this->base().'/calendar-operations/claim', ['workerId' => 'w2'], $this->worker);
        self::assertResponseStatusCodeSame(404);
    }

    /**
     * @return list<string>
     */
    private function remoteCalendarNames(): array
    {
        $names = [];
        foreach ($this->getJson('/api/v1/calendars', $this->kim) as $calendar) {
            if (\is_array($calendar) && null !== $calendar['mailAccountId']) {
                $names[] = self::string($calendar['name']);
            }
        }
        sort($names);

        return $names;
    }

    private function base(): string
    {
        return '/internal/sync/accounts/'.$this->accountId;
    }

    /**
     * @return list<array{remoteId: string, id: string, cursor: ?string}>
     */
    private function reportCalendars(): array
    {
        $this->client->jsonRequest('POST', $this->base().'/calendars', [
            'workerId' => 'w1',
            'serverUrl' => 'https://caldav.company.example/dav/',
            'calendars' => [
                ['remoteId' => self::HOME, 'name' => 'Home', 'color' => '#2E7D32', 'timeZone' => 'Europe/Amsterdam', 'isDefault' => true],
                ['remoteId' => self::HOLIDAYS, 'name' => 'Holidays', 'writable' => false],
            ],
        ], $this->worker);
        self::assertResponseIsSuccessful();
        $calendars = $this->decodedResponse()['calendars'] ?? null;
        self::assertIsArray($calendars);

        /** @var list<array{remoteId: string, id: string, cursor: ?string}> */
        return $calendars;
    }

    private function storeObject(string $calendarId, string $name, string $etag, string $uid, string $summary): void
    {
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$calendarId.'/objects', ['workerId' => 'w1', 'changed' => [
            ['remoteId' => self::HOME.$name, 'etag' => $etag, 'ical' => self::object($uid, $summary)],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function claim(): array
    {
        $this->client->jsonRequest('POST', $this->base().'/calendar-operations/claim', ['workerId' => 'w1'], $this->worker);
        self::assertResponseIsSuccessful();
        $operations = $this->decodedResponse()['operations'] ?? null;
        self::assertIsArray($operations);

        /** @var list<array<string, mixed>> */
        return $operations;
    }

    /**
     * @param array<string, mixed> $result
     */
    private function report(mixed $operationId, array $result): void
    {
        self::assertIsString($operationId);
        $this->client->jsonRequest('POST', $this->base().'/calendar-operations/'.$operationId.'/result', ['workerId' => 'w1', ...$result], $this->worker);
        self::assertResponseIsSuccessful();
    }

    private static function object(string $uid, string $summary): string
    {
        return implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Provider//EN', 'BEGIN:VEVENT', 'UID:'.$uid, 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T091500',
            'SUMMARY:'.$summary, 'X-PROVIDER-PRIVATE:kept', 'END:VEVENT', 'END:VCALENDAR', '',
        ]);
    }

    /**
     * @template T of object
     *
     * @param class-string<T> $id
     *
     * @return T
     */
    private static function service(ContainerInterface $container, string $id): object
    {
        $service = $container->get($id);
        self::assertInstanceOf($id, $service);

        return $service;
    }
}
