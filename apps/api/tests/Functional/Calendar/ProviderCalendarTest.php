<?php

declare(strict_types=1);

namespace App\Tests\Functional\Calendar;

use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\ConnectsProviderAccounts;
use App\Tests\Functional\DatabaseTestCase;

/**
 * Google and Microsoft calendars: the provider schedules (sends invitations, updates and replies), so writes carry
 * whether to tell attendees and the reply's comment, and the provider makes Google Meet and Teams meetings.
 */
final class ProviderCalendarTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use CalendarTestHelpers;
    use ConnectsProviderAccounts;

    private const string PRIMARY = 'kim@gmail.example';
    private const string HOLIDAYS = 'en.dutch#holiday@group.v.calendar.google.com';

    /** @var array<string, string> */
    private array $worker;

    private string $accountId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim Visser');
        $this->user = $this->userHeaders('kim@example.test', ['mail:read', 'mail:send', 'calendar:read', 'calendar:write', 'settings:read', 'settings:write']);
        $query = $this->start('google', features: ['mail', 'calendar']);
        $this->googleTokens(scope: 'openid '.self::GMAIL_SCOPE.' '.self::GOOGLE_CALENDAR_SCOPES);
        $this->returnFromProvider('google', $query['state']);
        $this->accountId = $this->onlyAccount()->getId()->toRfc4122();
        $this->worker = $this->workerHeaders('sync:lease sync:ingest sync:credentials');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        self::assertResponseIsSuccessful();
    }

    public function testProviderCalendarsSayWhichMeetingsTheirEventsCanGet(): void
    {
        $this->reportCalendars();

        $calendars = array_values(array_filter($this->getJson('/api/v1/calendars', $this->user), static fn (mixed $c): bool => \is_array($c) && null !== $c['mailAccountId']));
        self::assertSame(['Kim', 'Holidays'], array_column($calendars, 'name'));
        self::assertSame(['google', 'google'], array_column($calendars, 'source'));
        self::assertSame([['meet'], []], array_column($calendars, 'conferenceProviders'));
        self::assertSame([true, true], array_column($calendars, 'providerSchedules'));

        $this->client->request('GET', '/api/v1/sync/changes?since=0', server: $this->user);
        self::assertResponseIsSuccessful();
        $synced = $this->decodedResponse()['calendars'] ?? null;
        self::assertIsArray($synced);
        $byName = array_column($synced, 'conferenceProviders', 'name');
        self::assertSame(['meet'], $byName['Kim'] ?? null, 'Clients learn it through the delta too.');
        self::assertSame([], $byName['Tresso'] ?? null);

        $this->client->jsonRequest('POST', $this->base().'/calendars', ['workerId' => 'w1', 'source' => 'google', 'providerSchedules' => true, 'calendars' => [
            ['remoteId' => self::PRIMARY, 'name' => 'Kim', 'conferenceProviders' => ['zoom']],
        ]], $this->worker);
        self::assertResponseStatusCodeSame(422);
    }

    public function testAnAnswerLeavesTheReplyToTheProviderWithItsComment(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'review', '"1"', implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:review@google.com', 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T093000', 'SUMMARY:Review',
            'ORGANIZER:mailto:lisa@example.org', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:lisa@example.org',
            'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:kim@gmail.example', 'END:VEVENT', 'END:VCALENDAR', '',
        ]));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'tentative', 'comment' => '  Might be late  ', 'notify' => false], $this->user);
        self::assertResponseIsSuccessful();

        self::assertSame([], $this->outgoing(), 'Google sends the reply, not Tresso.');
        $operations = $this->claim();
        self::assertCount(1, $operations);
        self::assertFalse($operations[0]['notify']);
        self::assertSame('Might be late', $operations[0]['comment']);
        self::assertIsString($operations[0]['ical']);
        self::assertStringContainsString('PARTSTAT=TENTATIVE', $operations[0]['ical']);
    }

    public function testChangesFoldedIntoOneWriteTellAttendeesWhenAnyOfThemDoes(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events?notify=true', self::event($primary, ['attendees' => [['address' => 'lisa@example.org']]]), $this->user);
        self::assertResponseStatusCodeSame(201);
        $eventId = $this->responseString('id');
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId.'?notify=false', self::event($primary, ['summary' => 'Weekly sync, moved', 'attendees' => [['address' => 'lisa@example.org']]]), $this->user);
        self::assertResponseIsSuccessful();

        $operations = $this->claim();
        self::assertCount(1, $operations, 'The second edit waits in the first write.');
        self::assertTrue($operations[0]['notify'], 'Lisa still hears about the new event.');
        self::assertNull($operations[0]['comment']);
        self::assertSame([], $this->outgoing(), 'Google sends the invitation.');
    }

    public function testADeleteTheUserKeepsQuietAboutTellsTheWorker(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'lunch', '"1"', self::object('lunch@google.com', 'Lunch'));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'?notify=false', server: $this->user);
        self::assertResponseStatusCodeSame(204);

        $operations = $this->claim();
        self::assertSame('delete', $operations[0]['kind']);
        self::assertSame('lunch', $operations[0]['remoteId']);
        self::assertFalse($operations[0]['notify']);
    }

    public function testANewEventAsksForAMeetMeetingAndKeepsTheOneGoogleMade(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($primary, ['conferenceProvider' => 'meet']), $this->user);
        self::assertResponseStatusCodeSame(201);
        $eventId = $this->responseString('id');

        $operations = $this->claim();
        $ical = self::string($operations[0]['ical']);
        self::assertStringContainsString('X-TRESSO-CONFERENCE-REQUEST:meet', $ical);
        self::assertTrue($operations[0]['notify']);
        $uid = self::string($operations[0]['uid']);

        // Google's version has the meeting, and no request any more.
        $current = str_replace('X-TRESSO-CONFERENCE-REQUEST:meet', "CONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL=Google Meet:https://meet.google.com/abc-defg-hij\r\nX-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij", $ical);
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => $current]]);
        self::assertSame(['status' => 'done'], $this->decodedResponse());

        $event = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->user);
        self::assertSame(['provider' => 'meet', 'url' => 'https://meet.google.com/abc-defg-hij', 'id' => null, 'dialIn' => null], $event['conference']);
        self::assertSame($uid, $event['uid'] ?? $uid);
        self::assertSame([], $this->claim(), 'The provider\'s version is not written back.');

        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$primary.'/inventory', ['workerId' => 'w1', 'objects' => [['remoteId' => 'trabc', 'etag' => 'e1']]], $this->worker);
        self::assertSame([], $this->decodedResponse()['fetch'], 'The stored version is Google\'s.');
    }

    public function testAMeetingTheCalendarCannotMakeIsRefused(): void
    {
        $calendars = $this->reportCalendars();
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendars[0]['id'], ['conferenceProvider' => 'teams']), $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('This calendar cannot make Microsoft Teams meetings.', (string) $this->client->getResponse()->getContent());

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->localCalendarId($this->user), ['conferenceProvider' => 'meet']), $this->user);
        self::assertResponseStatusCodeSame(422);
    }

    public function testAWriteTheProviderChangedMeanwhileKeepsTheUsersNewerEdit(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($primary, ['conferenceProvider' => 'meet']), $this->user);
        $eventId = $this->responseString('id');
        $operations = $this->claim();
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Weekly sync, renamed']), $this->user);
        self::assertResponseIsSuccessful();

        $current = str_replace('X-TRESSO-CONFERENCE-REQUEST:meet', 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', self::string($operations[0]['ical']));
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => $current]]);

        self::assertSame('Weekly sync, renamed', $this->getJson('/api/v1/calendar-events/'.$eventId, $this->user)['summary']);
        $next = $this->claim();
        self::assertCount(1, $next);
        self::assertSame('trabc', $next[0]['remoteId']);
        self::assertSame('e1', $next[0]['ifMatch'], 'The rename goes out on top of the version the first write made.');
    }

    public function testMicrosoftCalendarsAskForTeamsMeetings(): void
    {
        $query = $this->start('microsoft', features: ['mail', 'calendar']);
        $this->router()->respond(self::MICROSOFT_TOKEN, (string) json_encode([
            'access_token' => 'ms-access-1',
            'expires_in' => 3600,
            'refresh_token' => 'ms-refresh-1',
            'scope' => 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite',
            'id_token' => $this->idToken(['aud' => 'test-microsoft-client', 'tid' => 'tenant-1', 'oid' => 'object-1']),
        ]));
        $this->router()->respond(self::GRAPH_ME, (string) json_encode(['mail' => 'kim@contoso.example', 'displayName' => 'Kim']));
        $connected = [];
        parse_str((string) parse_url($this->returnFromProvider('microsoft', $query['state']), \PHP_URL_QUERY), $connected);
        $accountId = self::string($connected['connected'] ?? null);
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $this->worker);
        self::assertResponseIsSuccessful();

        $base = '/internal/sync/accounts/'.$accountId;
        $this->client->jsonRequest('POST', $base.'/calendars', ['workerId' => 'w1', 'source' => 'microsoft', 'providerSchedules' => true, 'calendars' => [
            ['remoteId' => 'AAMkCal1', 'name' => 'Calendar', 'isDefault' => true, 'conferenceProviders' => ['teams']],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        $calendars = $this->decodedResponse()['calendars'] ?? null;
        self::assertIsArray($calendars);
        self::assertIsArray($calendars[0]);
        $calendarId = self::string($calendars[0]['id']);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, ['conferenceProvider' => 'teams']), $this->user);
        self::assertResponseStatusCodeSame(201);

        $this->client->jsonRequest('POST', $base.'/calendar-operations/claim', ['workerId' => 'w1'], $this->worker);
        $operations = $this->decodedResponse()['operations'] ?? null;
        self::assertIsArray($operations);
        self::assertCount(1, $operations);
        self::assertIsArray($operations[0]);
        self::assertStringContainsString('X-TRESSO-CONFERENCE-REQUEST:teams', self::string($operations[0]['ical']));
    }

    public function testARetryAfterPartOfAWriteBasesTheNextAttemptOnIt(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'lunch', '"1"', self::object('lunch@google.com', 'Lunch'));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Lunch, later']), $this->user);
        self::assertResponseIsSuccessful();
        $operations = $this->claim();
        self::assertSame('"1"', $operations[0]['ifMatch']);

        $this->report($operations[0]['id'], ['outcome' => 'retry', 'error' => 'Google had a problem (HTTP 503).', 'remoteId' => 'lunch', 'etag' => '"2"']);
        self::assertSame(['status' => 'retry'], $this->decodedResponse());

        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$primary.'/inventory', ['workerId' => 'w1', 'objects' => [['remoteId' => 'lunch', 'etag' => '"2"']]], $this->worker);
        self::assertSame([], $this->decodedResponse()['fetch'], 'The next attempt is conditional on the version the first part made.');
        self::assertSame('Lunch, later', $this->getJson('/api/v1/calendar-events/'.$eventId, $this->user)['summary'], 'The edit is kept for the retry.');
    }

    public function testAWriteTheWorkerCouldNotReadBackKeepsTheLastKnownETag(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'lunch', '"1"', self::object('lunch@google.com', 'Lunch'));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Lunch, later']), $this->user);
        $operations = $this->claim();

        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'lunch']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Lunch, much later']), $this->user);
        self::assertResponseIsSuccessful();
        self::assertSame('"1"', $this->claim()[0]['ifMatch'], 'The next write stays conditional.');
    }

    public function testAMeetingWithGuestsStaysWithItsOrganizerWithinAGoogleAccount(): void
    {
        $this->client->jsonRequest('POST', $this->base().'/calendars', ['workerId' => 'w1', 'source' => 'google', 'providerSchedules' => true, 'calendars' => [
            ['remoteId' => self::PRIMARY, 'name' => 'Kim', 'isDefault' => true],
            ['remoteId' => 'team@group.calendar.google.com', 'name' => 'Team'],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        $calendars = $this->decodedResponse()['calendars'] ?? null;
        self::assertIsArray($calendars);
        [$primary, $team] = array_map(static fn (mixed $calendar): string => \is_array($calendar) ? self::string($calendar['id']) : '', $calendars);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($primary, ['attendees' => [['address' => 'lisa@example.org']]]), $this->user);
        self::assertResponseStatusCodeSame(201);
        $meeting = $this->responseString('id');
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$meeting, self::event($team, ['attendees' => [['address' => 'lisa@example.org']]]), $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('Google would make the other calendar the organizer of this meeting', (string) $this->client->getResponse()->getContent());

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($primary, ['summary' => 'Focus']), $this->user);
        $focus = $this->responseString('id');
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$focus, self::event($team, ['summary' => 'Focus']), $this->user);
        self::assertResponseIsSuccessful('An event without guests moves.');
    }

    public function testAMoveTheProviderRefusedForAChangeLeavesTheEventWhereTheProviderHasIt(): void
    {
        $this->client->jsonRequest('POST', $this->base().'/calendars', ['workerId' => 'w1', 'source' => 'google', 'providerSchedules' => true, 'calendars' => [
            ['remoteId' => self::PRIMARY, 'name' => 'Kim', 'isDefault' => true],
            ['remoteId' => 'team@group.calendar.google.com', 'name' => 'Team'],
        ]], $this->worker);
        $calendars = $this->decodedResponse()['calendars'] ?? null;
        self::assertIsArray($calendars);
        [$primary, $team] = array_map(static fn (mixed $calendar): string => \is_array($calendar) ? self::string($calendar['id']) : '', $calendars);
        $this->storeObject($primary, 'lunch', '"1"', self::object('lunch@google.com', 'Lunch'));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($team, ['summary' => 'Lunch']), $this->user);
        self::assertResponseIsSuccessful();
        $operations = $this->claim();
        self::assertSame(['delete', 'put'], array_column($operations, 'kind'));

        // The worker found the event changed at Google: the create is held back, the delete reports Google's version.
        $this->report($operations[1]['id'], ['outcome' => 'conflict']);
        $this->report($operations[0]['id'], ['outcome' => 'conflict', 'current' => ['remoteId' => 'lunch', 'etag' => '"2"', 'ical' => self::object('lunch@google.com', 'Lunch, moved by Lisa')]]);

        $occurrences = $this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00');
        self::assertCount(1, $occurrences, 'One event, not a copy in each calendar.');
        self::assertSame('Lunch, moved by Lisa', $occurrences[0]['summary']);
        self::assertSame($primary, $occurrences[0]['calendarId']);
        self::assertSame([], $this->claim());
    }

    public function testAPartlyWrittenChangeWithoutRetriesLeftTakesTheProvidersVersion(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'lunch', '"1"', self::object('lunch@google.com', 'Lunch'));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Lunch, later']), $this->user);
        $operations = $this->claim();
        $this->connection()->executeStatement('UPDATE calendar_operation SET attempts = 6');

        $this->report($operations[0]['id'], ['outcome' => 'retry', 'error' => 'Google had a problem (HTTP 503).', 'remoteId' => 'lunch', 'etag' => '"2"',
            'current' => ['remoteId' => 'lunch', 'etag' => '"2"', 'ical' => self::object('lunch@google.com', 'Lunch, half written')]]);
        self::assertSame(['status' => 'failed'], $this->decodedResponse());

        $event = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->user);
        self::assertSame('Lunch, half written', $event['summary'], 'Tresso shows what the provider has, not the change it could not finish.');
        self::assertSame('Google had a problem (HTTP 503).', $event['syncError']);
        self::assertSame([], $this->claim());
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$primary.'/inventory', ['workerId' => 'w1', 'objects' => [['remoteId' => 'lunch', 'etag' => '"2"']]], $this->worker);
        self::assertSame([], $this->decodedResponse()['fetch']);
    }

    public function testCalendarProblemsThePolicyNamesAreReported(): void
    {
        $this->client->jsonRequest('POST', $this->base().'/calendar-status', ['workerId' => 'w1', 'status' => 'not_granted', 'detail' => 'Tresso is not allowed to use the calendars of this account.'], $this->worker);
        self::assertResponseIsSuccessful();
        $account = $this->getJson('/api/v1/mail-accounts/'.$this->accountId, $this->user);
        self::assertSame('not_granted', $account['calendarStatus']);
        self::assertSame('active', $account['status']);
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
            'source' => 'google',
            'providerSchedules' => true,
            'calendars' => [
                ['remoteId' => self::PRIMARY, 'name' => 'Kim', 'color' => '#9fc6e7', 'timeZone' => 'Europe/Amsterdam', 'isDefault' => true, 'conferenceProviders' => ['meet']],
                ['remoteId' => self::HOLIDAYS, 'name' => 'Holidays', 'writable' => false],
            ],
        ], $this->worker);
        self::assertResponseIsSuccessful();
        $calendars = $this->decodedResponse()['calendars'] ?? null;
        self::assertIsArray($calendars);

        /** @var list<array{remoteId: string, id: string, cursor: ?string}> */
        return $calendars;
    }

    private function storeObject(string $calendarId, string $remoteId, string $etag, string $ical): void
    {
        $this->client->jsonRequest('POST', $this->base().'/calendars/'.$calendarId.'/objects', ['workerId' => 'w1', 'changed' => [
            ['remoteId' => $remoteId, 'etag' => $etag, 'ical' => $ical],
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
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:'.$uid, 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T091500',
            'SUMMARY:'.$summary, 'END:VEVENT', 'END:VCALENDAR', '',
        ]);
    }
}
