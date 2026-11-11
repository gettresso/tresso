<?php

declare(strict_types=1);

namespace App\Tests\Functional\Calendar;

use App\Entity\Calendar;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\ConnectsThirdPartyApps;
use App\Tests\Functional\DatabaseTestCase;
use App\Tests\Functional\StoresMail;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\Attributes\DataProvider;

final class CalendarInvitationTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use ConnectsThirdPartyApps;
    use StoresMail;
    use CalendarTestHelpers;

    /** @var array<string, string> */
    private array $kim;

    /** @var array<string, string> */
    private array $worker;

    private string $accountId;

    private int $uid = 0;

    private string $organizedUid = '';

    /** @var list<array{method: null, ical: string}> the calendar parts of the last message received */
    private array $lastParts = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'mail:send', 'calendar:read', 'calendar:write', 'settings:write']);

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
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/folders', ['workerId' => 'w1', 'folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1],
            ['remoteName' => 'Junk', 'displayName' => 'Junk', 'role' => 'spam', 'uidValidity' => 1],
            ['remoteName' => 'Archive', 'displayName' => 'Archive', 'role' => 'archive', 'uidValidity' => 1],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
    }

    public function testAnInvitationLandsInTheCalendarUnanswered(): void
    {
        $messageId = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));

        $occurrences = $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00');
        self::assertCount(1, $occurrences);
        self::assertSame('Budget review', $occurrences[0]['summary']);
        self::assertSame(['dateTime' => '2026-10-21T12:00:00+00:00'], $occurrences[0]['start'], 'The Windows zone name is read as Central European time.');
        self::assertSame('needs-action', $occurrences[0]['selfResponse']);

        $invitation = $this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim);
        self::assertSame('REQUEST', $invitation['method']);
        self::assertSame('new', $invitation['kind']);
        self::assertSame(['address' => 'anna@finance.example', 'name' => 'Anna de Vries'], $invitation['organizer']);
        self::assertSame($occurrences[0]['eventId'], $invitation['eventId']);
        self::assertTrue($invitation['canRespond']);

        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['messages']);
        self::assertSame(['REQUEST'], array_column($delta['messages'], 'calendarMethod'));
        self::assertIsArray($delta['calendarEvents']);
        self::assertSame([$messageId], array_column($delta['calendarEvents'], 'messageId'));
    }

    /**
     * @return iterable<string, array{?string, string, bool}>
     */
    public static function calendarPartsThatCannotBeRecorded(): iterable
    {
        $valid = self::invitation('REQUEST', 0, '20261021T140000');
        yield 'a Content-Type method longer than any iTIP method' => [str_repeat('REQUEST', 10), str_replace("METHOD:REQUEST\r\n", '', $valid), false];
        yield 'a UID longer than the column' => [null, str_replace('UID:budget-review@finance.example', 'UID:'.str_repeat('x', 1025), $valid), false];
        // Recorded, with the largest SEQUENCE the column holds (another event, so it does not outdate the second message).
        yield 'a SEQUENCE larger than the column' => [null, str_replace(['SEQUENCE:0', 'UID:budget-review@'], ['SEQUENCE:3000000000', 'UID:crafted@'], $valid), true];
        yield 'a RECURRENCE-ID that is not a date' => [null, str_replace('SEQUENCE:0', "SEQUENCE:0\r\nRECURRENCE-ID:garbage", $valid), false];
    }

    /**
     * A calendar part the API cannot record never refuses its message: the worker would send the same batch again
     * forever, and no later mail of the folder would arrive.
     */
    #[DataProvider('calendarPartsThatCannotBeRecorded')]
    public function testACalendarPartThatCannotBeRecordedNeverStopsTheBatch(?string $partMethod, string $ical, bool $recorded): void
    {
        $messages = [];
        foreach ([['Crafted', $partMethod, $ical], ['Invitation: Budget review', null, self::invitation('REQUEST', 0, '20261021T140000')]] as [$subject, $method, $part]) {
            ++$this->uid;
            $messages[] = [
                'remoteUid' => (string) $this->uid,
                'rawObjectKey' => $this->rawKeyFor($this->accountId, $subject.$this->uid),
                'keyVersion' => 1,
                'size' => 100,
                'receivedAt' => new \DateTimeImmutable('+1 minute')->format(\DATE_ATOM),
                'messageId' => '<invite-'.$this->uid.'@finance.example>',
                'subject' => $subject,
                'from' => ['address' => 'anna@finance.example', 'name' => null],
                'to' => [['address' => 'kim@company.example']],
                'calendarParts' => [['method' => $method, 'ical' => $part]],
            ];
        }
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/messages', ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => $messages], $this->worker);
        self::assertResponseIsSuccessful();
        $this->applyQueuedInvitations();

        $crafted = $this->messageId('Crafted');
        $invited = $this->messageId('Invitation: Budget review');
        $sequences = $this->connection()->fetchFirstColumn('SELECT sequence FROM calendar_invitation WHERE message_id = :id', ['id' => $crafted]);
        self::assertSame($recorded ? [2147483647] : [], array_map(intval(...), $sequences));
        self::assertSame(1, (int) $this->connection()->fetchOne('SELECT COUNT(*) FROM calendar_invitation WHERE message_id = :id', ['id' => $invited]));
        self::assertCount($recorded ? 2 : 1, $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00'));
    }

    public function testAcceptingRepliesToTheOrganizerThroughTheOutbox(): void
    {
        $messageId = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));
        $eventId = $this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim)['eventId'];
        self::assertIsString($eventId);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'accepted', 'comment' => 'See you there'], $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame('accepted', $this->decodedResponse()['selfResponse']);

        $outgoing = $this->outgoing();
        self::assertCount(1, $outgoing);
        self::assertSame('Accepted: Budget review', $outgoing[0]->getSubject());
        self::assertSame(['anna@finance.example'], $outgoing[0]->getEnvelopeRecipients());
        $raw = quoted_printable_decode($this->rawOutgoing($outgoing[0]));
        self::assertStringContainsString('text/calendar; charset=utf-8; method=REPLY', $raw);
        self::assertStringContainsString('METHOD:REPLY', $raw);
        self::assertMatchesRegularExpression('/ATTENDEE;[^\r\n]*PARTSTAT=ACCEPTED[^\r\n]*:mailto:kim@company\.example/', $raw);
        self::assertDoesNotMatchRegularExpression('/^ATTENDEE[^\r\n]*mailto:anna@finance\.example/m', $raw, 'A reply only carries the replying attendee.');
        self::assertStringContainsString('COMMENT:See you there', $raw);
        self::assertStringContainsString('In-Reply-To: <invite-1@finance.example>', $raw);
    }

    public function testUpdatesMoveTheEventAndOlderOnesAreIgnored(): void
    {
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));
        $this->receive('Updated: Budget review', self::invitation('REQUEST', 2, '20261021T160000'));
        $late = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 1, '20261021T150000'));

        $occurrences = $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00');
        self::assertCount(1, $occurrences);
        self::assertSame(['dateTime' => '2026-10-21T14:00:00+00:00'], $occurrences[0]['start']);
        self::assertSame('outdated', $this->getJson('/api/v1/messages/'.$late.'/invitation', $this->kim)['kind']);
    }

    public function testAnUpdateChangesTheCopyInTheReceivingAccountsCalendar(): void
    {
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));
        // The account's calendar server has the event too, added after Tresso put it in the Tresso calendar.
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/calendars', ['workerId' => 'w1', 'serverUrl' => 'https://caldav.company.example/dav/', 'calendars' => [
            ['remoteId' => 'https://caldav.company.example/dav/kim/home/', 'name' => 'Home', 'isDefault' => true],
        ]], $this->worker);
        $calendars = $this->decodedResponse()['calendars'] ?? null;
        self::assertIsArray($calendars);
        $first = $calendars[0] ?? null;
        self::assertIsArray($first);
        $home = self::string($first['id'] ?? null);
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'changed' => [
            ['remoteId' => 'https://caldav.company.example/dav/kim/home/budget.ics', 'etag' => '"1"', 'ical' => str_replace("METHOD:REQUEST\r\n", '', self::invitation('REQUEST', 0, '20261021T140000'))],
        ]], $this->worker);
        self::assertResponseIsSuccessful();

        $this->receive('Updated: Budget review', self::invitation('REQUEST', 1, '20261021T160000'));

        $starts = [];
        foreach ($this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00') as $occurrence) {
            $starts[$occurrence['calendarId'] === $home ? 'account' : 'tresso'] = $occurrence['start'];
        }
        ksort($starts);
        self::assertSame([
            'account' => ['dateTime' => '2026-10-21T14:00:00+00:00'],
            'tresso' => ['dateTime' => '2026-10-21T12:00:00+00:00'],
        ], $starts, 'The update goes to the calendar of the account the mail came to.');
    }

    public function testSendingInvitationsNeedsMailSend(): void
    {
        $calendarOnly = $this->userHeaders('kim@example.test', ['mail:read', 'calendar:read', 'calendar:write']);
        $calendarId = $this->localCalendarId($this->kim);
        $withGuest = self::event($calendarId, ['summary' => 'Free text', 'attendees' => [['address' => 'anyone@elsewhere.example']], 'organizerMailAccountId' => $this->accountId]);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', $withGuest, $calendarOnly);
        self::assertResponseStatusCodeSame(403);
        self::assertStringContainsString('mail:send', (string) $this->client->getResponse()->getContent());
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM calendar_event'), 'Refused, not saved without telling anyone.');

        $this->client->jsonRequest('POST', '/api/v1/calendar-events?notify=false', $withGuest, $calendarOnly);
        self::assertResponseStatusCodeSame(201, 'Saying not to tell anyone is fine.');
        $quiet = self::string($this->decodedResponse()['id']);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, ['summary' => 'Alone']), $calendarOnly);
        self::assertResponseStatusCodeSame(201, 'Without guests nobody is told.');

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$quiet, self::event($calendarId, ['summary' => 'Changed', 'attendees' => [['address' => 'anyone@elsewhere.example']], 'organizerMailAccountId' => $this->accountId]), $calendarOnly);
        self::assertResponseStatusCodeSame(403, 'Updating an event with guests tells them.');
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$quiet, self::event($calendarId, ['summary' => 'No guests any more']), $calendarOnly);
        self::assertResponseStatusCodeSame(403, 'Removing the guests cancels for them.');
        $this->client->request('DELETE', '/api/v1/calendar-events/'.$quiet, server: $calendarOnly);
        self::assertResponseStatusCodeSame(403, 'Deleting it cancels for them.');
        $this->client->request('DELETE', '/api/v1/calendar-events/'.$quiet.'?notify=false', server: $calendarOnly);
        self::assertResponseStatusCodeSame(204);

        self::assertSame([], $this->outgoing(), 'Nothing went out.');

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', $withGuest, $this->kim);
        self::assertResponseStatusCodeSame(201, 'Our own apps have mail:send.');
        self::assertCount(1, $this->outgoing());
    }

    /**
     * A guest on one occurrence of a series is told when the series changes or goes, so changing or deleting the
     * series needs mail:send too, even though the series itself has no guests.
     *
     * @return iterable<string, array{string, string, array<string, mixed>|null}>
     */
    public static function seriesChangesThatTellAGuestOfOneOccurrence(): iterable
    {
        yield 'deleting the series' => ['DELETE', '', null];
        yield 'deleting this and following' => ['DELETE', '?scope=following&recurrenceId=20261026T080000Z', null];
        yield 'moving the series' => ['PUT', '', ['summary' => 'Weekly', 'recurrence' => 'FREQ=WEEKLY;COUNT=4', 'start' => ['dateTime' => '2026-10-19T11:00:00', 'timeZone' => 'Europe/Amsterdam'], 'end' => ['dateTime' => '2026-10-19T11:30:00', 'timeZone' => 'Europe/Amsterdam']]];
    }

    /**
     * @param array<string, mixed>|null $body
     */
    #[DataProvider('seriesChangesThatTellAGuestOfOneOccurrence')]
    public function testAGuestOnOneOccurrenceCountsForTheWholeSeries(string $method, string $query, ?array $body): void
    {
        $calendarOnly = $this->userHeaders('kim@example.test', ['mail:read', 'calendar:read', 'calendar:write']);
        $calendarId = $this->localCalendarId($this->kim);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, ['summary' => 'Weekly', 'recurrence' => 'FREQ=WEEKLY;COUNT=4']), $calendarOnly);
        self::assertResponseStatusCodeSame(201);
        $seriesId = self::string($this->decodedResponse()['id']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$seriesId.'?scope=this&recurrenceId=20261026T080000Z&notify=false', self::event($calendarId, [
            'summary' => 'Weekly, with Anna',
            'start' => ['dateTime' => '2026-10-26T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
            'attendees' => [['address' => 'anna@finance.example']],
            'organizerMailAccountId' => $this->accountId,
        ]), $calendarOnly);
        self::assertResponseIsSuccessful('Adding a guest without telling her is fine.');

        $uri = '/api/v1/calendar-events/'.$seriesId.$query;
        if (null === $body) {
            $this->client->request($method, $uri, server: $calendarOnly);
        } else {
            $this->client->jsonRequest($method, $uri, self::event($calendarId, $body), $calendarOnly);
        }

        self::assertResponseStatusCodeSame(403);
        self::assertStringContainsString('mail:send', (string) $this->client->getResponse()->getContent());
        self::assertSame([], $this->outgoing(), 'Nothing went out to the guest.');
        self::assertSame(1, $this->countRows("SELECT COUNT(*) FROM calendar_event WHERE summary = 'Weekly, with Anna'"), 'The change was rolled back.');
    }

    public function testAnsweringOrApplyingAnInvitationNeedsMailSend(): void
    {
        $calendarOnly = $this->userHeaders('kim@example.test', ['mail:read', 'calendar:read', 'calendar:write']);
        $messageId = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));
        $eventId = self::string($this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim)['eventId']);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'accepted'], $calendarOnly);
        self::assertResponseStatusCodeSame(403);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'accepted', 'notify' => false], $calendarOnly);
        self::assertResponseIsSuccessful('Answering without telling the organizer is fine.');
        self::assertSame([], $this->outgoing());

        $archived = $this->receive('Updated: Budget review', self::invitation('REQUEST', 1, '20261021T160000'), folder: 'Archive');
        $this->client->request('POST', '/api/v1/messages/'.$archived.'/invitation/apply', server: $calendarOnly);
        self::assertResponseStatusCodeSame(403);
        $this->client->request('POST', '/api/v1/messages/'.$archived.'/invitation/apply', server: $this->kim);
        self::assertResponseIsSuccessful();
    }

    public function testAnAppThatIsNotOursNeedsMailSendToInvite(): void
    {
        $app = $this->thirdPartyHeaders('kim@example.test', ['calendar:read', 'calendar:write']);
        $pat = $this->personalAccessTokenHeaders('kim@example.test', ['calendar:read', 'calendar:write']);
        $withGuest = self::event($this->localCalendarId($this->kim), ['attendees' => [['address' => 'anyone@elsewhere.example']], 'organizerMailAccountId' => $this->accountId]);

        foreach (['third-party app' => $app, 'personal access token' => $pat] as $caller => $headers) {
            $this->client->jsonRequest('POST', '/api/v1/calendar-events', $withGuest, $headers);
            self::assertResponseStatusCodeSame(403, $caller);
        }
        self::assertSame([], $this->outgoing());
    }

    public function testCancellationsCancelTheEvent(): void
    {
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));
        $cancel = $this->receive('Cancelled: Budget review', self::invitation('CANCEL', 1, '20261021T140000'));

        $occurrences = $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00');
        self::assertSame('cancelled', $occurrences[0]['status']);
        self::assertSame('cancelled', $this->getJson('/api/v1/messages/'.$cancel.'/invitation', $this->kim)['kind']);
    }

    public function testIgnoresInvitationsAddressedToOthers(): void
    {
        $this->receive('Invitation: Budget review', str_replace('mailto:kim@company.example', 'mailto:pieter@company.example', self::invitation('REQUEST', 0, '20261021T140000')));

        self::assertSame([], $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00'));
    }

    public function testOrganizingInvitesAttendeesAndTheirRepliesAreRecorded(): void
    {
        $calendarId = $this->localCalendarId($this->kim);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, [
            'summary' => 'Planning',
            'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']],
            'organizerMailAccountId' => $this->accountId,
        ]), $this->kim);
        self::assertResponseStatusCodeSame(201);
        $event = $this->decodedResponse();
        self::assertSame(['address' => 'kim@company.example', 'name' => 'Kim Visser'], $event['organizer']);
        self::assertNull($event['selfResponse']);

        $outgoing = $this->outgoing();
        self::assertCount(1, $outgoing);
        self::assertSame('Invitation: Planning', $outgoing[0]->getSubject());
        $raw = quoted_printable_decode($this->rawOutgoing($outgoing[0]));
        self::assertStringContainsString('method=REQUEST', $raw);
        self::assertStringContainsString('BEGIN:VTIMEZONE', $raw);
        self::assertStringContainsString('TZID:Europe/Amsterdam', $raw);

        $uid = self::string($event['uid']);
        $eventId = self::string($event['id']);
        $this->receive('Tentative: Planning', implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN', 'METHOD:REPLY', 'BEGIN:VEVENT',
            'UID:'.$uid, 'SEQUENCE:0', 'DTSTAMP:20261019T090000Z', 'DTSTART;TZID=Europe/Amsterdam:20261019T090000',
            'ORGANIZER:mailto:kim@company.example', 'ATTENDEE;PARTSTAT=TENTATIVE:mailto:anna@finance.example',
            'END:VEVENT', 'END:VCALENDAR', '',
        ]));

        $attendees = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->kim)['attendees'];
        self::assertIsArray($attendees);
        self::assertSame(['tentative'], array_column($attendees, 'partstat'));

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$eventId, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $outgoing = $this->outgoing();
        self::assertCount(2, $outgoing);
        self::assertSame('Cancelled: Planning', $outgoing[1]->getSubject());
        self::assertStringContainsString('Content-Type: text/calendar; charset=utf-8; method=CANCEL', $this->rawOutgoing($outgoing[1]));
    }

    public function testANewInvitationCountsOnlyFromItsOrganizer(): void
    {
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'), 'mallory@attacker.test');
        self::assertSame([], $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00'));

        // Naming yourself the organizer's delegate in your own message proves nothing.
        $this->receive('Invitation: Budget review', self::delegatedTo('mallory@attacker.test', self::invitation('REQUEST', 0, '20261021T140000')), 'mallory@attacker.test');
        self::assertCount(0, $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00'));
    }

    public function testADelegateNamedOnlyInTheMessageCannotChangeTheEvent(): void
    {
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));

        $this->receive('Cancelled: Budget review', self::delegatedTo('mallory@attacker.test', self::invitation('CANCEL', 1, '20261021T140000')), 'mallory@attacker.test');
        $this->receive('Updated: Budget review', str_replace('LOCATION:Room 3', 'LOCATION:https://evil.example/join', self::delegatedTo('mallory@attacker.test', self::invitation('REQUEST', 1, '20261021T180000'))), 'mallory@attacker.test');

        $occurrence = $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00')[0];
        self::assertSame('confirmed', $occurrence['status']);
        self::assertSame('Room 3', $occurrence['location']);
        self::assertSame(['dateTime' => '2026-10-21T12:00:00+00:00'], $occurrence['start']);
    }

    public function testADelegateTheStoredEventNamesMaySendUpdates(): void
    {
        // The organizer's own invitation names her assistant.
        $this->receive('Invitation: Budget review', self::delegatedTo('assistant@finance.example', self::invitation('REQUEST', 0, '20261021T140000')));

        $this->receive('Updated: Budget review', self::delegatedTo('assistant@finance.example', self::invitation('REQUEST', 1, '20261021T160000')), 'assistant@finance.example');

        self::assertSame(['dateTime' => '2026-10-21T14:00:00+00:00'], $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00')[0]['start']);
    }

    public function testAnUpdateAtTheSameSequenceNeedsALaterStampAndKeepsTheAnswer(): void
    {
        $messageId = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));
        $eventId = self::string($this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim)['eventId']);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'accepted', 'notify' => false], $this->kim);
        self::assertResponseIsSuccessful();

        // A minor change: same SEQUENCE, later DTSTAMP, the user's NEEDS-ACTION from the organizer's copy.
        $this->receive('Updated: Budget review', str_replace(['LOCATION:Room 3', 'DTSTAMP:20261019T080000Z'], ['LOCATION:Room 5', 'DTSTAMP:20261019T090000Z'], self::invitation('REQUEST', 0, '20261021T140000')));
        // The same version again, from before the change.
        $this->receive('Updated: Budget review', str_replace('LOCATION:Room 3', 'LOCATION:Room 9', self::invitation('REQUEST', 0, '20261021T140000')));

        $event = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->kim);
        self::assertSame('Room 5', $event['location']);
        self::assertSame('accepted', $event['selfResponse'], 'A change at the same SEQUENCE does not ask again.');
    }

    public function testOccurrencesInvitedWithoutTheirSeriesAreKeptTogether(): void
    {
        $instance = static fn (string $recurrenceId, string $start): string => str_replace(
            "BEGIN:VEVENT\r\n",
            "BEGIN:VEVENT\r\nRECURRENCE-ID;TZID=W. Europe Standard Time:{$recurrenceId}\r\n",
            self::invitation('REQUEST', 0, $start),
        );

        $this->receive('Invitation: Budget review', $instance('20261021T140000', '20261021T140000'));
        $this->receive('Invitation: Budget review', $instance('20261028T140000', '20261028T140000'));

        self::assertCount(1, $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00'), 'The first stays.');
        self::assertCount(1, $this->occurrences($this->kim, '2026-10-28T00:00:00+00:00', '2026-10-29T00:00:00+00:00'));
    }

    public function testCancellingOccurrencesComparesEachAndSkipsUnknownOnes(): void
    {
        $series = str_replace('SUMMARY:Budget review', "RRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Budget review", self::invitation('REQUEST', 0, '20261021T140000'));
        $this->receive('Invitation: Budget review', $series);
        // The organizer moved the 22nd, raising its SEQUENCE.
        $this->receive('Updated: Budget review', str_replace("BEGIN:VEVENT\r\n", "BEGIN:VEVENT\r\nRECURRENCE-ID;TZID=W. Europe Standard Time:20261022T140000\r\n", self::invitation('REQUEST', 3, '20261022T150000')));

        $cancel = static fn (string $recurrenceId): string => "BEGIN:VEVENT\r\nUID:budget-review@finance.example\r\nSEQUENCE:1\r\nDTSTAMP:20261019T100000Z\r\nRECURRENCE-ID;TZID=W. Europe Standard Time:{$recurrenceId}\r\nDTSTART;TZID=W. Europe Standard Time:{$recurrenceId}\r\nORGANIZER;CN=Anna de Vries:mailto:anna@finance.example\r\nATTENDEE:mailto:kim@company.example\r\nEND:VEVENT\r\n";
        $this->receive('Cancelled: Budget review', "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nMETHOD:CANCEL\r\n".$cancel('20261021T153000').$cancel('20261023T140000')."END:VCALENDAR\r\n");

        $statuses = array_column($this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-24T00:00:00+00:00'), 'status');
        self::assertSame(['confirmed', 'confirmed', 'cancelled'], $statuses, 'The 23rd is cancelled although the 21st at 15:30 is no occurrence and the 22nd has a higher SEQUENCE.');
    }

    public function testAReplyInOtherLetterCaseAnswersForTheSameGuest(): void
    {
        $eventId = $this->organize();
        $this->receive('Accepted: Planning', $this->replyFrom('ANNA@Finance.Example', 'ACCEPTED'), 'anna@finance.example');

        $attendees = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->kim)['attendees'];
        self::assertIsArray($attendees);
        self::assertSame(['accepted'], array_column($attendees, 'partstat'), 'No second Anna.');
    }

    public function testAReplyWithoutAnAnswerIsIgnoredOnce(): void
    {
        $eventId = $this->organize();
        $messageId = $this->receive('Re: Planning', str_replace(';PARTSTAT=ACCEPTED', '', $this->replyFrom('anna@finance.example', 'ACCEPTED')));

        self::assertFalse($this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim)['canApply'], 'Ignored and done, not failing on every retry.');
        $attendees = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->kim)['attendees'];
        self::assertIsArray($attendees);
        self::assertSame(['needs-action'], array_column($attendees, 'partstat'));
    }

    public function testApplyingLocksTheInvitationAndTheEvent(): void
    {
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));
        $holder = static::getContainer()->get('doctrine.debug_data_holder');
        self::assertInstanceOf(\Symfony\Bridge\Doctrine\Middleware\Debug\DebugDataHolder::class, $holder);
        $this->deliver('Updated: Budget review', self::invitation('REQUEST', 1, '20261021T160000'));
        $holder->reset();

        $this->applyQueuedInvitations();

        $locks = array_values(array_filter(array_column($holder->getData()['default'] ?? [], 'sql'), static fn (mixed $sql): bool => \is_string($sql) && str_contains($sql, 'FOR UPDATE')));
        self::assertNotEmpty(array_filter($locks, static fn (string $sql): bool => str_contains($sql, 'calendar_invitation')), 'The worker and the apply action never both apply it.');
        self::assertNotEmpty(array_filter($locks, static fn (string $sql): bool => str_contains($sql, 'calendar_object')), 'No change of the event in between is lost.');
    }

    public function testCalendarMailOutsideTheInboxCanBeAppliedAndAppliesWhenMovedThere(): void
    {
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));
        $cancel = $this->receive('Cancelled: Budget review', self::invitation('CANCEL', 1, '20261021T140000'), folder: 'Archive');
        self::assertSame('confirmed', $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00')[0]['status']);
        self::assertTrue($this->getJson('/api/v1/messages/'.$cancel.'/invitation', $this->kim)['canApply']);

        $this->client->request('POST', '/api/v1/messages/'.$cancel.'/invitation/apply', server: $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame('cancelled', $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00')[0]['status']);
        $this->client->request('POST', '/api/v1/messages/'.$cancel.'/invitation/apply', server: $this->kim);
        self::assertResponseIsSuccessful('A second click changes nothing.');

        // An update filed in the archive, then moved to the inbox by the user.
        $update = $this->receive('Updated: Budget review', self::invitation('REQUEST', 2, '20261021T160000'), folder: 'Archive');
        $this->moveToInbox($update);
        self::assertSame(['dateTime' => '2026-10-21T14:00:00+00:00'], $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00')[0]['start']);
    }

    public function testCalendarMailRescuedFromSpamIsRecordedAndApplied(): void
    {
        $spam = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'), folder: 'Junk');

        $this->moveToInbox($spam);

        self::assertCount(1, $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00'));
    }

    public function testNoWritableCalendarIsSaidSoAndLeavesTheInvitationToApplyLater(): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/calendars', ['workerId' => 'w1', 'serverUrl' => 'https://caldav.company.example/dav/', 'calendars' => [
            ['remoteId' => 'https://caldav.company.example/dav/kim/shared/', 'name' => 'Shared', 'writable' => false, 'isDefault' => true],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        // A shared calendar the user made the account's default before it became read-only.
        $this->connection()->executeStatement('UPDATE calendar SET is_default = true WHERE mail_account_id = :account', ['account' => $this->accountId]);
        $messageId = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));

        $this->client->request('POST', '/api/v1/messages/'.$messageId.'/invitation/apply', server: $this->kim);

        self::assertResponseStatusCodeSame(422);
        self::assertStringContainsString('read-only', (string) $this->client->getResponse()->getContent());
        self::assertFalse($this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim)['canApply'], 'Not offered while it cannot work.');

        $this->connection()->executeStatement('UPDATE calendar SET writable = true WHERE mail_account_id = :account', ['account' => $this->accountId]);
        self::assertTrue($this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim)['canApply'], 'Still there to apply once the calendar takes it.');
    }

    public function testCalendarMailForAnEventInAReadOnlyCalendarIsNotSavedThere(): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/calendars', ['workerId' => 'w1', 'serverUrl' => 'https://caldav.company.example/dav/', 'calendars' => [
            ['remoteId' => 'https://caldav.company.example/dav/kim/home/', 'name' => 'Home', 'isDefault' => true],
        ]], $this->worker);
        self::assertResponseIsSuccessful();
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));
        // The worker wrote it to the provider.
        $this->connection()->executeStatement('DELETE FROM calendar_operation');
        // The calendar was shared read-only with the user since.
        $this->connection()->executeStatement('UPDATE calendar SET writable = false WHERE mail_account_id = :account', ['account' => $this->accountId]);

        $update = $this->receive('Updated: Budget review', self::invitation('REQUEST', 1, '20261021T160000'));

        self::assertEquals(0, $this->connection()->fetchOne('SELECT COUNT(*) FROM calendar_operation'), 'No write that the provider can only refuse.');
        self::assertSame(['dateTime' => '2026-10-21T12:00:00+00:00'], $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00')[0]['start']);
        self::assertFalse($this->getJson('/api/v1/messages/'.$update.'/invitation', $this->kim)['canApply']);
        $this->client->request('POST', '/api/v1/messages/'.$update.'/invitation/apply', server: $this->kim);
        self::assertResponseStatusCodeSame(422);
        self::assertNull($this->connection()->fetchOne('SELECT applied_at FROM calendar_invitation i JOIN message m ON m.id = i.message_id WHERE m.subject = :subject', ['subject' => 'Updated: Budget review']), 'Kept, to apply once the calendar takes it.');
    }

    public function testAnInvitationForAProviderScheduledEventIsNotOffered(): void
    {
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/calendars', ['workerId' => 'w1', 'serverUrl' => 'https://caldav.company.example/dav/', 'providerSchedules' => true, 'calendars' => [
            ['remoteId' => 'https://caldav.company.example/dav/kim/home/', 'name' => 'Home', 'isDefault' => true],
        ]], $this->worker);
        $home = $this->firstCalendarId();
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/calendars/'.$home.'/objects', ['workerId' => 'w1', 'changed' => [
            ['remoteId' => 'https://caldav.company.example/dav/kim/home/budget.ics', 'etag' => '"1"', 'ical' => str_replace("METHOD:REQUEST\r\n", '', self::invitation('REQUEST', 0, '20261021T140000'))],
        ]], $this->worker);
        self::assertResponseIsSuccessful();

        $update = $this->receive('Updated: Budget review', self::invitation('REQUEST', 1, '20261021T160000'));

        self::assertFalse($this->getJson('/api/v1/messages/'.$update.'/invitation', $this->kim)['canApply'], 'The provider puts it in; there is nothing to apply.');
    }

    public function testAChangeToOneOccurrenceKeepsTheAnswerToTheSeries(): void
    {
        $series = str_replace("SEQUENCE:0\r\n", "SEQUENCE:0\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\n", self::invitation('REQUEST', 0, '20261021T140000'));
        $messageId = $this->receive('Invitation: Budget review', $series);
        $eventId = self::string($this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim)['eventId']);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'accepted', 'notify' => false], $this->kim);
        self::assertResponseIsSuccessful();

        // The organizer moves the room of one occurrence: same SEQUENCE, later DTSTAMP, NEEDS-ACTION in their copy.
        $this->receive('Updated: Budget review', str_replace(
            ["BEGIN:VEVENT\r\n", 'LOCATION:Room 3', 'DTSTAMP:20261019T080000Z'],
            ["BEGIN:VEVENT\r\nRECURRENCE-ID;TZID=W. Europe Standard Time:20261028T140000\r\n", 'LOCATION:Room 5', 'DTSTAMP:20261019T090000Z'],
            self::invitation('REQUEST', 0, '20261028T140000'),
        ));

        $occurrence = $this->occurrences($this->kim, '2026-10-28T00:00:00+00:00', '2026-10-29T00:00:00+00:00')[0];
        self::assertSame('Room 5', $occurrence['location']);
        self::assertSame('accepted', $occurrence['selfResponse'], 'The answer to the series holds for the changed occurrence.');
    }

    public function testASeriesUpdateThatChangesOneOccurrenceKeepsTheAnswer(): void
    {
        $series = str_replace("SEQUENCE:0\r\n", "SEQUENCE:0\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\n", self::invitation('REQUEST', 0, '20261021T140000'));
        $messageId = $this->receive('Invitation: Budget review', $series);
        $eventId = self::string($this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim)['eventId']);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'accepted', 'notify' => false], $this->kim);
        self::assertResponseIsSuccessful();

        // The whole series again, now with one occurrence in another room: same SEQUENCE, later DTSTAMP.
        $override = str_replace(
            ["BEGIN:VEVENT\r\n", 'LOCATION:Room 3', 'DTSTAMP:20261019T080000Z'],
            ["BEGIN:VEVENT\r\nRECURRENCE-ID;TZID=W. Europe Standard Time:20261028T140000\r\n", 'LOCATION:Room 5', 'DTSTAMP:20261019T090000Z'],
            self::invitation('REQUEST', 0, '20261028T140000'),
        );
        $overrideEvent = substr($override, (int) strpos($override, 'BEGIN:VEVENT'), (int) strpos($override, "END:VEVENT\r\n") + \strlen("END:VEVENT\r\n") - (int) strpos($override, 'BEGIN:VEVENT'));
        $update = str_replace(["DTSTAMP:20261019T080000Z", "END:VCALENDAR"], ["DTSTAMP:20261019T090000Z", $overrideEvent.'END:VCALENDAR'], $series);
        $this->receive('Updated: Budget review', $update);

        $occurrence = $this->occurrences($this->kim, '2026-10-28T00:00:00+00:00', '2026-10-29T00:00:00+00:00')[0];
        self::assertSame('Room 5', $occurrence['location']);
        self::assertSame('accepted', $occurrence['selfResponse'], 'The answer to the series holds for the changed occurrence.');
    }

    public function testAReplyAnswersForAGuestAnOccurrenceSpellsDifferently(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->localCalendarId($this->kim), [
            'summary' => 'Planning',
            'recurrence' => 'FREQ=WEEKLY;COUNT=2',
            'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']],
            'organizerMailAccountId' => $this->accountId,
        ]), $this->kim);
        self::assertResponseStatusCodeSame(201);
        $this->organizedUid = self::string($this->decodedResponse()['uid']);
        $seriesId = self::string($this->decodedResponse()['id']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$seriesId.'?scope=this&recurrenceId=20261026T080000Z&notify=false', self::event($this->localCalendarId($this->kim), [
            'summary' => 'Planning, room 2',
            'start' => ['dateTime' => '2026-10-26T09:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2026-10-26T09:30:00', 'timeZone' => 'Europe/Amsterdam'],
            'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        // Another client wrote the guest in capitals on that occurrence.
        $ical = self::string($this->connection()->fetchOne('SELECT ical FROM calendar_object WHERE uid = :uid', ['uid' => $this->organizedUid]));
        $at = strrpos($ical, 'mailto:anna@finance.example');
        self::assertIsInt($at);
        $this->connection()->executeStatement('UPDATE calendar_object SET ical = :ical WHERE uid = :uid', ['ical' => substr_replace($ical, 'mailto:ANNA@finance.example', $at, \strlen('mailto:anna@finance.example')), 'uid' => $this->organizedUid]);

        $this->receive('Accepted: Planning', str_replace('DTSTART;TZID=Europe/Amsterdam:20261019T090000', "RECURRENCE-ID:20261026T080000Z\r\nDTSTART;TZID=Europe/Amsterdam:20261026T090000", $this->replyFrom('anna@finance.example', 'ACCEPTED')), 'anna@finance.example');

        $occurrence = $this->occurrences($this->kim, '2026-10-26T00:00:00+00:00', '2026-10-27T00:00:00+00:00')[0];
        $attendees = $this->getJson('/api/v1/calendar-events/'.self::string($occurrence['eventId']), $this->kim)['attendees'];
        self::assertIsArray($attendees);
        self::assertSame(['accepted'], array_column($attendees, 'partstat'), 'No second Anna on the occurrence.');
    }

    public function testAReplyGoesFromTheAccountTheInvitationCameToWhenNoAccountSendsAsTheInvitedAddress(): void
    {
        // Invited at the sign-in address, which no mail account sends as.
        $messageId = $this->receive('Invitation: Budget review', str_replace('mailto:kim@company.example', 'mailto:kim@example.test', self::invitation('REQUEST', 0, '20261021T140000')));
        $eventId = self::string($this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim)['eventId']);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'accepted'], $this->kim);

        self::assertResponseIsSuccessful();
        self::assertSame(['anna@finance.example'], $this->outgoing()[0]->getEnvelopeRecipients());
    }

    public function testOtherUsersCannotSeeOrApplyAnInvitationOrSendFromAnAccount(): void
    {
        $messageId = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'), folder: 'Archive');
        $this->createUser('lisa@example.test', 'Lisa');
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read', 'mail:send', 'calendar:read', 'calendar:write']);

        $this->client->request('GET', '/api/v1/messages/'.$messageId.'/invitation', server: $lisa);
        self::assertResponseStatusCodeSame(404);
        $this->client->request('POST', '/api/v1/messages/'.$messageId.'/invitation/apply', server: $lisa);
        self::assertResponseStatusCodeSame(404);

        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->localCalendarId($lisa), [
            'attendees' => [['address' => 'anna@finance.example', 'name' => null]],
            'organizerMailAccountId' => $this->accountId,
        ]), $lisa);
        self::assertResponseStatusCodeSame(422, 'Kim\'s account does not send for Lisa.');
        self::assertSame([], $this->outgoing());
    }

    public function testOnlyTheOrganizerCanUpdateOrCancelAnInvitation(): void
    {
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));

        $this->receive('Cancelled: Budget review', self::invitation('CANCEL', 1, '20261021T140000'), 'mallory@attacker.test');
        $this->receive('Updated: Budget review', self::invitation('REQUEST', 1, '20261021T180000'), 'mallory@attacker.test');
        $takeover = str_replace('ORGANIZER;CN=Anna de Vries:mailto:anna@finance.example', 'ORGANIZER:mailto:mallory@attacker.test', self::invitation('REQUEST', 2, '20261021T180000'));
        $this->receive('Updated: Budget review', $takeover, 'mallory@attacker.test');
        // Even the organizer cannot hand the event to someone else.
        $this->receive('Updated: Budget review', str_replace('mallory@attacker.test', 'pieter@finance.example', $takeover));

        $occurrences = $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00');
        self::assertCount(1, $occurrences);
        self::assertSame('confirmed', $occurrences[0]['status']);
        self::assertSame(['dateTime' => '2026-10-21T12:00:00+00:00'], $occurrences[0]['start']);
        $event = $this->getJson('/api/v1/calendar-events/'.self::string($occurrences[0]['eventId']), $this->kim);
        self::assertSame(['address' => 'anna@finance.example', 'name' => 'Anna de Vries'], $event['organizer']);
    }

    public function testAForgedHighSequenceCannotLockOutTheOrganizer(): void
    {
        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));

        $this->receive('Cancelled: Budget review', self::invitation('CANCEL', 999999, '20261021T140000'));
        $this->receive('Updated: Budget review', self::invitation('REQUEST', 1, '20261021T160000'));

        $occurrences = $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00');
        self::assertSame('confirmed', $occurrences[0]['status']);
        self::assertSame(['dateTime' => '2026-10-21T14:00:00+00:00'], $occurrences[0]['start']);
    }

    public function testCalendarMailNeverChangesAnEventTheUserOrganizes(): void
    {
        $calendarId = $this->localCalendarId($this->kim);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, [
            'summary' => 'Planning',
            'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']],
            'organizerMailAccountId' => $this->accountId,
        ]), $this->kim);
        self::assertResponseStatusCodeSame(201);
        $uid = self::string($this->decodedResponse()['uid']);
        $eventId = self::string($this->decodedResponse()['id']);
        $forged = static fn (string $method, string $organizer): string => str_replace(
            ['UID:budget-review@finance.example', 'ORGANIZER;CN=Anna de Vries:mailto:anna@finance.example'],
            ['UID:'.$uid, 'ORGANIZER:mailto:'.$organizer],
            self::invitation($method, 5, '20261019T090000'),
        );

        $this->receive('Cancelled: Planning', $forged('CANCEL', 'kim@company.example'), 'kim@company.example');
        $this->receive('Cancelled: Planning', $forged('CANCEL', 'anna@finance.example'));
        $this->receive('Updated: Planning', $forged('REQUEST', 'anna@finance.example'));

        $event = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->kim);
        self::assertSame('confirmed', $event['status']);
        self::assertSame('Planning', $event['summary']);
        self::assertSame(['address' => 'kim@company.example', 'name' => 'Kim Visser'], $event['organizer']);
    }

    public function testAddingGuestsToAnExistingEventInvitesThem(): void
    {
        $calendarId = $this->localCalendarId($this->kim);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, ['summary' => 'Planning']), $this->kim);
        self::assertResponseStatusCodeSame(201);
        $eventId = self::string($this->decodedResponse()['id']);
        self::assertSame([], $this->outgoing());

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($calendarId, [
            'summary' => 'Planning',
            'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']],
            'organizerMailAccountId' => $this->accountId,
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame(['address' => 'kim@company.example', 'name' => 'Kim Visser'], $this->decodedResponse()['organizer']);

        $outgoing = $this->outgoing();
        self::assertCount(1, $outgoing);
        self::assertSame('Invitation: Planning', $outgoing[0]->getSubject());
        self::assertSame(['anna@finance.example'], $outgoing[0]->getEnvelopeRecipients());

        // A guest added later is invited as well, by the same organizer.
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($calendarId, [
            'summary' => 'Planning',
            'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries'], ['address' => 'pieter@finance.example', 'name' => null]],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        $outgoing = $this->outgoing();
        self::assertContains(['pieter@finance.example'], array_map(static fn ($message): array => $message->getEnvelopeRecipients(), $outgoing));
    }

    public function testAReplyWithoutTimesShowsTheEventAsTheCalendarHasIt(): void
    {
        $calendarId = $this->localCalendarId($this->kim);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, [
            'summary' => 'Planning',
            'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']],
            'organizerMailAccountId' => $this->accountId,
        ]), $this->kim);
        $uid = self::string($this->decodedResponse()['uid']);

        $messageId = $this->receive('Accepted: Planning', implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN', 'METHOD:REPLY', 'BEGIN:VEVENT',
            'UID:'.$uid, 'SEQUENCE:0', 'DTSTAMP:20261019T090000Z',
            'ORGANIZER:mailto:kim@company.example', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:anna@finance.example',
            'END:VEVENT', 'END:VCALENDAR', '',
        ]));

        $invitation = $this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim);
        self::assertSame('reply', $invitation['kind']);
        self::assertSame('Planning', $invitation['summary']);
        self::assertSame(['dateTime' => '2026-10-19T09:00:00', 'timeZone' => 'Europe/Amsterdam'], $invitation['start']);
    }

    public function testAReplyCountsOnlyFromAnAttendeeItSpeaksFor(): void
    {
        $calendarId = $this->localCalendarId($this->kim);
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($calendarId, [
            'summary' => 'Planning',
            'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']],
            'organizerMailAccountId' => $this->accountId,
        ]), $this->kim);
        $uid = self::string($this->decodedResponse()['uid']);
        $eventId = self::string($this->decodedResponse()['id']);
        $reply = static fn (string $attendee): string => implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN', 'METHOD:REPLY', 'BEGIN:VEVENT',
            'UID:'.$uid, 'SEQUENCE:0', 'DTSTAMP:20261019T090000Z', 'DTSTART;TZID=Europe/Amsterdam:20261019T090000',
            'ORGANIZER:mailto:kim@company.example', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:'.$attendee,
            'END:VEVENT', 'END:VCALENDAR', '',
        ]);

        // An outsider cannot join by answering, nor answer for an attendee.
        $this->receive('Accepted: Planning', $reply('mallory@attacker.test'), 'mallory@attacker.test');
        $this->receive('Accepted: Planning', $reply('anna@finance.example'), 'mallory@attacker.test');

        $attendees = $this->getJson('/api/v1/calendar-events/'.$eventId, $this->kim)['attendees'];
        self::assertIsArray($attendees);
        self::assertSame(['anna@finance.example'], array_column($attendees, 'address'));
        self::assertSame(['needs-action'], array_column($attendees, 'partstat'));
    }

    public function testCalendarMailInSpamOrFromBeforeTheAccountWasConnectedChangesNothing(): void
    {
        $spam = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'), folder: 'Junk');
        $this->client->request('GET', '/api/v1/messages/'.$spam.'/invitation', server: $this->kim);
        self::assertResponseStatusCodeSame(404);

        $old = $this->receive('Invitation: Old review', self::invitation('REQUEST', 0, '20261021T140000'), receivedAt: '2020-01-06T08:00:00+00:00');
        self::assertSame([], $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00'));
        $invitation = $this->getJson('/api/v1/messages/'.$old.'/invitation', $this->kim);
        self::assertSame('Budget review', $invitation['summary'], 'The message still shows what it carries.');
        self::assertNull($invitation['eventId']);
        self::assertFalse($invitation['canRespond']);
        self::assertTrue($invitation['canApply']);
    }

    public function testAnInvitationTheCalendarDidNotTakeCanBeAddedWithTheSameChecks(): void
    {
        $old = $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'), receivedAt: '2020-01-06T08:00:00+00:00');
        $forged = $this->receive('Invitation: Budget review again', str_replace('UID:budget-review@finance.example', 'UID:other@finance.example', self::invitation('REQUEST', 0, '20261022T140000')), 'mallory@attacker.test', receivedAt: '2020-01-06T08:00:00+00:00');

        $this->client->request('POST', '/api/v1/messages/'.$old.'/invitation/apply', server: $this->kim);
        self::assertResponseIsSuccessful();
        $added = $this->decodedResponse();
        self::assertIsString($added['eventId']);
        self::assertFalse($added['canApply']);
        self::assertTrue($added['canRespond']);
        self::assertCount(1, $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00'));

        $this->client->request('POST', '/api/v1/messages/'.$old.'/invitation/apply', server: $this->kim);
        self::assertResponseIsSuccessful('A second apply (a double click, a retry) changes nothing.');
        self::assertSame($added['eventId'], $this->decodedResponse()['eventId']);
        self::assertCount(1, $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00'));

        $this->client->request('POST', '/api/v1/messages/'.$forged.'/invitation/apply', server: $this->kim);
        self::assertResponseStatusCodeSame(422, 'Not from the organizer it names.');
        self::assertSame([], $this->occurrences($this->kim, '2026-10-22T00:00:00+00:00', '2026-10-23T00:00:00+00:00'));
    }

    public function testAnEventTooLongToCheckForConflictsStillShows(): void
    {
        $long = str_replace('DTEND;TZID=W. Europe Standard Time:20261021T150000', 'DTEND;TZID=W. Europe Standard Time:20280101T150000', self::invitation('REQUEST', 0, '20261021T140000'));
        $messageId = $this->receive('Invitation: Sabbatical', $long);

        $invitation = $this->getJson('/api/v1/messages/'.$messageId.'/invitation', $this->kim);

        self::assertSame('Budget review', $invitation['summary']);
        self::assertSame([], $invitation['conflicts']);
    }

    public function testAUserWithoutATressoCalendarGetsOneForAnInvitation(): void
    {
        // Users from before calendars existed have none.
        self::getContainer()->get(EntityManagerInterface::class)->createQuery('DELETE FROM '.Calendar::class.' c')->execute();

        $this->receive('Invitation: Budget review', self::invitation('REQUEST', 0, '20261021T140000'));

        $occurrences = $this->occurrences($this->kim, '2026-10-21T00:00:00+00:00', '2026-10-22T00:00:00+00:00');
        self::assertCount(1, $occurrences);
        $calendars = $this->getJson('/api/v1/calendars', $this->kim);
        self::assertSame(['Tresso'], array_column($calendars, 'name'));
        self::assertSame([true], array_column($calendars, 'isDefault'));
    }

    private static function delegatedTo(string $delegate, string $ical): string
    {
        return str_replace('ORGANIZER;CN=Anna de Vries:', 'ORGANIZER;CN=Anna de Vries;SENT-BY="mailto:'.$delegate.'":', $ical);
    }

    /** An event Kim organizes with Anna as guest; returns its id. */
    private function firstCalendarId(): string
    {
        $calendars = $this->decodedResponse()['calendars'] ?? null;
        self::assertIsArray($calendars);
        $first = $calendars[0] ?? null;
        self::assertIsArray($first);

        return self::string($first['id'] ?? null);
    }

    private function organize(): string
    {
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->localCalendarId($this->kim), [
            'summary' => 'Planning',
            'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']],
            'organizerMailAccountId' => $this->accountId,
        ]), $this->kim);
        self::assertResponseStatusCodeSame(201);
        $this->organizedUid = self::string($this->decodedResponse()['uid']);

        return self::string($this->decodedResponse()['id']);
    }

    private function replyFrom(string $attendee, string $partstat): string
    {
        return implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN', 'METHOD:REPLY', 'BEGIN:VEVENT',
            'UID:'.$this->organizedUid, 'SEQUENCE:0', 'DTSTAMP:20261019T090000Z', 'DTSTART;TZID=Europe/Amsterdam:20261019T090000',
            'ORGANIZER:mailto:kim@company.example', 'ATTENDEE;PARTSTAT='.$partstat.':mailto:'.$attendee,
            'END:VEVENT', 'END:VCALENDAR', '',
        ]);
    }

    /** The same message appears in the inbox (the user moved it there), as the worker reports it. */
    private function moveToInbox(string $messageId): void
    {
        $stored = $this->connection()->fetchAssociative('SELECT message_id_header, subject, raw_object_key FROM message WHERE id = :id', ['id' => $messageId]);
        self::assertIsArray($stored);
        $ical = $this->connection()->fetchOne('SELECT ical FROM calendar_invitation WHERE message_id = :id', ['id' => $messageId]);
        ++$this->uid;
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/messages', ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [[
            'remoteUid' => (string) $this->uid,
            'rawObjectKey' => $stored['raw_object_key'],
            'keyVersion' => 1,
            'size' => 100,
            'receivedAt' => new \DateTimeImmutable('+1 minute')->format(\DATE_ATOM),
            'messageId' => $stored['message_id_header'],
            'subject' => $stored['subject'],
            'from' => ['address' => 'anna@finance.example', 'name' => null],
            'to' => [['address' => 'kim@company.example']],
            'calendarParts' => \is_string($ical) ? [['method' => null, 'ical' => $ical]] : $this->lastParts,
        ]]], $this->worker);
        self::assertResponseIsSuccessful();
        $this->applyQueuedInvitations();
    }

    private static function invitation(string $method, int $sequence, string $start): string
    {
        $end = substr($start, 0, 9).\sprintf('%02d', (int) substr($start, 9, 2) + 1).substr($start, 11);

        return implode("\r\n", [
            'BEGIN:VCALENDAR', 'PRODID:-//Example//EN', 'VERSION:2.0', 'METHOD:'.$method, 'BEGIN:VEVENT',
            'UID:budget-review@finance.example', 'SEQUENCE:'.$sequence, 'DTSTAMP:20261019T080000Z',
            'DTSTART;TZID=W. Europe Standard Time:'.$start, 'DTEND;TZID=W. Europe Standard Time:'.$end,
            'SUMMARY:Budget review', 'LOCATION:Room 3',
            'ORGANIZER;CN=Anna de Vries:mailto:anna@finance.example',
            'ATTENDEE;CN=Kim Visser;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;ROLE=REQ-PARTICIPANT:mailto:kim@company.example',
            'ATTENDEE;PARTSTAT=ACCEPTED:mailto:anna@finance.example',
            'END:VEVENT', 'END:VCALENDAR', '',
        ]);
    }

    /**
     * Ingests a message with a calendar part (from Anna unless said otherwise) and applies it; returns the message id.
     */
    private function receive(string $subject, string $ical, string $from = 'anna@finance.example', string $folder = 'INBOX', ?string $receivedAt = null): string
    {
        $this->deliver($subject, $ical, $from, $folder, $receivedAt);
        $this->applyQueuedInvitations();

        return $this->messageId($subject);
    }

    /**
     * The worker reports the message; the invitation handlers it queues have not run yet.
     */
    private function deliver(string $subject, string $ical, string $from = 'anna@finance.example', string $folder = 'INBOX', ?string $receivedAt = null): void
    {
        ++$this->uid;
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$this->accountId.'/messages', ['workerId' => 'w1', 'folder' => $folder, 'messages' => [[
            'remoteUid' => (string) $this->uid,
            'rawObjectKey' => $this->rawKeyFor($this->accountId, $subject.$this->uid),
            'keyVersion' => 1,
            'size' => 100,
            'receivedAt' => $receivedAt ?? new \DateTimeImmutable('+1 minute')->format(\DATE_ATOM),
            'messageId' => '<invite-'.$this->uid.'@finance.example>',
            'subject' => $subject,
            'from' => ['address' => $from, 'name' => null],
            'to' => [['address' => 'kim@company.example']],
            'calendarParts' => [['method' => null, 'ical' => $ical]],
        ]]], $this->worker);
        self::assertResponseIsSuccessful();
        $this->lastParts = [['method' => null, 'ical' => $ical]];
    }

    private function messageId(string $subject): string
    {
        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['messages']);
        foreach ($delta['messages'] as $message) {
            if (\is_array($message) && $message['subject'] === $subject && \is_string($message['id'])) {
                $id = $message['id'];
            }
        }

        return $id ?? self::fail('The message was not stored.');
    }
}
