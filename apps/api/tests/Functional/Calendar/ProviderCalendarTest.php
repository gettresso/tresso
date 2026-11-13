<?php

declare(strict_types=1);

namespace App\Tests\Functional\Calendar;

use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\ConnectsProviderAccounts;
use App\Tests\Functional\DatabaseTestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\Clock\Test\ClockSensitiveTrait;

/**
 * Google and Microsoft calendars: the provider schedules (sends invitations, updates and replies), so writes carry
 * whether to tell attendees and the reply's comment, and the provider makes Google Meet and Teams meetings.
 */
final class ProviderCalendarTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use CalendarTestHelpers;
    use ConnectsProviderAccounts;
    use ClockSensitiveTrait;

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
        self::assertSame(['provider' => 'meet', 'url' => 'https://meet.google.com/abc-defg-hij', 'id' => null, 'dialIn' => null, 'removable' => true], $event['conference']);
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
        [$accountId, $calendarId] = $this->connectMicrosoft();

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, ['conferenceProvider' => 'teams']), $this->user);
        self::assertResponseStatusCodeSame(201);

        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$accountId.'/calendar-operations/claim', ['workerId' => 'w1'], $this->worker);
        $operations = $this->decodedResponse()['operations'] ?? null;
        self::assertIsArray($operations);
        self::assertCount(1, $operations);
        self::assertIsArray($operations[0]);
        self::assertStringContainsString('X-TRESSO-CONFERENCE-REQUEST:teams', self::string($operations[0]['ical']));
    }

    /**
     * A Microsoft 365 account with one calendar that makes Teams meetings.
     *
     * @return array{string, string} the account's id and the calendar's
     */
    private function connectMicrosoft(): array
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

        return [$accountId, self::string($calendars[0]['id'])];
    }

    public function testAMeetingAskedForIsPendingUntilTheProviderMadeIt(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($primary, ['conferenceProvider' => 'meet']), $this->user);
        self::assertResponseStatusCodeSame(201);
        $event = $this->decodedResponse();
        $eventId = self::string($event['id']);
        $request = $event['conferenceRequest'] ?? null;
        self::assertIsArray($request);
        self::assertSame(['provider', 'status', 'reason', 'requestedAt'], array_keys($request), 'Clients never see the nonce.');
        self::assertSame(['meet', 'pending', null], [$request['provider'], $request['status'], $request['reason']]);
        self::assertNull($event['conference']);
        $nonce = $this->nonce($eventId);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['conferenceProvider' => 'meet']), $this->user);
        self::assertResponseIsSuccessful();
        self::assertSame($request, $this->decodedResponse()['conferenceRequest'], 'Asking again while it is on its way changes nothing.');
        self::assertSame($nonce, $this->nonce($eventId));

        $operations = $this->claim();
        self::assertCount(1, $operations);
        $ical = self::string($operations[0]['ical']);
        self::assertStringContainsString("X-TRESSO-CONFERENCE-REQUEST:meet\r\n", $ical);
        self::assertStringContainsString("X-TRESSO-CONFERENCE-NONCE:".$nonce."\r\n", $ical);
        self::assertMatchesRegularExpression('/^[0-9a-f]{8}$/', $nonce);

        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->user)['calendarEvents'] ?? null;
        self::assertIsArray($delta);
        self::assertSame([$request], array_column($delta, 'conferenceRequest'), 'Clients learn it through the delta.');
        self::assertSame([$request], array_column($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00'), 'conferenceRequest'));

        // Google answered that it is still making the meeting; it comes with the next sync.
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'conferenceStatus' => 'pending', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => self::providerVersion($ical)]]);
        self::assertSame('pending', $this->conferenceRequest($eventId)['status'] ?? null);

        $this->storeObject($primary, 'trabc', 'e2', self::providerVersion($ical, 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij'));
        $event = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->user);
        self::assertSame('https://meet.google.com/abc-defg-hij', \is_array($event['conference']) ? $event['conference']['url'] : null);
        self::assertNull($event['conferenceRequest'], 'Nothing is pending once the meeting is there.');
        self::assertNull($this->connection()->fetchOne('SELECT conference_request FROM calendar_object WHERE remote_id = ?', ['trabc']));
    }

    public function testAMeetingTheProviderMadeEndsTheRequest(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $operations = $this->claim();
        $ical = self::string($operations[0]['ical']);

        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => self::providerVersion($ical, "CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://meet.google.com/abc-defg-hij\r\nX-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij")]]);

        $event = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->user);
        self::assertSame('meet', \is_array($event['conference']) ? $event['conference']['provider'] : null);
        self::assertNull($event['conferenceRequest']);
    }

    /**
     * @return iterable<string, array{array<string, mixed>, string}>
     */
    public static function outcomesWithoutAMeeting(): iterable
    {
        yield 'done without a meeting' => [['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1'], 'refused'];
        yield 'done, the calendar cannot have it' => [['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'conferenceStatus' => 'failed', 'conferenceError' => 'not_supported'], 'not_supported'];
        yield 'refused' => [['outcome' => 'failed', 'error' => 'Google refused the event (HTTP 400).'], 'refused'];
    }

    /**
     * @param array<string, mixed> $result
     */
    #[DataProvider('outcomesWithoutAMeeting')]
    public function testAMeetingTheProviderDidNotMakeFails(array $result, string $reason): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $operations = $this->claim();
        if ('done' === $result['outcome']) {
            $result['current'] = ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => self::providerVersion(self::string($operations[0]['ical']))];
        }

        $this->report($operations[0]['id'], $result);

        $request = $this->conferenceRequest($eventId);
        self::assertSame(['meet', 'failed', $reason], [$request['provider'] ?? null, $request['status'] ?? null, $request['reason'] ?? null]);
        self::assertStringNotContainsString('HTTP 400', (string) json_encode($request), 'A reason is a code, never the provider\'s text.');
    }

    public function testAWriteThatNeverReachedTheProviderLeavesTheMeetingUnreachable(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $operations = $this->claim();
        $this->connection()->executeStatement('UPDATE calendar_operation SET attempts = 6');

        $this->report($operations[0]['id'], ['outcome' => 'retry', 'error' => 'Google could not be reached.']);

        self::assertSame(['status' => 'failed'], $this->decodedResponse());
        $request = $this->conferenceRequest($eventId);
        self::assertSame(['failed', 'unreachable'], [$request['status'] ?? null, $request['reason'] ?? null]);
    }

    public function testAnEditThatEchoesAFailedRequestAsksAgain(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $first = $this->nonce($eventId);
        $operations = $this->claim();
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => self::providerVersion(self::string($operations[0]['ical']))]]);
        self::assertSame('failed', $this->conferenceRequest($eventId)['status'] ?? null);

        // The client sends the failed request's provider with the edit, as it does while the event has no meeting.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Weekly sync, renamed', 'conferenceProvider' => 'meet']), $this->user);

        self::assertResponseIsSuccessful();
        $request = $this->decodedResponse()['conferenceRequest'];
        self::assertSame(['meet', 'pending', null], \is_array($request) ? [$request['provider'], $request['status'], $request['reason']] : null);
        self::assertNotSame($first, $this->nonce($eventId), 'A new attempt, with a new nonce.');
        self::assertStringContainsString('X-TRESSO-CONFERENCE-NONCE:'.$this->nonce($eventId)."\r\n", self::string($this->claim()[0]['ical']));
    }

    public function testAnEditThatEchoesAPendingRequestChangesNothingAboutIt(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $before = $this->conferenceRequest($eventId);
        $nonce = $this->nonce($eventId);
        $operations = $this->claim();
        // Google's version came back without the meeting yet, and without Tresso's request properties.
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'conferenceStatus' => 'pending', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => self::providerVersion(self::string($operations[0]['ical']))]]);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Weekly sync, renamed', 'conferenceProvider' => 'meet']), $this->user);

        self::assertResponseIsSuccessful();
        self::assertSame($before, $this->decodedResponse()['conferenceRequest'], 'No second request, the same requestedAt.');
        self::assertSame($nonce, $this->nonce($eventId));
        self::assertStringContainsString('X-TRESSO-CONFERENCE-NONCE:'.$nonce."\r\n", self::string($this->claim()[0]['ical']), 'The write asks for the same meeting, which Google does not make twice.');
    }

    public function testEditingOneOccurrenceLeavesTheSeriesRequestAlone(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($primary, ['recurrence' => 'FREQ=DAILY;COUNT=3', 'conferenceProvider' => 'meet']), $this->user);
        self::assertResponseStatusCodeSame(201);
        $eventId = $this->responseString('id');
        $before = $this->conferenceRequest($eventId);
        $nonce = $this->nonce($eventId);
        $second = array_values(array_filter($this->occurrences($this->user, '2026-10-20T00:00:00+00:00', '2026-10-21T00:00:00+00:00'), static fn (array $occurrence): bool => $occurrence['eventId'] === $eventId))[0] ?? null;
        self::assertIsArray($second);

        // One occurrence moves; its client sends no provider, as an occurrence carries no request.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId.'?scope=this&recurrenceId='.self::string($second['recurrenceId']), self::event($primary, [
            'start' => ['dateTime' => '2026-10-20T10:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-20T10:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->user);

        self::assertResponseIsSuccessful();
        self::assertNull($this->decodedResponse()['conferenceRequest'], 'The override shows none,');
        self::assertSame($before, $this->conferenceRequest($eventId), 'the series keeps its request,');
        self::assertSame($nonce, $this->nonce($eventId));
        self::assertStringContainsString('X-TRESSO-CONFERENCE-NONCE:'.$nonce."\r\n", self::string($this->claim()[0]['ical']), 'and the write still asks for the meeting.');
    }

    public function testAGuestsEditLeavesTheDescriptionAsItIs(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'review', '"1"', implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:review@google.com', 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T093000', 'SUMMARY:Review',
            'DESCRIPTION:Agenda\\nJoin the meeting: https://room.example.org/lisa\\nNotes below',
            'ORGANIZER:mailto:lisa@example.org', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:lisa@example.org',
            'ATTENDEE;PARTSTAT=ACCEPTED:mailto:kim@gmail.example', 'END:VEVENT', 'END:VCALENDAR', '',
        ]));
        $event = $this->getJson('/api/v1/calendar-events/'.self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']), $this->user);
        $description = $event['description'];
        self::assertSame("Agenda\nJoin the meeting: https://room.example.org/lisa\nNotes below", $description);

        // Kim changes only her reminders, sending what she got back.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.self::string($event['id']), self::event($primary, [
            'summary' => 'Review',
            'start' => ['dateTime' => '2026-10-19T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-19T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
            'description' => $description,
            'conferenceUrl' => 'https://room.example.org/lisa',
            'attendees' => [['address' => 'lisa@example.org'], ['address' => 'kim@gmail.example']],
            'useDefaultReminders' => false,
            'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]],
        ]), $this->user);

        self::assertResponseIsSuccessful();
        self::assertSame($description, $this->decodedResponse()['description'], 'Lisa\'s description is hers: Google refuses a guest\'s change to it.');
    }

    public function testAMeetingStillPendingAfterFiveMinutesFailsWithTheNextSync(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $operations = $this->claim();
        $ical = self::string($operations[0]['ical']);
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'conferenceStatus' => 'pending', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => self::providerVersion($ical)]]);

        $this->storeObject($primary, 'trabc', 'e2', self::providerVersion($ical));
        self::assertSame('pending', $this->conferenceRequest($eventId)['status'] ?? null, 'A young request waits.');

        self::mockTime(new \DateTimeImmutable('+6 minutes'));

        $this->storeObject($primary, 'trabc', 'e3', self::providerVersion($ical));

        $request = $this->conferenceRequest($eventId);
        self::assertSame(['failed', 'refused'], [$request['status'] ?? null, $request['reason'] ?? null]);
    }

    public function testAResultWhileANewerWriteWaitsLeavesTheRequestToThatWrite(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $first = $this->claim();
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Weekly sync, renamed', 'conferenceProvider' => 'meet']), $this->user);
        self::assertResponseIsSuccessful();

        $this->report($first[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => self::providerVersion(self::string($first[0]['ical']))]]);
        self::assertSame('pending', $this->conferenceRequest($eventId)['status'] ?? null, 'The rename still asks for the meeting.');

        $second = $this->claim();
        self::assertCount(1, $second);
        $this->report($second[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e2', 'current' => ['remoteId' => 'trabc', 'etag' => 'e2', 'ical' => self::providerVersion(self::string($second[0]['ical']))]]);
        $request = $this->conferenceRequest($eventId);
        self::assertSame(['failed', 'refused'], [$request['status'] ?? null, $request['reason'] ?? null], 'The waiting write settles it.');
    }

    public function testARetryWithAttemptsLeftKeepsTheMeetingPending(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $operations = $this->claim();

        $this->report($operations[0]['id'], ['outcome' => 'retry', 'error' => 'Google could not be reached.']);

        self::assertSame('pending', $this->conferenceRequest($eventId)['status'] ?? null);
    }

    public function testRetryAsksAgainWithANewNonceAndLeavingDropsTheRequest(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $first = $this->nonce($eventId);
        $operations = $this->claim();
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => self::providerVersion(self::string($operations[0]['ical']))]]);
        self::assertSame('failed', $this->conferenceRequest($eventId)['status'] ?? null);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/meeting-link', ['provider' => 'meet'], $this->user);
        self::assertResponseStatusCodeSame(200);
        $answer = $this->decodedResponse();
        self::assertSame($eventId, $answer['id']);
        self::assertSame('pending', \is_array($answer['conferenceRequest']) ? $answer['conferenceRequest']['status'] : null);
        $second = $this->nonce($eventId);
        self::assertNotSame($first, $second, 'A new request, so Google makes a new meeting.');
        $retry = $this->claim();
        self::assertCount(1, $retry);
        self::assertStringContainsString('X-TRESSO-CONFERENCE-NONCE:'.$second."\r\n", self::string($retry[0]['ical']));

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/meeting-link', ['provider' => 'meet'], $this->user);
        self::assertResponseStatusCodeSame(200);
        self::assertSame($second, $this->nonce($eventId), 'Pressing Retry again while it is on its way changes nothing,');
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM calendar_operation'), 'and queues no other write.');

        self::mockTime(new \DateTimeImmutable('+3 minutes'));
        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/meeting-link', ['provider' => 'meet'], $this->user);
        self::assertResponseStatusCodeSame(200);
        self::assertNotSame($second, $this->nonce($eventId), 'A request that did not come back in time is asked again.');
        self::assertSame(2, $this->countRows('SELECT COUNT(*) FROM calendar_operation'));

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link?notify=false', server: $this->user);
        self::assertResponseStatusCodeSame(200);
        $answer = $this->decodedResponse();
        self::assertSame($eventId, $answer['id']);
        self::assertNull($answer['conferenceRequest']);
        self::assertNull($answer['conference']);
        $object = $this->connection()->fetchAssociative('SELECT ical, conference_request FROM calendar_object WHERE uid = ?', [$answer['uid']]);
        self::assertIsArray($object);
        self::assertNull($object['conference_request']);
        self::assertStringNotContainsString('X-TRESSO-CONFERENCE', self::string($object['ical']), 'The waiting write no longer asks for a meeting.');
        self::assertSame(2, $this->countRows('SELECT COUNT(*) FROM calendar_operation'), 'It goes with the write that waits.');

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link', server: $this->user);
        self::assertResponseStatusCodeSame(200, 'Dropping nothing is no error.');
        self::assertNull($this->decodedResponse()['conferenceRequest']);
    }

    public function testLeavingWithoutALinkDropsAFailedRequestWithoutAWrite(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $operations = $this->claim();
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => self::providerVersion(self::string($operations[0]['ical']))]]);
        self::assertSame('failed', $this->conferenceRequest($eventId)['status'] ?? null);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link', server: $this->user);

        self::assertResponseStatusCodeSame(200);
        self::assertNull($this->decodedResponse()['conferenceRequest']);
        self::assertNull($this->conferenceRequest($eventId));
        self::assertSame([], $this->claim(), 'The event at Google has no request to take back.');
    }

    public function testRemovingAGoogleMeetLinkTakesEveryTraceOfIt(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'review', '"1"', implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:review@google.com', 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T093000', 'SUMMARY:Review',
            'CONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL=Google Meet:https://meet.google.com/abc-defg-hij', 'CONFERENCE;VALUE=URI;FEATURE=PHONE:tel:+31-20-123-4567',
            'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', 'END:VEVENT', 'END:VCALENDAR', '',
        ]));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link', server: $this->user);

        self::assertResponseStatusCodeSame(200);
        self::assertNull($this->decodedResponse()['conference']);
        $operations = $this->claim();
        self::assertCount(1, $operations);
        $ical = self::string($operations[0]['ical']);
        self::assertStringNotContainsString('X-GOOGLE-CONFERENCE', $ical);
        self::assertStringNotContainsString("\r\nCONFERENCE", $ical, 'The video link and the dial-in go.');
        self::assertStringNotContainsString('meet.google.com', $ical);
        self::assertStringContainsString("\r\nX-TRESSO-CONFERENCE-REMOVE:meet\r\n", $ical, 'The worker removes Google\'s meeting on this word only.');

        // Asking for Meet again takes the word back: Google is to make a new meeting, not to remove one.
        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/meeting-link', ['provider' => 'meet'], $this->user);
        self::assertResponseStatusCodeSame(200);
        $stored = self::string($this->connection()->fetchOne('SELECT ical FROM calendar_object WHERE remote_id = ?', ['review']));
        self::assertStringNotContainsString('X-TRESSO-CONFERENCE-REMOVE', $stored);
        self::assertStringContainsString('X-TRESSO-CONFERENCE-REQUEST:meet', $stored);
    }

    public function testAnEditWithoutTheMeetingLinkNeverMarksGooglesMeetingForRemoval(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'review', '"1"', implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:review@google.com', 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T093000', 'SUMMARY:Review',
            'CONFERENCE;VALUE=URI;FEATURE=PHONE:tel:+31-20-123-4567', 'END:VEVENT', 'END:VCALENDAR', '',
        ]));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Review, renamed']), $this->user);

        self::assertResponseIsSuccessful();
        self::assertStringNotContainsString('X-TRESSO-CONFERENCE-REMOVE', self::string($this->claim()[0]['ical']), 'A Meet with only a phone entry is no reason to remove anything.');
    }

    public function testRemovingMeetFromOneOccurrenceNeverMarksGooglesMeeting(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'standup', '"1"', self::meetSeries());
        $occurrence = $this->occurrences($this->user, '2026-10-20T00:00:00+00:00', '2026-10-21T00:00:00+00:00')[0];

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.self::string($occurrence['eventId']).'?scope=this&recurrenceId='.self::string($occurrence['recurrenceId']), self::event($primary, [
            'summary' => 'Standup',
            'start' => ['dateTime' => '2026-10-20T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-20T09:15:00', 'timeZone' => 'Europe/Amsterdam'],
            'conferenceUrl' => null,
        ]), $this->user);

        self::assertResponseIsSuccessful();
        self::assertNull($this->decodedResponse()['conference'], 'The occurrence has no link,');
        $ical = self::string($this->claim()[0]['ical']);
        self::assertStringNotContainsString('X-TRESSO-CONFERENCE-REMOVE', $ical, 'but Google\'s meeting of the series is not to be removed.');
        self::assertStringContainsString('X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', $ical);
    }

    public function testRemovingMeetLeavesTheSameLinkInTheText(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'review', '"1"', implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:review@google.com', 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T093000', 'SUMMARY:Review',
            'DESCRIPTION:Meet here: https://meet.google.com/abc-defg-hij',
            'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', 'END:VEVENT', 'END:VCALENDAR', '',
        ]));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link', server: $this->user);

        self::assertResponseStatusCodeSame(200, 'Google\'s meeting goes; the user\'s text stays as written.');
        self::assertSame('Meet here: https://meet.google.com/abc-defg-hij', $this->decodedResponse()['description']);
        $ical = self::string($this->claim()[0]['ical']);
        self::assertStringContainsString("\r\nX-TRESSO-CONFERENCE-REMOVE:meet\r\n", $ical);
        self::assertStringNotContainsString('X-GOOGLE-CONFERENCE', $ical);
    }

    public function testMovingAwayFromGoogleLeavesTheRemovalWordBehind(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'review', '"1"', implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:review@google.com', 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T093000', 'SUMMARY:Review',
            'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', 'END:VEVENT', 'END:VCALENDAR', '',
        ]));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);
        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link', server: $this->user);
        self::assertResponseStatusCodeSame(200);
        self::assertStringContainsString('X-TRESSO-CONFERENCE-REMOVE', self::string($this->connection()->fetchOne('SELECT ical FROM calendar_object WHERE remote_id = ?', ['review'])));

        $local = $this->localCalendarId($this->user);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($local, [
            'summary' => 'Review',
            'start' => ['dateTime' => '2026-10-19T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-19T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->user);

        self::assertResponseIsSuccessful();
        $moved = $this->connection()->fetchOne('SELECT o.ical FROM calendar_object o WHERE o.calendar_id = ? AND o.uid = ?', [$local, 'review@google.com']);
        self::assertStringNotContainsString('X-TRESSO-CONFERENCE', self::string($moved), 'A Tresso calendar has no Google meeting to remove.');
    }

    public function testATeamsMeetingMicrosoftMadeCannotBeRemoved(): void
    {
        [$accountId, $calendarId] = $this->connectMicrosoft();
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$accountId.'/calendars/'.$calendarId.'/objects', ['workerId' => 'w1', 'changed' => [
            ['remoteId' => 'AAMkEvent1', 'etag' => 'W/"1"', 'ical' => implode("\r\n", [
                'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:standup@contoso.example', 'DTSTAMP:20261018T080000Z',
                'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T093000', 'SUMMARY:Standup',
                'CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc',
                'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc', 'END:VEVENT', 'END:VCALENDAR', '',
            ])],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $conference = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->user)['conference'];
        self::assertFalse(\is_array($conference) ? $conference['removable'] : null, 'Clients learn it cannot be removed,');
        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->user)['calendarEvents'] ?? null;
        self::assertIsArray($delta);
        self::assertSame([false], array_map(static fn (mixed $event): mixed => \is_array($event) && \is_array($event['conference']) ? $event['conference']['removable'] : null, $delta), 'also through the delta.');

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link', server: $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('Microsoft keeps a Teams meeting on its event. Delete the event to cancel the meeting.', (string) $this->client->getResponse()->getContent());

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($calendarId, ['summary' => 'Standup', 'conferenceUrl' => 'https://meet.company.example/kim']), $this->user);
        self::assertResponseStatusCodeSame(422, 'Nor replaced by another link.');
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($calendarId, ['summary' => 'Standup, renamed', 'conferenceUrl' => 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc']), $this->user);
        self::assertResponseIsSuccessful('Kept as it is, the event changes as before.');
    }

    public function testAnOwnLinkOnAGoogleCalendarSurvivesGooglesVersion(): void
    {
        $room = 'https://meet.company.example/kim';
        $primary = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($primary, ['description' => 'Agenda', 'conferenceUrl' => $room]), $this->user);
        self::assertResponseStatusCodeSame(201);
        $event = $this->decodedResponse();
        $eventId = self::string($event['id']);
        self::assertSame("Agenda\n\nJoin the meeting: ".$room, $event['description']);
        self::assertSame(['provider' => 'other', 'url' => $room, 'id' => null, 'dialIn' => null, 'removable' => true], $event['conference']);
        self::assertNull($event['conferenceRequest']);

        // Google's version: the same description, and no CONFERENCE (Google takes none from an API client).
        $operations = $this->claim();
        $ical = self::string($operations[0]['ical']);
        self::assertStringContainsString('CONFERENCE;VALUE=URI;FEATURE=VIDEO:'.$room, $ical);
        $current = (string) preg_replace('/^CONFERENCE[^\r\n]*\r\n/m', '', $ical);
        self::assertStringNotContainsString("\r\nCONFERENCE", $current);
        $this->report($operations[0]['id'], ['outcome' => 'done', 'remoteId' => 'trabc', 'etag' => 'e1', 'current' => ['remoteId' => 'trabc', 'etag' => 'e1', 'ical' => $current]]);

        $event = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->user);
        self::assertSame(['provider' => 'other', 'url' => $room, 'id' => null, 'dialIn' => null, 'removable' => true], $event['conference'], 'The join line carries the link.');

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($primary, ['summary' => 'Weekly sync, again', 'description' => $event['description'], 'conferenceUrl' => $room]), $this->user);
        self::assertResponseIsSuccessful();
        $saved = $this->decodedResponse();
        self::assertSame("Agenda\n\nJoin the meeting: ".$room, $saved['description'], 'Exactly one line.');
        self::assertSame($room, \is_array($saved['conference']) ? $saved['conference']['url'] : null);
    }

    public function testOnlyTheOrganizerChangesTheMeetingLink(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->storeObject($primary, 'review', '"1"', implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:review@google.com', 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T093000', 'SUMMARY:Review',
            'ORGANIZER:mailto:lisa@example.org', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:lisa@example.org',
            'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:kim@gmail.example', 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', 'END:VEVENT', 'END:VCALENDAR', '',
        ]));
        $eventId = self::string($this->occurrences($this->user, '2026-10-19T00:00:00+00:00', '2026-10-20T00:00:00+00:00')[0]['eventId']);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/meeting-link', ['provider' => 'meet'], $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('Only the organizer can change the meeting link.', (string) $this->client->getResponse()->getContent());
        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link', server: $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertSame([], $this->claim());
    }

    public function testTheMeetingLinkOfAnotherUsersEventIsOutOfReach(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $this->createUser('lisa@example.test', 'Lisa');
        $lisa = $this->userHeaders('lisa@example.test', ['calendar:read', 'calendar:write']);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/meeting-link', ['provider' => 'meet'], $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link', server: $lisa);
        self::assertResponseStatusCodeSame(404);

        self::assertSame('pending', $this->conferenceRequest($eventId)['status'] ?? null);
    }

    public function testChangingTheMeetingLinkNeedsCalendarWrite(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $eventId = $this->createWithMeet($primary);
        $readOnly = $this->userHeaders('kim@example.test', ['calendar:read']);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/meeting-link', ['provider' => 'meet'], $readOnly);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId.'/meeting-link', server: $readOnly);
        self::assertResponseStatusCodeSame(403);
    }

    public function testAMeetingLinkNeedsAnAppTheCalendarOffers(): void
    {
        $primary = $this->reportCalendars()[0]['id'];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($primary), $this->user);
        $eventId = $this->responseString('id');

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/meeting-link', ['provider' => 'teams'], $this->user);
        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('This calendar cannot make Microsoft Teams meetings.', (string) $this->client->getResponse()->getContent());
        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/meeting-link', ['provider' => 'zoom'], $this->user);
        self::assertResponseStatusCodeSame(422);
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

    private function createWithMeet(string $calendarId): string
    {
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, ['conferenceProvider' => 'meet']), $this->user);
        self::assertResponseStatusCodeSame(201);

        return $this->responseString('id');
    }

    /**
     * The event's request as clients see it.
     *
     * @return array<mixed>|null
     */
    private function conferenceRequest(string $eventId): ?array
    {
        $request = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->user)['conferenceRequest'] ?? null;
        self::assertTrue(null === $request || \is_array($request));

        return $request;
    }

    /** The nonce of the event's request, as the API keeps it. */
    private function nonce(string $eventId): string
    {
        $stored = $this->connection()->fetchOne('SELECT o.conference_request FROM calendar_object o JOIN calendar_event e ON e.object_id = o.id WHERE e.id = ?', [$eventId]);
        $request = json_decode(self::string($stored), true, flags: \JSON_THROW_ON_ERROR);
        self::assertIsArray($request);

        return self::string($request['nonce'] ?? null);
    }

    /** A daily series of three at 09:00 with the Meet meeting Google made for it. */
    private static function meetSeries(): string
    {
        return implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tresso//Calendar sync//EN', 'BEGIN:VEVENT', 'UID:standup@google.com', 'DTSTAMP:20261018T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20261019T090000', 'DTEND;TZID=Europe/Amsterdam:20261019T091500', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Standup',
            'CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://meet.google.com/abc-defg-hij',
            'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', 'END:VEVENT', 'END:VCALENDAR', '',
        ]);
    }

    /**
     * What the provider gives back for a write: Tresso's version without its request, and with what the provider adds.
     */
    private static function providerVersion(string $ical, string $added = ''): string
    {
        $version = (string) preg_replace('/^X-TRESSO-CONFERENCE-[A-Z]+:[^\r\n]*\r\n/m', '', $ical);

        return '' === $added ? $version : str_replace("END:VEVENT\r\n", $added."\r\nEND:VEVENT\r\n", $version);
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
