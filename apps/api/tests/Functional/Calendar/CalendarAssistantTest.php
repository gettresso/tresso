<?php

declare(strict_types=1);

namespace App\Tests\Functional\Calendar;

use App\Entity\CalendarInvitation;
use App\Entity\Message;
use App\Entity\SchedulingPreferences;
use App\Entity\User;
use App\Enum\ItipMethod;
use App\Repository\SchedulingPreferencesRepository;
use App\Repository\UserRepository;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\DatabaseTestCase;
use App\Tests\Functional\StoresMail;
use App\Tests\Support\QueryLog;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Clock\Test\ClockSensitiveTrait;

/**
 * The built-in calendar assistant: scheduling preferences, the meeting time finder, event
 * drafts and event suggestions from mail. Briefs have their tests with the notifications.
 */
final class CalendarAssistantTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use StoresMail;
    use CalendarTestHelpers;
    use ClockSensitiveTrait;

    private const array SCOPES = ['mail:read', 'mail:send', 'calendar:read', 'calendar:write', 'settings:read', 'settings:write'];
    /** Monday 22 March 2027: Amsterdam is at +01:00 until summer time starts on Sunday the 28th. */
    private const string MONDAY = '2027-03-22';
    /** The tests run on the Saturday before, whatever the real date. */
    private const string NOW = '2027-03-20T12:00:00+00:00';

    /** @var array<string, string> */
    private array $kim;

    private string $calendarId;

    private int $uid = 0;

    protected function setUp(): void
    {
        parent::setUp();
        self::mockTime(new \DateTimeImmutable(self::NOW));
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', self::SCOPES);
        $this->calendarId = $this->localCalendarId($this->kim);
        $this->notificationSettings(['timeZone' => 'Europe/Amsterdam', 'workEnd' => '17:00']);
    }

    public function testCapabilitiesDescribeTheBuiltInAssistant(): void
    {
        self::assertSame([
            'eventDrafts' => false,
            'meetingTimes' => true,
            'attendeeAvailability' => false,
            'eventSuggestions' => true,
            'textSuggestions' => false,
            'meetingBriefs' => true,
            'briefSummaries' => false,
        ], $this->getJson('/api/v1/calendar/capabilities', $this->kim));
    }

    public function testSchedulingPreferencesStartWithTheDefaults(): void
    {
        self::assertSame(['bufferMinutes' => 0, 'travelMinutes' => 0, 'minimumNoticeMinutes' => 0, 'planTodos' => false], $this->getJson('/api/v1/calendar/scheduling-preferences', $this->kim));
    }

    public function testSchedulingPreferencesChangeOnlyWhatIsSent(): void
    {
        $this->patchPreferences(['bufferMinutes' => 10, 'minimumNoticeMinutes' => 60]);
        $this->patchPreferences(['travelMinutes' => 25]);

        self::assertSame(['bufferMinutes' => 10, 'travelMinutes' => 25, 'minimumNoticeMinutes' => 60, 'planTodos' => false], $this->getJson('/api/v1/calendar/scheduling-preferences', $this->kim));
    }

    public function testTheFirstChangeCreatesThePreferencesOnceAndLocksThem(): void
    {
        $log = static::getContainer()->get(QueryLog::class);
        $log->clear();

        $this->patchPreferences(['bufferMinutes' => 5]);

        $sql = implode("\n", $log->queries());
        self::assertStringContainsString('ON CONFLICT (user_id) DO NOTHING', $sql, 'Two first changes at once find one row.');
        self::assertStringContainsString('FOR UPDATE', $sql);
        $this->patchPreferences(['travelMinutes' => 20]);
        self::assertSame(['bufferMinutes' => 5, 'travelMinutes' => 20, 'minimumNoticeMinutes' => 0, 'planTodos' => false], $this->getJson('/api/v1/calendar/scheduling-preferences', $this->kim));
    }

    public function testAChangeLocksThePreferencesAsAnotherRequestLeftThem(): void
    {
        $this->patchPreferences(['bufferMinutes' => 5, 'travelMinutes' => 20]);
        $user = static::getContainer()->get(UserRepository::class)->findOneBy(['email' => 'kim@example.test']);
        self::assertInstanceOf(User::class, $user);
        $preferences = static::getContainer()->get(SchedulingPreferencesRepository::class);
        // This request read them first (as the API's provider does), then another request saved its change.
        self::assertSame(5, $preferences->forUser($user)->getBufferMinutes());
        $this->connection()->executeStatement('UPDATE scheduling_preferences SET buffer_minutes = 30, travel_minutes = 45');

        $locked = static::getContainer()->get(EntityManagerInterface::class)->wrapInTransaction(static fn (): SchedulingPreferences => $preferences->lockForUser($user));

        self::assertSame(30, $locked->getBufferMinutes());
        self::assertSame(45, $locked->getTravelMinutes());
    }

    public function testSchedulingPreferencesStayWithinTheirLimits(): void
    {
        $this->patchPreferences(['bufferMinutes' => 500, 'travelMinutes' => -1, 'minimumNoticeMinutes' => 99999], 422);

        $paths = array_column($this->violations(), 'propertyPath');
        sort($paths);
        self::assertSame(['bufferMinutes', 'minimumNoticeMinutes', 'travelMinutes'], $paths);
    }

    public function testSchedulingPreferencesNeedTheSettingsScopes(): void
    {
        $calendarOnly = $this->userHeaders('kim@example.test', ['calendar:read', 'calendar:write']);

        $this->client->request('GET', '/api/v1/calendar/scheduling-preferences', server: $calendarOnly);
        self::assertResponseStatusCodeSame(403);
    }

    public function testMeetingTimesKeepToTheWorkingHoursOfTheNotificationSettings(): void
    {
        $this->notificationSettings(['workDays' => [2], 'workStart' => '13:00', 'workEnd' => '14:00']);

        $times = $this->findTimes(['to' => '2027-03-24T00:00:00+01:00', 'durationMinutes' => 60]);

        self::assertSame(['2027-03-23T12:00:00+00:00'], self::starts($times));
        self::assertSame(['at' => '2027-03-23T13:00:00+00:00', 'reason' => 'working_hours', 'label' => ''], self::slots($times)[0]['freeUntil']);
    }

    public function testASearchCanReadWorkingHoursInAnotherZone(): void
    {
        $times = $this->findTimes(['durationMinutes' => 60, 'limit' => 1, 'timeZone' => 'America/New_York']);

        // New York is on summer time from 14 March: 09:00 there is 13:00 UTC.
        self::assertSame('America/New_York', $times['timeZone']);
        self::assertSame(['2027-03-22T13:00:00+00:00'], self::starts($times));
    }

    public function testAFocusEventIsKeptFreeAsAFocusBlock(): void
    {
        $this->patchPreferences(['bufferMinutes' => 15]);
        $this->createEvent('Focus time', self::MONDAY.'T09:00:00', self::MONDAY.'T11:00:00');

        $slot = self::slots($this->findTimes(['durationMinutes' => 60, 'limit' => 1]))[0];

        self::assertSame('2027-03-22T10:00:00+00:00', $slot['start']);
        self::assertSame(['at' => '2027-03-22T10:00:00+00:00', 'reason' => 'focus', 'label' => 'Focus time'], $slot['freeFrom']);
    }

    public function testAnEventsOwnTravelTimeIsKeptFree(): void
    {
        $this->createEvent('Dentist', self::MONDAY.'T09:00:00', self::MONDAY.'T10:00:00', ['travelMinutes' => 30]);

        $slot = self::slots($this->findTimes(['durationMinutes' => 60, 'limit' => 1]))[0];

        self::assertSame('2027-03-22T09:30:00+00:00', $slot['start']);
        self::assertSame(['at' => '2027-03-22T09:30:00+00:00', 'reason' => 'travel', 'label' => 'Dentist'], $slot['freeFrom']);
    }

    public function testMeetingTimesKeepClearOfBusyTimeAndSayWhy(): void
    {
        $this->createEvent('Standup', self::MONDAY.'T10:00:00', self::MONDAY.'T11:00:00');

        $times = $this->findTimes(['durationMinutes' => 60, 'limit' => 3]);

        self::assertSame('Europe/Amsterdam', $times['timeZone']);
        self::assertNull($times['noSlotReason']);
        self::assertSame(['2027-03-22T08:00:00+00:00', '2027-03-22T10:00:00+00:00', '2027-03-22T11:00:00+00:00'], self::starts($times));
        $slots = self::slots($times);
        self::assertSame(['at' => '2027-03-22T08:00:00+00:00', 'reason' => 'working_hours', 'label' => ''], $slots[0]['freeFrom']);
        self::assertSame(['at' => '2027-03-22T09:00:00+00:00', 'reason' => 'busy', 'label' => 'Standup'], $slots[0]['freeUntil']);
        self::assertSame(['at' => '2027-03-22T10:00:00+00:00', 'reason' => 'busy', 'label' => 'Standup'], $slots[1]['freeFrom']);
        self::assertSame([], $slots[1]['optionalConflicts']);
    }

    public function testNothingIsProposedBeforeNowOnTheClock(): void
    {
        self::mockTime(new \DateTimeImmutable('2027-03-22T08:20:00+00:00'));

        $slot = self::slots($this->findTimes(['durationMinutes' => 30, 'limit' => 1]))[0];

        self::assertSame('2027-03-22T08:30:00+00:00', $slot['start']);
        self::assertSame(['at' => '2027-03-22T08:20:00+00:00', 'reason' => 'notice', 'label' => ''], $slot['freeFrom']);
    }

    public function testRecurringBusyTimeIsKeptFreeOnEveryOccurrenceAcrossDaylightSaving(): void
    {
        $this->createEvent('Mornings', '2027-03-15T09:00:00', '2027-03-15T12:00:00', ['recurrence' => 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR']);

        $times = $this->findTimes(['from' => '2027-03-26T00:00:00+01:00', 'to' => '2027-03-30T00:00:00+02:00', 'durationMinutes' => 60, 'perDay' => 1]);

        // 12:00 in Amsterdam: 11:00 UTC on Friday, 10:00 UTC on Monday in summer time.
        self::assertSame(['2027-03-26T11:00:00+00:00', '2027-03-29T10:00:00+00:00'], self::starts($times));
        self::assertSame(['at' => '2027-03-29T10:00:00+00:00', 'reason' => 'busy', 'label' => 'Mornings'], self::slots($times)[1]['freeFrom']);
    }

    public function testAMovedOccurrenceAndARemovedOneAreReadAsTheCalendarHasThem(): void
    {
        $series = $this->createEvent('Mornings', self::MONDAY.'T09:00:00', self::MONDAY.'T10:00:00', ['recurrence' => 'FREQ=DAILY;COUNT=3']);
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$series.'?scope=this&recurrenceId=20270323T080000Z', self::event($this->calendarId, [
            'summary' => 'Mornings (moved)',
            'start' => ['dateTime' => '2027-03-23T14:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2027-03-23T15:00:00', 'timeZone' => 'Europe/Amsterdam'],
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        $this->client->request('DELETE', '/api/v1/calendar-events/'.$series.'?scope=this&recurrenceId=20270324T080000Z', server: $this->kim);
        self::assertResponseStatusCodeSame(204);

        $times = $this->findTimes(['from' => '2027-03-23T00:00:00+01:00', 'to' => '2027-03-25T00:00:00+01:00', 'durationMinutes' => 60, 'perDay' => 1]);

        self::assertSame(['2027-03-23T08:00:00+00:00', '2027-03-24T08:00:00+00:00'], self::starts($times));
        self::assertSame(['at' => '2027-03-23T13:00:00+00:00', 'reason' => 'busy', 'label' => 'Mornings (moved)'], self::slots($times)[0]['freeUntil']);
        self::assertSame(['at' => '2027-03-24T16:00:00+00:00', 'reason' => 'working_hours', 'label' => ''], self::slots($times)[1]['freeUntil']);
    }

    public function testUnansweredAndTentativeInvitationsAreBusyAndDeclinedOnesAreNot(): void
    {
        [$accountId, $worker] = $this->connectAccount();
        $message = $this->deliver($accountId, $worker, 'Invitation: Budget review', 'anna@finance.example', ['kim@company.example'], self::invitation());
        $eventId = $this->getJson('/api/v1/messages/'.$message.'/invitation', $this->kim)['eventId'];
        self::assertIsString($eventId);
        // Wednesday 24 March, 12:00 to 15:00 UTC; the invitation takes 13:00 to 14:00.
        $window = ['from' => '2027-03-24T12:00:00+00:00', 'to' => '2027-03-24T15:00:00+00:00', 'durationMinutes' => 60];

        self::assertSame(['2027-03-24T12:00:00+00:00', '2027-03-24T14:00:00+00:00'], self::starts($this->findTimes($window)), 'Unanswered.');

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'tentative', 'notify' => false], $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame(['2027-03-24T12:00:00+00:00', '2027-03-24T14:00:00+00:00'], self::starts($this->findTimes($window)), 'Tentative.');

        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/response', ['response' => 'declined', 'notify' => false], $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame(['2027-03-24T12:00:00+00:00', '2027-03-24T13:00:00+00:00', '2027-03-24T14:00:00+00:00'], self::starts($this->findTimes($window)), 'Declined.');
    }

    public function testATimedEventOverSeveralDaysClosesThemAll(): void
    {
        $this->createEvent('Conference', self::MONDAY.'T15:00:00', '2027-03-24T10:00:00');

        $times = $this->findTimes(['to' => '2027-03-25T00:00:00+01:00', 'durationMinutes' => 60, 'perDay' => 1]);

        self::assertSame(['2027-03-22T08:00:00+00:00', '2027-03-24T09:00:00+00:00'], self::starts($times));
        self::assertSame(['at' => '2027-03-24T09:00:00+00:00', 'reason' => 'busy', 'label' => 'Conference'], self::slots($times)[1]['freeFrom']);
    }

    public function testAllDayBusyEventsTakeTheirWholeDays(): void
    {
        $this->createEvent('Offsite', null, null, ['start' => ['date' => self::MONDAY], 'end' => ['date' => '2027-03-23']]);

        $times = $this->findTimes(['durationMinutes' => 30, 'limit' => 1, 'to' => '2027-03-24T00:00:00+01:00']);

        self::assertSame(['2027-03-23T08:00:00+00:00'], self::starts($times));
    }

    public function testFreeEventsLeaveTheTimeFree(): void
    {
        $this->createEvent('Reading', self::MONDAY.'T09:00:00', self::MONDAY.'T10:00:00', ['transparency' => 'free']);

        self::assertSame(['2027-03-22T08:00:00+00:00'], self::starts($this->findTimes(['durationMinutes' => 60, 'limit' => 1])));
    }

    public function testTheMeetingBeingMovedDoesNotBlockItself(): void
    {
        $event = $this->createEvent('Planning', self::MONDAY.'T09:00:00', self::MONDAY.'T10:00:00');

        self::assertSame(['2027-03-22T08:00:00+00:00'], self::starts($this->findTimes(['durationMinutes' => 60, 'limit' => 1, 'ignore' => [$event]])));
    }

    public function testHiddenCalendarsCountOnlyWhenNamed(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/calendars', ['name' => 'Family'], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $family = $this->responseString('id');
        $this->client->request('PATCH', '/api/v1/calendars/'.$family, server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['visible' => false], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
        $this->createEvent('School run', self::MONDAY.'T09:00:00', self::MONDAY.'T10:00:00', ['calendarId' => $family]);

        self::assertSame(['2027-03-22T08:00:00+00:00'], self::starts($this->findTimes(['durationMinutes' => 60, 'limit' => 1])));
        self::assertSame(['2027-03-22T09:00:00+00:00'], self::starts($this->findTimes(['durationMinutes' => 60, 'limit' => 1, 'calendarIds' => [$family, $this->calendarId]])));
    }

    public function testAnotherUsersCalendarCannotBeSearched(): void
    {
        $this->createUser('lisa@example.test', 'Lisa');
        $lisasCalendar = $this->localCalendarId($this->userHeaders('lisa@example.test', self::SCOPES));

        $this->findTimes(['durationMinutes' => 30, 'timeZone' => 'UTC', 'calendarIds' => [$lisasCalendar]], 422);

        self::assertSame(['calendarIds[0]'], array_column($this->violations(), 'propertyPath'));
    }

    public function testAttendeesAvailabilityIsKnownOnlyForTheUsersOwnAddresses(): void
    {
        $times = $this->findTimes(['durationMinutes' => 30, 'timeZone' => 'Europe/Amsterdam', 'limit' => 1, 'attendees' => [
            ['address' => 'Sam@Example.test'],
            ['address' => 'kim@example.test', 'optional' => true],
        ]]);

        self::assertSame([['address' => 'sam@example.test', 'availability' => 'unknown'], ['address' => 'kim@example.test', 'availability' => 'known']], $times['attendees']);
        self::assertSame(['2027-03-22T08:00:00+00:00'], self::starts($times));
    }

    public function testAWindowWithoutWorkingHoursSaysSo(): void
    {
        $times = $this->findTimes(['from' => '2027-03-27T00:00:00+01:00', 'to' => '2027-03-29T00:00:00+02:00', 'timeZone' => 'Europe/Amsterdam']);

        self::assertSame([], $times['slots']);
        self::assertSame('no_working_hours', $times['noSlotReason']);
    }

    public function testMeetingTimeWindowsAreLimited(): void
    {
        $this->findTimes(['from' => '2027-03-22T00:00:00+00:00', 'to' => '2027-07-01T00:00:00+00:00', 'timeZone' => 'UTC'], 422);
        self::assertSame(['to'], array_column($this->violations(), 'propertyPath'));

        $this->findTimes(['from' => '2027-03-22T00:00:00+00:00', 'to' => '2027-03-21T00:00:00+00:00', 'timeZone' => 'UTC'], 422);
        self::assertSame(['to'], array_column($this->violations(), 'propertyPath'));

        $this->findTimes(['stepMinutes' => 7, 'durationMinutes' => 2, 'timeZone' => 'UTC'], 422);
        $paths = array_column($this->violations(), 'propertyPath');
        sort($paths);
        self::assertSame(['durationMinutes', 'stepMinutes'], $paths);
    }

    public function testMeetingTimesNeedTheCalendarScope(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/calendar/meeting-times', ['from' => '2027-03-22T00:00:00+00:00', 'to' => '2027-03-23T00:00:00+00:00'], $this->userHeaders('kim@example.test', ['mail:read']));

        self::assertResponseStatusCodeSame(403);
    }

    public function testEventDraftsFromTextAreNotBuiltIn(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/calendar/event-drafts', ['text' => 'Lunch with Sam Thursday 12:30', 'timeZone' => 'Europe/Amsterdam'], $this->kim);

        self::assertResponseStatusCodeSame(501);
    }

    public function testEventSuggestionsComeFromTheCalendarPartsOfAMessage(): void
    {
        [$accountId, $worker] = $this->connectAccount();
        $invitation = $this->deliver($accountId, $worker, 'Invitation: Budget review', 'anna@finance.example', ['kim@company.example'], self::invitation());
        $plain = $this->deliver($accountId, $worker, 'Lunch?', 'anna@finance.example', ['kim@company.example']);

        $suggestions = $this->getJson('/api/v1/messages/'.$invitation.'/event-suggestions', $this->kim);
        self::assertSame([], $suggestions['deadlines']);
        self::assertIsArray($suggestions['events']);
        self::assertCount(1, $suggestions['events']);
        $event = $suggestions['events'][0];
        self::assertIsArray($event);
        self::assertSame('calendar_part', $event['source']);
        self::assertSame('budget-review@finance.example', $event['uid']);
        $eventId = $this->getJson('/api/v1/messages/'.$invitation.'/invitation', $this->kim)['eventId'];
        self::assertIsString($eventId);
        self::assertSame($eventId, $event['eventId']);
        self::assertSame([
            'summary' => 'Budget review',
            'description' => '',
            'location' => 'Room 3',
            'start' => ['dateTime' => '2027-03-24T14:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => '2027-03-24T15:00:00', 'timeZone' => 'Europe/Amsterdam'],
            'recurrence' => null,
            'attendees' => [
                ['address' => 'kim@company.example', 'name' => 'Kim Visser', 'role' => 'required'],
                ['address' => 'anna@finance.example', 'name' => null, 'role' => 'required'],
            ],
            'conferenceUrl' => null,
        ], $event['draft']);

        self::assertSame(['id' => $plain, 'events' => [], 'deadlines' => []], $this->getJson('/api/v1/messages/'.$plain.'/event-suggestions', $this->kim));
    }

    public function testACalendarPartThatCannotBeReadLeavesTheOthers(): void
    {
        [$accountId, $worker] = $this->connectAccount();
        $messageId = $this->deliver($accountId, $worker, 'Invitation: Budget review', 'anna@finance.example', ['kim@company.example'], self::invitation());
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $message = $entityManager->find(Message::class, $messageId);
        self::assertInstanceOf(Message::class, $message);
        $entityManager->persist(new CalendarInvitation($message, ItipMethod::Request, 'broken@finance.example', 0, '', 'not iCalendar at all'));
        $entityManager->flush();

        $suggestions = $this->getJson('/api/v1/messages/'.$messageId.'/event-suggestions', $this->kim);

        self::assertSame(['budget-review@finance.example'], array_column(\is_array($suggestions['events']) ? $suggestions['events'] : [], 'uid'));
    }

    public function testAnotherUsersMessageHasNoSuggestions(): void
    {
        [$accountId, $worker] = $this->connectAccount();
        $message = $this->deliver($accountId, $worker, 'Invitation: Budget review', 'anna@finance.example', ['kim@company.example'], self::invitation());
        $this->createUser('lisa@example.test', 'Lisa');

        $this->client->request('GET', '/api/v1/messages/'.$message.'/event-suggestions', server: $this->userHeaders('lisa@example.test', self::SCOPES));

        self::assertResponseStatusCodeSame(404);
    }

    /**
     * @param array<string, mixed> $changes
     */
    private function notificationSettings(array $changes): void
    {
        $this->client->request('PATCH', '/api/v1/notification-settings', server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode($changes, \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
    }

    /**
     * @param array<string, mixed> $changes
     */
    private function patchPreferences(array $changes, int $status = 200): void
    {
        $this->client->request('PATCH', '/api/v1/calendar/scheduling-preferences', server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode($changes, \JSON_THROW_ON_ERROR));
        self::assertResponseStatusCodeSame($status);
    }

    /**
     * Searches Monday 22 March 2027 unless the query says otherwise.
     *
     * @param array<string, mixed> $query
     *
     * @return array<mixed>
     */
    private function findTimes(array $query, int $status = 200): array
    {
        $this->client->jsonRequest('POST', '/api/v1/calendar/meeting-times', [...['from' => self::MONDAY.'T00:00:00+01:00', 'to' => '2027-03-23T00:00:00+01:00'], ...$query], $this->kim);
        self::assertResponseStatusCodeSame($status);

        return $this->decodedResponse();
    }

    /**
     * @param array<mixed> $times
     *
     * @return list<array<string, mixed>>
     */
    private static function slots(array $times): array
    {
        self::assertIsArray($times['slots']);

        /** @var list<array<string, mixed>> */
        return $times['slots'];
    }

    /**
     * @param array<mixed> $times
     *
     * @return list<mixed>
     */
    private static function starts(array $times): array
    {
        return array_column(self::slots($times), 'start');
    }

    /**
     * @phpstan-impure
     *
     * @return list<array<string, mixed>>
     */
    private function violations(): array
    {
        $violations = $this->decodedResponse()['violations'] ?? null;
        self::assertIsArray($violations);

        /** @var list<array<string, mixed>> */
        return $violations;
    }

    /**
     * An event in Amsterdam time in the Tresso calendar (unless the overrides say otherwise); returns its id.
     *
     * @param array<string, mixed> $overrides
     */
    private function createEvent(string $summary, ?string $start, ?string $end, array $overrides = []): string
    {
        $times = null === $start || null === $end ? [] : [
            'start' => ['dateTime' => $start, 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => $end, 'timeZone' => 'Europe/Amsterdam'],
        ];
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId, [...$times, 'summary' => $summary, ...$overrides]), $this->kim);
        self::assertResponseStatusCodeSame(201);

        return $this->responseString('id');
    }

    /**
     * @return array{string, array<string, string>} the account id and the worker's headers
     */
    private function connectAccount(): array
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@company.example',
            'displayName' => 'Kim Visser',
            'username' => 'kim@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        $accountId = $this->responseString('id');

        $worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $worker);
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$accountId.'/folders', ['workerId' => 'w1', 'folders' => [
            ['remoteName' => 'INBOX', 'displayName' => 'Inbox', 'role' => 'inbox', 'uidValidity' => 1],
        ]], $worker);
        self::assertResponseIsSuccessful();

        return [$accountId, $worker];
    }

    /**
     * The worker reports a message in the inbox and the invitation it carries is applied; returns its id.
     *
     * @param array<string, string> $worker
     * @param list<string>          $to
     */
    private function deliver(string $accountId, array $worker, string $subject, string $from, array $to, ?string $ical = null): string
    {
        $uid = ++$this->uid;
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$accountId.'/messages', ['workerId' => 'w1', 'folder' => 'INBOX', 'messages' => [[
            'remoteUid' => (string) $uid,
            'rawObjectKey' => $this->rawKeyFor($accountId, $subject.$uid),
            'keyVersion' => 1,
            'size' => 100,
            // After the account was connected, so invitations are applied.
            'receivedAt' => new \DateTimeImmutable('+1 minute')->format(\DATE_ATOM),
            'messageId' => '<assistant-'.$uid.'@finance.example>',
            'subject' => $subject,
            'from' => ['address' => $from, 'name' => null],
            'to' => array_map(static fn (string $address): array => ['address' => $address], $to),
            'calendarParts' => null === $ical ? [] : [['method' => null, 'ical' => $ical]],
        ]]], $worker);
        self::assertResponseIsSuccessful();
        // Before the next request, which empties the queue.
        $this->applyQueuedInvitations();

        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['messages']);
        foreach ($delta['messages'] as $message) {
            if (\is_array($message) && $message['subject'] === $subject && \is_string($message['id'])) {
                return $message['id'];
            }
        }
        self::fail('The message was not stored.');
    }

    private static function invitation(): string
    {
        return implode("\r\n", [
            'BEGIN:VCALENDAR', 'PRODID:-//Example//EN', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT',
            'UID:budget-review@finance.example', 'SEQUENCE:0', 'DTSTAMP:20261019T080000Z',
            'DTSTART;TZID=Europe/Amsterdam:20270324T140000', 'DTEND;TZID=Europe/Amsterdam:20270324T150000',
            'SUMMARY:Budget review', 'LOCATION:Room 3',
            'ORGANIZER;CN=Anna de Vries:mailto:anna@finance.example',
            'ATTENDEE;CN=Kim Visser;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;ROLE=REQ-PARTICIPANT:mailto:kim@company.example',
            'ATTENDEE;PARTSTAT=ACCEPTED:mailto:anna@finance.example',
            'END:VEVENT', 'END:VCALENDAR', '',
        ]);
    }
}
