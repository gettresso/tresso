<?php

declare(strict_types=1);

namespace App\Tests\Functional\Notification;

use App\Entity\ScheduledNotification;
use App\Notification\NotificationDeliverer;
use App\Notification\NotificationDispatcher;
use App\Notification\NotificationHandlers;
use App\Notification\PlanCalendarObject;
use App\Notification\PlanUserNotifications;
use App\Notification\SweepNotifications;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\Calendar\CalendarTestHelpers;
use App\Tests\Functional\DatabaseTestCase;
use App\Tests\Support\MockHttpRouter;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;
use Symfony\Component\Mime\Email;
use Symfony\Component\Uid\Uuid;

final class NotificationTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use CalendarTestHelpers;

    private const string PUSH_ENDPOINT = 'https://push.example.test/subscriptions/1';
    private const string PUSH_ENDPOINT_2 = 'https://push.example.test/subscriptions/2';
    // A subscription key pair made for these tests (P-256 public point and auth secret).
    private const string P256DH = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
    private const string AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
    private const string EXPO_TOKEN = 'ExponentPushToken[abc123]';

    /** @var array<string, string> */
    private array $kim;

    private string $calendarId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', ['mail:read', 'mail:send', 'calendar:read', 'calendar:write', 'settings:read', 'settings:write']);
        $this->calendarId = $this->localCalendarId($this->kim);
    }

    public function testNewUsersStartWithDefaultRulesAndSettings(): void
    {
        $rules = $this->getJson('/api/v1/reminder-rules', $this->kim);
        self::assertSame(['Timed events', 'All-day events'], array_column($rules, 'name'));
        self::assertSame([[['minutesBefore' => 10, 'dayBeforeAt' => null, 'channels' => ['phone', 'desktop']]], [['minutesBefore' => null, 'dayBeforeAt' => '09:00', 'channels' => ['phone', 'desktop']]]], array_column($rules, 'reminders'));

        $settings = $this->getJson('/api/v1/notification-settings', $this->kim);
        self::assertFalse($settings['quietHoursEnabled']);
        self::assertSame('kim@example.test', $settings['effectiveEmailAddress']);
        self::assertNotNull($this->getJson('/api/v1/notification-devices/web-push-key', $this->kim)['publicKey']);
    }

    public function testPlansTheDefaultReminderOfAnEvent(): void
    {
        $start = $this->inMinutes(2 * 24 * 60);
        $this->createEvent($start);

        $planned = $this->notifications();
        self::assertCount(1, $planned);
        self::assertSame('reminder', $planned[0]['kind']);
        self::assertSame(['phone', 'desktop'], $planned[0]['channels']);
        self::assertSame($start->modify('-10 minutes')->format(\DATE_ATOM), $this->atom($planned[0]['fireAt']));
        self::assertNull($planned[0]['deliveredAt']);
    }

    public function testDeliversOnceToEveryDeviceAndByEmail(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(6), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone', 'desktop', 'email']]]]);
        $id = $this->onlyNotificationId();

        $this->fire($id);
        $this->fire($id);

        $pushes = array_values(array_filter($this->http()->calls(), static fn (array $call): bool => self::PUSH_ENDPOINT === $call['url']));
        self::assertCount(1, $pushes, 'A device is notified once, however often the notification fires.');
        self::assertContains('Content-Encoding: aes128gcm', $pushes[0]['headers']);
        self::assertNotEmpty(array_filter($pushes[0]['headers'], static fn (string $header): bool => str_starts_with($header, 'Authorization: vapid t=')));

        $expo = array_values(array_filter($this->http()->calls(), static fn (array $call): bool => str_starts_with($call['url'], 'https://exp.host/')));
        self::assertCount(1, $expo);
        $body = json_decode($expo[0]['body'], true, flags: \JSON_THROW_ON_ERROR);
        self::assertIsArray($body);
        self::assertSame(self::EXPO_TOKEN, $body['to']);
        self::assertSame('Standup', $body['title']);
        self::assertSame('default', $body['sound']);
        self::assertSame('reminders', $body['channelId']);
        self::assertIsArray($body['data']);
        $kim = static::getContainer()->get(\App\Repository\UserRepository::class)->findOneBy(['email' => 'kim@example.test']) ?? self::fail('No user.');
        self::assertSame($kim->getId()->toRfc4122(), $body['data']['userId'], 'A browser shows a push only for the user who turned notifications on there.');

        self::assertEmailCount(1);
        self::assertEmailHeaderSame(self::getMailerMessage() ?? self::fail('No email.'), 'Subject', 'Standup');

        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['notifications']);
        self::assertSame([$id], array_column($delta['notifications'], 'id'), 'The desktop app finds the delivered notification in the delta.');
    }

    public function testAReminderForThePhoneReachesOnlyThePhone(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(6), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);

        $this->fire($this->onlyNotificationId());

        self::assertCount(1, array_filter($this->http()->calls(), static fn (array $call): bool => str_starts_with($call['url'], 'https://exp.host/')));
        self::assertCount(0, array_filter($this->http()->calls(), static fn (array $call): bool => self::PUSH_ENDPOINT === $call['url']));
        self::assertEmailCount(0);
    }

    public function testTheUserChoosesTheChannelsPerKindOfNotification(): void
    {
        $this->patchSettings(['channelsByKind' => ['leave_now' => ['phone', 'email'], 'brief' => []]]);
        self::assertEquals(['leave_now' => ['phone', 'email'], 'brief' => []], $this->getJson('/api/v1/notification-settings', $this->kim)['channelsByKind']);

        $this->patchSettings(['channelsByKind' => ['brief' => null]]);
        self::assertEquals(['leave_now' => ['phone', 'email']], $this->getJson('/api/v1/notification-settings', $this->kim)['channelsByKind'], 'Null goes back to the default.');

        $this->createEvent($this->inMinutes(3 * 60), ['location' => 'Herengracht 1, Amsterdam', 'travelMinutes' => 20]);
        $leave = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'leave_now' === $n['kind']));
        self::assertSame(['phone', 'email'], $leave[0]['channels']);
    }

    public function testRefusesUnknownChannels(): void
    {
        $this->client->request('PATCH', '/api/v1/notification-settings', server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['channelsByKind' => ['brief' => ['pager']]], \JSON_THROW_ON_ERROR));
        self::assertResponseStatusCodeSame(422);
    }

    public function testChannelsAreChosenOnlyForKindsThatUseThem(): void
    {
        // Reminders carry their own channels; an unknown kind would only pile up.
        foreach (['reminder', 'anything_else'] as $kind) {
            $this->client->request('PATCH', '/api/v1/notification-settings', server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['channelsByKind' => [$kind => ['phone']]], \JSON_THROW_ON_ERROR));
            self::assertResponseStatusCodeSame(422, $kind);
        }
    }

    public function testForgetsSubscriptionsThePushServiceNoLongerKnows(): void
    {
        $this->registerDevices();
        $this->http()->respond(self::PUSH_ENDPOINT, '', 410);
        $this->createEvent($this->inMinutes(12));

        $this->fire($this->onlyNotificationId());

        self::assertSame(['expo', 'desktop'], array_column($this->getJson('/api/v1/notification-devices', $this->kim), 'kind'));
    }

    public function testQuietHoursMoveAReminderToTheirEndOrDeliverItSilently(): void
    {
        $this->registerDevices();
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $this->patchSettings(['timeZone' => 'UTC', 'quietHoursEnabled' => true, 'quietStart' => $now->modify('-1 hour')->format('H:i'), 'quietEnd' => $now->modify('+1 hour')->format('H:i')]);

        $this->createEvent($this->inMinutes(11), ['summary' => 'During quiet hours']);
        // Its reminder falls in the quiet hours, the event itself after them.
        $this->createEvent($this->inMinutes(90), ['summary' => 'After quiet hours', 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 60, 'channels' => ['phone', 'desktop']]]]);
        $byTitle = array_column($this->notifications(), null, 'title');

        $this->fire(self::string($byTitle['During quiet hours']['id']));
        $this->fire(self::string($byTitle['After quiet hours']['id']));

        $byTitle = array_column($this->notifications(), null, 'title');
        self::assertNotNull($byTitle['During quiet hours']['deliveredAt']);
        self::assertTrue($byTitle['During quiet hours']['silent']);
        self::assertNull($byTitle['After quiet hours']['deliveredAt']);
        self::assertSame($now->modify('+1 hour')->format('Y-m-d\TH:i'), substr($this->atom($byTitle['After quiet hours']['fireAt']), 0, 16), 'It waits for the end of the quiet hours.');
        $pushes = array_filter($this->http()->calls(), static fn (array $call): bool => self::PUSH_ENDPOINT === $call['url']);
        self::assertCount(1, $pushes);
        self::assertContains('Urgency: low', array_values($pushes)[0]['headers'], 'A quiet notification asks for no attention.');
    }

    public function testFocusQuietsInvitationsDuringABusyMeetingButNotOwnMeetings(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(-10), ['summary' => 'Workshop']);
        $start = $this->inMinutes(11)->format('Ymd\THis\Z');
        $this->storeInvitation('call@finance.example', 'Call with Anna', $start);

        $call = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'Call with Anna' === $n['title']));
        self::assertCount(1, $call);
        $this->fire(self::string($call[0]['id']));

        $call = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'Call with Anna' === $n['title']));
        self::assertNotNull($call[0]['deliveredAt']);
        self::assertTrue($call[0]['silent'], 'The user is in the workshop.');

        $this->createEvent($this->inMinutes(11), ['summary' => 'Planning']);
        $own = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'Planning' === $n['title']));
        $this->fire(self::string($own[0]['id']));
        $own = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'Planning' === $n['title']));
        self::assertNotNull($own[0]['deliveredAt']);
        self::assertFalse($own[0]['silent'], 'The user\'s own meetings break through.');
    }

    public function testDismissedOnOneDeviceAndSnoozedForLater(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(11));
        $id = $this->onlyNotificationId();
        $this->fire($id);

        $this->client->jsonRequest('POST', '/api/v1/notifications/'.$id.'/snooze', ['minutes' => 5], $this->kim);
        self::assertResponseIsSuccessful();
        self::assertNull($this->decodedResponse()['deliveredAt']);
        $this->fire($id, new \DateTimeImmutable('+5 minutes'));
        $pushes = array_filter($this->http()->calls(), static fn (array $call): bool => self::PUSH_ENDPOINT === $call['url']);
        self::assertCount(2, $pushes, 'A snoozed notification is delivered again.');

        $this->client->jsonRequest('POST', '/api/v1/notifications/'.$id.'/dismiss', [], $this->kim);
        self::assertResponseIsSuccessful();
        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['notifications']);
        self::assertNotContains(null, array_column($delta['notifications'], 'dismissedAt'));
        self::assertCount(1, $delta['notifications']);
    }

    public function testLeaveNowUsesTheTravelTime(): void
    {
        $start = $this->inMinutes(2 * 24 * 60);
        $this->createEvent($start, ['location' => 'Café Loos, Amsterdam', 'travelMinutes' => 20]);

        $leave = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'leave_now' === $n['kind']));
        self::assertCount(1, $leave);
        self::assertSame($start->modify('-25 minutes')->format(\DATE_ATOM), $this->atom($leave[0]['fireAt']));
        self::assertSame('Leave now: about 20 minutes to Café Loos, Amsterdam.', $leave[0]['body']);
    }

    public function testRulesAddTheBriefAndTheFollowUpForMeetings(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/reminder-rules', [
            'name' => 'Meetings',
            'allDay' => false,
            'withAttendees' => true,
            'reminders' => [['minutesBefore' => 15, 'channels' => ['phone', 'desktop']]],
            'briefMinutes' => 10,
            'followUp' => true,
        ], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $this->runQueuedPlanning();

        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => 'kim@company.example',
            'displayName' => 'Kim Visser',
            'username' => 'kim@company.example',
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.company.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.company.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        $accountId = $this->responseString('id');

        $start = $this->inMinutes(2 * 24 * 60);
        $this->createEvent($start, ['summary' => 'Budget review', 'attendees' => [['address' => 'anna@finance.example', 'name' => 'Anna de Vries']], 'organizerMailAccountId' => $accountId]);
        $this->createEvent($start->modify('+2 hours'), ['summary' => 'Focus time']);

        $byKind = [];
        foreach ($this->notifications() as $notification) {
            $byKind[self::string($notification['title']).'/'.self::string($notification['kind'])] = $notification;
        }
        self::assertSame(['Budget review/reminder', 'Brief: Budget review/brief', 'After: Budget review/follow_up', 'Focus time/reminder'], array_keys($byKind));
        self::assertSame($start->modify('-15 minutes')->format(\DATE_ATOM), $this->atom($byKind['Budget review/reminder']['fireAt']));
        self::assertSame($start->modify('+30 minutes')->format(\DATE_ATOM), $this->atom($byKind['After: Budget review/follow_up']['fireAt']));
        self::assertSame($start->modify('+2 hours -10 minutes')->format(\DATE_ATOM), $this->atom($byKind['Focus time/reminder']['fireAt']), 'Without other people the meeting rule does not apply.');

        $brief = self::string($byKind['Brief: Budget review/brief']['id']);
        $this->fire($brief);
        $delivered = array_values(array_filter($this->notifications(), static fn (array $n): bool => $n['id'] === $brief));
        self::assertSame('With Anna de Vries.', $delivered[0]['body']);
    }

    public function testSettingsHoldWorkingHoursFocusTravelAndSnoozeChoices(): void
    {
        $settings = $this->getJson('/api/v1/notification-settings', $this->kim);
        self::assertSame([[1, 2, 3, 4, 5], '09:00', '17:30', true, true, true, true, true, 'car', 5, ['minutes_5', 'before_start', 'start', 'meeting_end']], [
            $settings['workDays'], $settings['workStart'], $settings['workEnd'], $settings['shiftEarlyReminders'], $settings['workCalendarsQuiet'],
            $settings['holdDuringFocus'], $settings['holdMailInMeetings'], $settings['leaveNow'], $settings['travelMode'], $settings['extraTravelMinutes'], $settings['snoozeChoices'],
        ]);

        $this->patchSettings(['workDays' => [2, 1], 'workStart' => '08:30', 'travelMode' => 'bike', 'extraTravelMinutes' => 10, 'snoozeChoices' => ['start', 'minutes_10'], 'holdMailInMeetings' => false]);

        $settings = $this->getJson('/api/v1/notification-settings', $this->kim);
        self::assertSame([[1, 2], '08:30', 'bike', 10, ['start', 'minutes_10'], false], [$settings['workDays'], $settings['workStart'], $settings['travelMode'], $settings['extraTravelMinutes'], $settings['snoozeChoices'], $settings['holdMailInMeetings']]);
    }

    public function testEarlyRemindersOfWorkCalendarsComeAtTheEndOfTheWorkingDayBefore(): void
    {
        $this->patchSettings(['timeZone' => 'Europe/Amsterdam', 'workDays' => [1, 2, 3, 4, 5, 6, 7]]);
        $this->markWork();
        $day = new \DateTimeImmutable('+3 days', new \DateTimeZone('Europe/Amsterdam'));
        $start = $day->setTime(8, 0);

        $this->createEvent($start->setTimezone(new \DateTimeZone('UTC')));

        self::assertSame($day->modify('-1 day')->setTime(17, 30)->format(\DATE_ATOM), $this->atom($this->notifications()[0]['fireAt'], 'Europe/Amsterdam'));
    }

    public function testWorkCalendarsWaitForWorkingHoursUnlessTheEventIsImportant(): void
    {
        $this->registerDevices();
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $this->patchSettings(['workDays' => [1, 2, 3, 4, 5, 6, 7], 'workStart' => $now->modify('+2 hours')->format('H:i'), 'workEnd' => $now->modify('+3 hours')->format('H:i')]);
        $this->markWork();
        $this->createEvent($this->inMinutes(4 * 60), ['summary' => 'Review', 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 3 * 60 + 55, 'channels' => ['phone', 'desktop']]]]);
        $this->createEvent($this->inMinutes(4 * 60), ['summary' => 'Release', 'important' => true, 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 3 * 60 + 55, 'channels' => ['phone', 'desktop']]]]);

        foreach ($this->notifications() as $notification) {
            $this->fire(self::string($notification['id']), $now->modify('+5 minutes'));
        }

        $byTitle = array_column($this->notifications(), null, 'title');
        self::assertNull($byTitle['Review']['deliveredAt'], 'Outside working hours it waits.');
        self::assertSame($now->modify('+2 hours')->format('Y-m-d\TH:i'), substr($this->atom($byTitle['Review']['fireAt']), 0, 16));
        self::assertNotNull($byTitle['Release']['deliveredAt'], 'An important event comes through.');
        self::assertFalse($byTitle['Release']['silent']);
    }

    public function testAFocusBlockHoldsNotificationsUntilItEnds(): void
    {
        $this->registerDevices();
        $blockStart = $this->inMinutes(-10);
        $this->createEvent($blockStart, ['summary' => 'Focus: budget', 'end' => ['dateTime' => $blockStart->modify('+60 minutes')->setTimezone(new \DateTimeZone('Europe/Amsterdam'))->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam']]);
        $this->createEvent($this->inMinutes(2 * 60), ['summary' => 'Dentist', 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 115, 'channels' => ['phone']]]]);

        $dentist = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'Dentist' === $n['title']));
        $this->fire(self::string($dentist[0]['id']));

        $dentist = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'Dentist' === $n['title']));
        self::assertNull($dentist[0]['deliveredAt']);
        self::assertSame($blockStart->modify('+60 minutes')->format(\DATE_ATOM), $this->atom($dentist[0]['fireAt']));
    }

    public function testLeaveNowAsksThePhoneAndMovesToItsEstimate(): void
    {
        $this->registerDevices();
        $this->client->jsonRequest('POST', '/api/v1/reminder-rules', ['name' => 'Places', 'allDay' => false, 'withLocation' => true, 'reminders' => [], 'leaveNow' => true], $this->kim);
        self::assertResponseStatusCodeSame(201);
        $this->runQueuedPlanning();
        $start = $this->inMinutes(90);
        $eventId = $this->createEvent($start, ['location' => 'Herengracht 1, Amsterdam']);
        $leave = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'leave_now' === $n['kind']));
        self::assertSame($start->modify('-60 minutes')->format(\DATE_ATOM), $this->atom($leave[0]['fireAt']), 'It waits for the phone from an hour before.');

        $this->fire(self::string($leave[0]['id']));

        $expo = array_values(array_filter($this->http()->calls(), static fn (array $call): bool => str_starts_with($call['url'], 'https://exp.host/')));
        self::assertCount(1, $expo);
        $ask = json_decode($expo[0]['body'], true, flags: \JSON_THROW_ON_ERROR);
        self::assertIsArray($ask);
        self::assertArrayNotHasKey('title', $ask, 'Asked silently.');
        self::assertIsArray($ask['data']);
        self::assertSame(['leave_estimate', $eventId], [$ask['data']['kind'], $ask['data']['eventId']]);
        self::assertCount(0, array_filter($this->http()->calls(), static fn (array $call): bool => self::PUSH_ENDPOINT === $call['url']), 'Only the phone is asked.');

        $this->http()->respond('https://nominatim.example.test/search', json_encode([['lat' => '52.360000', 'lon' => '4.880000']], \JSON_THROW_ON_ERROR));
        $this->http()->respond('https://osrm.example.test/route/v1/driving/4.890000,52.370000;4.880000,52.360000', json_encode(['routes' => [['duration' => 1200]]], \JSON_THROW_ON_ERROR));
        $this->client->jsonRequest('POST', '/api/v1/calendar-events/'.$eventId.'/leave-estimate', ['latitude' => 52.37, 'longitude' => 4.89], $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame(20, $this->decodedResponse()['minutes']);

        $leave = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'leave_now' === $n['kind']));
        self::assertSame($start->modify('-25 minutes')->format(\DATE_ATOM), $this->atom($leave[0]['fireAt']));
        self::assertSame('Leave now: about 20 minutes to Herengracht 1, Amsterdam.', $leave[0]['body']);
        $this->fire(self::string($leave[0]['id']));
        $leave = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'leave_now' === $n['kind']));
        self::assertNotNull($leave[0]['deliveredAt']);
    }

    public function testSnoozesUntilTheStartButNotIntoThePast(): void
    {
        $this->registerDevices();
        $start = $this->inMinutes(30);
        $this->createEvent($start, ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 25, 'channels' => ['phone']]]]);
        $id = $this->onlyNotificationId();
        $this->fire($id);

        $this->client->jsonRequest('POST', '/api/v1/notifications/'.$id.'/snooze', ['until' => 'start'], $this->kim);
        self::assertResponseIsSuccessful();
        self::assertSame($start->format(\DATE_ATOM), $this->atom($this->decodedResponse()['fireAt']));

        $this->client->jsonRequest('POST', '/api/v1/notifications/'.$id.'/snooze', ['until' => 'meeting_end'], $this->kim);
        self::assertResponseStatusCodeSame(422, 'Not in a meeting now.');
    }

    public function testASnoozeSurvivesAReplan(): void
    {
        $this->registerDevices();
        $eventId = $this->createEvent($this->inMinutes(30), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 25, 'channels' => ['phone']]]]);
        $id = $this->onlyNotificationId();
        $this->fire($id);
        $this->client->jsonRequest('POST', '/api/v1/notifications/'.$id.'/snooze', ['minutes' => 15], $this->kim);
        $snoozedUntil = $this->atom($this->decodedResponse()['fireAt']);

        // Any change of the event replans it (a provider sync does the same).
        $this->updateEvent($eventId, $this->inMinutes(30), ['summary' => 'Standup, renamed', 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 25, 'channels' => ['phone']]]]);

        $notification = $this->notifications()[0];
        self::assertSame($snoozedUntil, $this->atom($notification['fireAt']), 'The replan does not pull the snooze back to the past fire time.');
        self::assertNull($notification['deliveredAt']);
    }

    public function testAPostponementSurvivesAReplan(): void
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $this->patchSettings(['quietHoursEnabled' => true, 'quietDays' => [1, 2, 3, 4, 5, 6, 7], 'quietStart' => $now->modify('-1 hour')->format('H:i'), 'quietEnd' => $now->modify('+1 hour')->format('H:i')]);
        $eventId = $this->createEvent($this->inMinutes(3 * 60), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 175, 'channels' => ['phone']]]]);
        $this->fire($this->onlyNotificationId(), $now->modify('+5 minutes'));
        $postponed = $this->atom($this->notifications()[0]['fireAt']);
        self::assertSame($now->modify('+1 hour')->format('Y-m-d\TH:i'), substr($postponed, 0, 16));

        $this->updateEvent($eventId, $this->inMinutes(3 * 60), ['summary' => 'Renamed', 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 175, 'channels' => ['phone']]]]);

        self::assertSame($postponed, $this->atom($this->notifications()[0]['fireAt']));
    }

    public function testAnEventMovedAfterItsReminderGetsANewOne(): void
    {
        $this->registerDevices();
        $eventId = $this->createEvent($this->inMinutes(8), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);
        $id = $this->onlyNotificationId();
        $this->fire($id);

        $later = $this->inMinutes(3 * 60);
        $this->updateEvent($eventId, $later, ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);

        $notification = $this->notifications()[0];
        self::assertSame($id, $notification['id']);
        self::assertNull($notification['deliveredAt'], 'A new round for the new time.');
        self::assertSame($later->modify('-5 minutes')->format(\DATE_ATOM), $this->atom($notification['fireAt']));
        $this->fire($id);
        self::assertCount(2, array_filter($this->http()->calls(), static fn (array $call): bool => str_starts_with($call['url'], 'https://exp.host/')), 'Delivered again for the new time.');
    }

    public function testASnoozeSurvivesTheOccurrenceGettingItsOwnRow(): void
    {
        $this->registerDevices();
        $start = $this->inMinutes(30);
        $eventId = $this->createEvent($start, ['recurrence' => 'FREQ=DAILY;COUNT=2', 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 25, 'channels' => ['phone']]]]);
        $id = $this->notificationFor($start);
        $this->fire($id);
        $this->client->jsonRequest('POST', '/api/v1/notifications/'.$id.'/snooze', ['minutes' => 15], $this->kim);
        $snoozedUntil = $this->atom($this->decodedResponse()['fireAt']);

        // The organizer renames this one occurrence: it gets an override row of its own.
        $this->editOccurrence($eventId, $start, ['summary' => 'Standup, moved room']);

        $notification = $this->notificationsFor($start);
        self::assertCount(1, $notification);
        self::assertSame($id, $notification[0]['id']);
        self::assertSame($snoozedUntil, $this->atom($notification[0]['fireAt']), 'The snooze still holds.');
        self::assertSame('Standup, moved room', $notification[0]['title']);
    }

    public function testASnoozeSurvivesTheOccurrenceLosingItsOwnRow(): void
    {
        $this->registerDevices();
        $start = $this->inMinutes(30);
        $this->storeSeries($start, true, 25);
        $id = $this->notificationFor($start);
        $this->fire($id);
        $this->client->jsonRequest('POST', '/api/v1/notifications/'.$id.'/snooze', ['minutes' => 15], $this->kim);
        $snoozedUntil = $this->atom($this->decodedResponse()['fireAt']);

        // The organizer edits the whole series and the provider drops the exception.
        $this->storeSeries($start, false, 25);

        $notification = $this->notificationsFor($start);
        self::assertCount(1, $notification);
        self::assertSame($id, $notification[0]['id']);
        self::assertSame($snoozedUntil, $this->atom($notification[0]['fireAt']), 'The snooze still holds.');
    }

    public function testADeliveredReminderIsNotSentAgainWhenItsOccurrenceLosesItsOwnRow(): void
    {
        $this->registerDevices();
        $start = $this->inMinutes(6);
        $this->storeSeries($start, true, 5);
        $this->fire($this->notificationFor($start));

        $this->storeSeries($start, false, 5);
        foreach ($this->notificationsFor($start) as $notification) {
            $this->fire(self::string($notification['id']));
        }

        self::assertCount(1, array_filter($this->http()->calls(), static fn (array $call): bool => str_starts_with($call['url'], 'https://exp.host/')));
    }

    public function testADeliveredReminderIsNotSentAgainWhenItsOccurrenceGetsItsOwnRow(): void
    {
        $this->registerDevices();
        $start = $this->inMinutes(6);
        $eventId = $this->createEvent($start, ['recurrence' => 'FREQ=DAILY;COUNT=2', 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);
        $this->fire($this->notificationFor($start));

        $this->editOccurrence($eventId, $start, ['summary' => 'Standup, moved room', 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);
        foreach ($this->notificationsFor($start) as $notification) {
            $this->fire(self::string($notification['id']));
        }

        self::assertCount(1, array_filter($this->http()->calls(), static fn (array $call): bool => str_starts_with($call['url'], 'https://exp.host/')));
    }

    public function testAnAllDayReminderIsNotSentAgainWhenTheUserChangesZone(): void
    {
        $this->registerDevices();
        $this->patchSettings(['timeZone' => 'Europe/Amsterdam']);
        $day = new \DateTimeImmutable('+2 days', new \DateTimeZone('Europe/Amsterdam'))->setTime(0, 0);
        $minutes = intdiv($day->getTimestamp() - $this->inMinutes(1)->getTimestamp(), 60);
        $this->createEvent($day, [
            'start' => ['date' => $day->format('Y-m-d')],
            'end' => ['date' => $day->modify('+1 day')->format('Y-m-d')],
            'useDefaultReminders' => false,
            'reminders' => [['minutesBefore' => $minutes, 'channels' => ['phone']]],
        ]);
        $this->fire($this->onlyNotificationId());

        $this->patchSettings(['timeZone' => 'America/New_York']);
        $this->runQueuedPlanning();

        self::assertNotNull($this->notifications()[0]['deliveredAt'], 'Still the same day: not a new round.');
    }

    public function testAHoldIsLetGoWhenTheEventMovesBeforeIt(): void
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $this->patchSettings(['quietHoursEnabled' => true, 'quietDays' => [1, 2, 3, 4, 5, 6, 7], 'quietStart' => $now->modify('-1 hour')->format('H:i'), 'quietEnd' => $now->modify('+1 hour')->format('H:i')]);
        $eventId = $this->createEvent($this->inMinutes(3 * 60), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 175, 'channels' => ['phone']]]]);
        $this->fire($this->onlyNotificationId(), $now->modify('+5 minutes'));
        self::assertSame($now->modify('+1 hour')->format('Y-m-d\TH:i'), substr($this->atom($this->notifications()[0]['fireAt']), 0, 16), 'Held until the quiet hours end.');

        $earlier = $this->inMinutes(40);
        $this->updateEvent($eventId, $earlier, ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 35, 'channels' => ['phone']]]]);

        self::assertSame($earlier->modify('-35 minutes')->format(\DATE_ATOM), $this->atom($this->notifications()[0]['fireAt']), 'Not held past the new start.');
    }

    public function testAFailedSendIsTriedAgainAndASentOneNever(): void
    {
        $this->registerDevices();
        $this->http()->respondOnce(self::PUSH_ENDPOINT, '', 500);
        $this->createEvent($this->inMinutes(6), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone', 'desktop']]]]);
        $id = $this->onlyNotificationId();
        $this->fire($id);
        self::assertSame(['failed', 'sent', 'sent'], $this->deliveryStatuses(), 'Web push failed; the phone and the desktop app got it.');

        $this->sweep();
        self::assertCount(1, $this->pushesTo(self::PUSH_ENDPOINT), 'Not again before the pause is over.');

        $this->connection()->executeStatement("UPDATE notification_delivery SET updated_at = updated_at - INTERVAL '5 minutes'");
        $this->sweep();

        self::assertCount(2, $this->pushesTo(self::PUSH_ENDPOINT));
        self::assertCount(1, array_filter($this->http()->calls(), static fn (array $call): bool => str_starts_with($call['url'], 'https://exp.host/')), 'What went out is never sent again.');
        self::assertSame(['sent', 'sent', 'sent'], $this->deliveryStatuses());
    }

    public function testASendThatNeverReportedBackIsTriedAgain(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(6), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['desktop']]]]);
        $this->fire($this->onlyNotificationId());
        // As after a crash between claiming and sending.
        $this->connection()->executeStatement("UPDATE notification_delivery SET status = 'sending', updated_at = updated_at - INTERVAL '11 minutes'");

        $this->sweep();

        self::assertCount(2, $this->pushesTo(self::PUSH_ENDPOINT));
        self::assertSame(['sent', 'sent'], $this->deliveryStatuses());
    }

    public function testOneNotificationThatFailsDoesNotStopTheSweep(): void
    {
        $this->createEvent($this->inMinutes(30));
        $kims = $this->onlyNotificationId();
        $this->patchSettings(['quietHoursEnabled' => true]);
        // A zone the database holds but PHP does not know makes quiet hours fail for Kim.
        $this->connection()->executeStatement("UPDATE notification_preferences SET time_zone = 'Mars/Olympus' FROM app_user u WHERE u.id = notification_preferences.user_id AND u.email = 'kim@example.test'");
        $this->createUser('lisa@example.test', 'Lisa');
        $lisa = $this->userHeaders('lisa@example.test', ['calendar:read', 'calendar:write', 'settings:read', 'settings:write']);
        $start = $this->inMinutes(30)->setTimezone(new \DateTimeZone('Europe/Amsterdam'));
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->localCalendarId($lisa), [
            'summary' => 'Lisa\'s call',
            'start' => ['dateTime' => $start->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => $start->modify('+30 minutes')->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
        ]), $lisa);
        self::assertResponseStatusCodeSame(201);
        $this->runQueuedPlanning();
        $this->connection()->executeStatement("UPDATE scheduled_notification SET fire_at = NOW() AT TIME ZONE 'UTC' - CASE WHEN id = :kim THEN INTERVAL '3 minutes' ELSE INTERVAL '1 minute' END", ['kim' => $kims]);

        $this->sweep();

        $delivered = $this->connection()->fetchAllKeyValue('SELECT title, delivered_at IS NOT NULL FROM scheduled_notification ORDER BY title');
        self::assertEquals(["Lisa's call" => true, 'Standup' => false], $delivered, 'Kim\'s failure does not hold up Lisa\'s reminder.');
        self::assertGreaterThan(new \DateTimeImmutable('+4 minutes'), new \DateTimeImmutable(self::string($this->connection()->fetchOne('SELECT fire_at FROM scheduled_notification WHERE id = :id', ['id' => $kims])), new \DateTimeZone('UTC')), 'Kim\'s waits before the next try.');
    }

    public function testADeliveryCutOffBeforeItsSendsIsTriedAgain(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(6), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);
        $id = $this->onlyNotificationId();
        // The claim fails right after the notification is marked delivered, as a crash there would.
        $this->connection()->executeStatement('ALTER TABLE notification_delivery RENAME TO notification_delivery_away');
        try {
            $this->fire($id);
            self::fail('The claim should have failed.');
        } catch (\Doctrine\DBAL\Exception) {
        }
        static::getContainer()->get('doctrine')->resetManager();
        $this->connection()->executeStatement('ALTER TABLE notification_delivery_away RENAME TO notification_delivery');

        $this->connection()->executeStatement('UPDATE scheduled_notification SET fire_at = :past WHERE id = :id', ['past' => new \DateTimeImmutable('-1 minute')->format('Y-m-d H:i:s'), 'id' => $id]);
        $this->sweep();

        self::assertCount(1, array_filter($this->http()->calls(), static fn (array $call): bool => str_starts_with($call['url'], 'https://exp.host/')));
    }

    public function testARetryDoesNotReachDevicesRegisteredSince(): void
    {
        $this->registerDevices();
        $this->http()->respondOnce(self::PUSH_ENDPOINT, '', 500);
        $this->createEvent($this->inMinutes(6), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['desktop']]]]);
        $this->fire($this->onlyNotificationId());
        $this->http()->respond(self::PUSH_ENDPOINT_2, '', 201);
        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'web_push', 'endpoint' => self::PUSH_ENDPOINT_2, 'publicKey' => self::P256DH, 'authSecret' => self::AUTH, 'name' => 'Chrome'], $this->kim);
        self::assertResponseIsSuccessful();

        $this->connection()->executeStatement("UPDATE notification_delivery SET updated_at = updated_at - INTERVAL '5 minutes'");
        $this->sweep();

        self::assertCount(2, $this->pushesTo(self::PUSH_ENDPOINT), 'The failed send is tried again.');
        self::assertCount(0, $this->pushesTo(self::PUSH_ENDPOINT_2), 'A browser added after the reminder came does not get it late.');
    }

    public function testStaleRemindersAreNotDelivered(): void
    {
        $this->registerDevices();
        $start = $this->inMinutes(10);
        $this->createEvent($start, ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);

        $this->fire($this->onlyNotificationId(), $start->modify('+30 minutes'));

        self::assertSame([], $this->http()->calls(), 'The event started half an hour ago.');
        self::assertSame([], $this->notifications());
    }

    public function testAFocusBlockNeverHoldsAReminderPastItsEvent(): void
    {
        $this->registerDevices();
        $blockStart = $this->inMinutes(-10);
        $this->createEvent($blockStart, ['summary' => 'Focus: budget', 'end' => ['dateTime' => $blockStart->modify('+60 minutes')->setTimezone(new \DateTimeZone('Europe/Amsterdam'))->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam']]);
        $this->createEvent($this->inMinutes(20), ['summary' => 'Call the bank', 'useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 15, 'channels' => ['phone']]]]);

        $call = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'Call the bank' === $n['title']));
        $this->fire(self::string($call[0]['id']));

        $call = array_values(array_filter($this->notifications(), static fn (array $n): bool => 'Call the bank' === $n['title']));
        self::assertNotNull($call[0]['deliveredAt'], 'It starts before the block ends.');
        self::assertTrue($call[0]['silent']);
        $expo = array_values(array_filter($this->http()->calls(), static fn (array $c): bool => str_starts_with($c['url'], 'https://exp.host/')));
        $body = json_decode($expo[0]['body'], true, flags: \JSON_THROW_ON_ERROR);
        self::assertIsArray($body);
        self::assertSame('reminders_silent', $body['channelId'], 'Silent on Android too.');
    }

    public function testASnoozeReachesTheOtherDevices(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(30), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 25, 'channels' => ['phone']]]]);
        $id = $this->onlyNotificationId();
        $this->fire($id);
        $cursor = $this->getJson('/api/v1/sync/changes?since=0', $this->kim)['cursor'];
        self::assertIsInt($cursor);

        $this->client->jsonRequest('POST', '/api/v1/notifications/'.$id.'/snooze', ['minutes' => 10], $this->kim);
        $delta = $this->getJson('/api/v1/sync/changes?since='.$cursor, $this->kim);

        self::assertIsArray($delta['notifications']);
        self::assertSame([$id], array_column($delta['notifications'], 'id'));
        $snoozed = $delta['notifications'][0];
        self::assertIsArray($snoozed);
        self::assertNull($snoozed['deliveredAt']);
        self::assertIsString($snoozed['snoozedUntil']);
    }

    public function testPlanningIsNoChangeForClientsUntilANotificationIsDelivered(): void
    {
        $eventId = $this->createEvent($this->inMinutes(60), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 10, 'channels' => ['phone']]]]);
        $this->updateEvent($eventId, $this->inMinutes(90), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 10, 'channels' => ['phone']]]]);

        self::assertEquals(0, $this->connection()->fetchOne('SELECT change_seq FROM scheduled_notification'), 'Planned and moved, never seen: no change number, so no sync for it.');

        $this->fire($this->onlyNotificationId());
        self::assertNotEquals(0, $this->connection()->fetchOne('SELECT change_seq FROM scheduled_notification'));
    }

    public function testQuietHoursMovingASnoozeReachTheOtherDevices(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(3 * 60), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 175, 'channels' => ['phone']]]]);
        $id = $this->onlyNotificationId();
        $this->fire($id);
        $this->client->jsonRequest('POST', '/api/v1/notifications/'.$id.'/snooze', ['minutes' => 10], $this->kim);
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $this->patchSettings(['quietHoursEnabled' => true, 'quietDays' => [1, 2, 3, 4, 5, 6, 7], 'quietStart' => $now->modify('-1 hour')->format('H:i'), 'quietEnd' => $now->modify('+1 hour')->format('H:i')]);
        $this->runQueuedPlanning();
        $cursor = $this->getJson('/api/v1/sync/changes?since=0', $this->kim)['cursor'];
        self::assertIsInt($cursor);

        $this->fire($id);

        $delta = $this->getJson('/api/v1/sync/changes?since='.$cursor, $this->kim);
        self::assertIsArray($delta['notifications']);
        self::assertSame([$id], array_column($delta['notifications'], 'id'));
        $moved = $delta['notifications'][0];
        self::assertIsArray($moved);
        self::assertSame($now->modify('+1 hour')->format('Y-m-d\TH:i'), substr($this->atom($moved['snoozedUntil']), 0, 16));
    }

    public function testAReminderWaitingForTheEventsNewTimeIsNotShownAsSnoozed(): void
    {
        $this->registerDevices();
        $eventId = $this->createEvent($this->inMinutes(8), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);
        $id = $this->onlyNotificationId();
        $this->fire($id);
        $cursor = $this->getJson('/api/v1/sync/changes?since=0', $this->kim)['cursor'];
        self::assertIsInt($cursor);

        $this->updateEvent($eventId, $this->inMinutes(3 * 60), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);

        $delta = $this->getJson('/api/v1/sync/changes?since='.$cursor, $this->kim);
        self::assertIsArray($delta['notifications']);
        $waiting = $delta['notifications'][0] ?? null;
        self::assertIsArray($waiting);
        self::assertNull($waiting['deliveredAt'], 'Devices hide it until it comes again.');
        self::assertNull($waiting['snoozedUntil'], 'Nobody snoozed it.');
    }

    public function testAPushEndpointBelongsToTheLastUserWhoRegisteredIt(): void
    {
        $this->registerDevices();
        $this->createUser('lisa@example.test', 'Lisa');
        $lisa = $this->userHeaders('lisa@example.test', ['settings:read', 'settings:write']);

        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'expo', 'endpoint' => self::EXPO_TOKEN, 'name' => 'Phone'], $lisa);
        self::assertResponseIsSuccessful();

        self::assertSame(['web_push', 'desktop'], array_column($this->getJson('/api/v1/notification-devices', $this->kim), 'kind'), 'Kim signed out on that phone.');
        self::assertSame(['expo'], array_column($this->getJson('/api/v1/notification-devices', $lisa), 'kind'));
    }

    public function testRegisteringAnEndpointWaitsForAnotherRegistrationOfIt(): void
    {
        $holder = static::getContainer()->get('doctrine.debug_data_holder');
        self::assertInstanceOf(\Symfony\Bridge\Doctrine\Middleware\Debug\DebugDataHolder::class, $holder);
        $holder->reset();

        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'expo', 'endpoint' => self::EXPO_TOKEN, 'name' => 'Phone'], $this->kim);
        self::assertResponseIsSuccessful();

        $sql = array_values(array_filter(array_column($holder->getData()['default'] ?? [], 'sql'), \is_string(...)));
        $lock = array_search(true, array_map(static fn (string $q): bool => str_contains($q, 'pg_advisory_xact_lock'), $sql), true);
        $read = array_search(true, array_map(static fn (string $q): bool => str_contains($q, 'FROM notification_device'), $sql), true);
        self::assertIsInt($lock, 'Two registrations of one endpoint at the same moment take turns instead of one failing on the unique key.');
        self::assertIsInt($read);
        self::assertLessThan($read, $lock);
    }

    public function testAnAddressNobodyConfirmedWaitsForTheLinkMailedToIt(): void
    {
        $this->patchSettings(['emailAddress' => 'Somebody@Elsewhere.example']);

        self::assertEmailCount(1);
        $mail = self::getMailerMessage();
        self::assertInstanceOf(Email::class, $mail);
        self::assertSame('somebody@elsewhere.example', $mail->getTo()[0]->getAddress());
        $settings = $this->getJson('/api/v1/notification-settings', $this->kim);
        self::assertNull($settings['emailAddress']);
        self::assertSame('kim@example.test', $settings['effectiveEmailAddress'], 'Nothing goes there before it is confirmed.');
        self::assertSame('somebody@elsewhere.example', $settings['pendingEmailAddress']);
        self::assertIsString($settings['pendingEmailAddressSentAt']);

        preg_match('~https?://\S+/notification-address/confirm\?\S+~', (string) $mail->getTextBody(), $match);
        $link = $match[0] ?? self::fail('The mail has no confirmation link.');
        $this->client->request('GET', $link);
        self::assertResponseIsSuccessful();
        self::assertSelectorTextContains('h1', 'Confirm address');
        self::assertSame('somebody@elsewhere.example', $this->getJson('/api/v1/notification-settings', $this->kim)['pendingEmailAddress'], 'Opening the link (as a mail scanner does) confirms nothing.');

        $this->client->request('POST', $link);
        self::assertResponseIsSuccessful();
        self::assertSelectorTextContains('h1', 'Address confirmed');
        $settings = $this->getJson('/api/v1/notification-settings', $this->kim);
        self::assertSame('somebody@elsewhere.example', $settings['effectiveEmailAddress']);
        self::assertNull($settings['pendingEmailAddress']);

        $this->client->request('POST', $link);
        self::assertResponseStatusCodeSame(410, 'A link works once.');
        $this->client->request('POST', str_replace('somebody%40elsewhere.example', 'other%40elsewhere.example', $link));
        self::assertResponseStatusCodeSame(410, 'A changed link is no link.');

        $this->patchSettings(['emailAddress' => 'Kim@Example.test']);
        self::assertEmailCount(0, null, 'The sign-in address needs no link.');
        self::assertSame('kim@example.test', $this->getJson('/api/v1/notification-settings', $this->kim)['effectiveEmailAddress']);
    }

    public function testConfirmationLinksAreLimitedPerDay(): void
    {
        for ($mail = 1; $mail <= 5; ++$mail) {
            $this->patchSettings(['emailAddress' => 'somebody@elsewhere.example']);
            self::assertEmailCount(1, null, 'Choosing it again sends the link again.');
        }

        $this->client->request('PATCH', '/api/v1/notification-settings', server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['emailAddress' => 'another@elsewhere.example'], \JSON_THROW_ON_ERROR));

        self::assertResponseStatusCodeSame(429);
        self::assertEmailCount(0);
    }

    public function testAnAddressChosenBeforeConfirmationGetsOneLinkWhenItIsFirstUsed(): void
    {
        $this->getJson('/api/v1/notification-settings', $this->kim);
        $this->connection()->executeStatement("UPDATE notification_preferences SET email_address = 'old@imap.example' WHERE user_id = :user", ['user' => $this->user()->getId()->toRfc4122()]);
        static::getContainer()->get(EntityManagerInterface::class)->clear();
        self::assertSame('kim@example.test', $this->getJson('/api/v1/notification-settings', $this->kim)['effectiveEmailAddress']);

        $dispatcher = static::getContainer()->get(NotificationDispatcher::class);
        self::assertSame('kim@example.test', $dispatcher->deliveryAddressFor($this->user()));
        self::assertSame('kim@example.test', $dispatcher->deliveryAddressFor($this->user()), 'Not one mail per notification.');

        self::assertEmailCount(1);
        $mail = self::getMailerMessage();
        self::assertInstanceOf(Email::class, $mail);
        self::assertSame('old@imap.example', $mail->getTo()[0]->getAddress());
        self::assertSame('old@imap.example', $this->getJson('/api/v1/notification-settings', $this->kim)['pendingEmailAddress']);
    }

    public function testAProviderConfirmedAddressCountsAtOnce(): void
    {
        $victim = $this->imapAccount('victim@elsewhere.example');
        $worker = $this->workerHeaders('sync:lease sync:ingest');
        $this->client->jsonRequest('POST', '/internal/sync/leases', ['workerId' => 'w1'], $worker);
        self::assertResponseIsSuccessful();
        $this->client->jsonRequest('POST', '/internal/sync/accounts/'.$victim.'/status', ['workerId' => 'w1', 'status' => 'active'], $worker);
        self::assertResponseIsSuccessful();
        $this->patchSettings(['emailAddress' => 'victim@elsewhere.example']);
        self::assertSame('kim@example.test', $this->getJson('/api/v1/notification-settings', $this->kim)['effectiveEmailAddress'], 'A synced IMAP account proves a mailbox someone can log in to, not the address typed next to it.');

        $google = $this->imapAccount('kim@gmail.example');
        $this->confirmByProvider($google, 'someone-else@gmail.example', 'google');
        $this->patchSettings(['emailAddress' => 'kim@gmail.example']);
        self::assertSame('kim@example.test', $this->getJson('/api/v1/notification-settings', $this->kim)['effectiveEmailAddress'], 'Google confirmed another address.');
        $this->connection()->executeStatement("UPDATE provider_grant SET email_address = 'Kim@Gmail.example' WHERE provider = 'google'");
        $this->patchSettings(['emailAddress' => 'kim@gmail.example']);
        self::assertEmailCount(0);
        self::assertSame('kim@gmail.example', $this->getJson('/api/v1/notification-settings', $this->kim)['effectiveEmailAddress']);

        $microsoft = $this->imapAccount('kim@contoso.example');
        $this->confirmByProvider($microsoft, 'kim@contoso.example', 'microsoft');
        $this->patchSettings(['emailAddress' => 'kim@contoso.example']);
        self::assertSame('kim@gmail.example', $this->getJson('/api/v1/notification-settings', $this->kim)['effectiveEmailAddress'], 'A Microsoft address only counts once its mailbox synced; until then the last address stays.');
        $this->connection()->executeStatement('UPDATE mail_account SET last_synced_at = NOW() WHERE id = :id', ['id' => $microsoft]);
        $this->patchSettings(['emailAddress' => 'kim@contoso.example']);
        self::assertSame('kim@contoso.example', $this->getJson('/api/v1/notification-settings', $this->kim)['effectiveEmailAddress']);
    }

    private function imapAccount(string $address): string
    {
        $this->client->jsonRequest('POST', '/api/v1/mail-accounts', [
            'emailAddress' => $address,
            'displayName' => $address,
            'username' => $address,
            'password' => 'app-password-1',
            'imap' => ['host' => 'imap.elsewhere.example', 'port' => 993, 'security' => 'tls'],
            'smtp' => ['host' => 'smtp.elsewhere.example', 'port' => 465, 'security' => 'tls'],
        ], $this->kim);
        self::assertResponseStatusCodeSame(201);

        return $this->responseString('id');
    }

    /** As a provider sign-in leaves it: a grant with the address the provider confirmed, which the account uses. */
    private function confirmByProvider(string $accountId, string $confirmed, string $provider): void
    {
        $grant = Uuid::v7()->toRfc4122();
        $this->connection()->executeStatement(
            "INSERT INTO provider_grant (id, provider, subject, email_address, scopes, encrypted_tokens, created_at, updated_at, owner_id)
             SELECT :id, :provider, :subject, :address, '[]', 'not-used', NOW(), NOW(), owner_id FROM mail_account WHERE id = :account",
            ['id' => $grant, 'provider' => $provider, 'subject' => 'subject-'.$provider, 'address' => $confirmed, 'account' => $accountId],
        );
        $this->connection()->executeStatement('UPDATE mail_account SET provider_grant_id = :grant WHERE id = :account', ['grant' => $grant, 'account' => $accountId]);
    }

    public function testFloatingTimesAreReadInTheUsersZone(): void
    {
        $this->patchSettings(['timeZone' => 'Europe/Amsterdam']);
        $local = new \DateTimeImmutable('+2 days 10:00', new \DateTimeZone('Europe/Amsterdam'));
        $calendar = static::getContainer()->get(\App\Repository\CalendarRepository::class)->findOneOwnedBy($this->user(), $this->calendarId);
        self::assertNotNull($calendar);
        $ical = implode("\r\n", ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'BEGIN:VEVENT', 'UID:floating@test', 'DTSTAMP:20261019T080000Z',
            'DTSTART:'.$local->format('Ymd\THis'), 'DURATION:PT30M', 'SUMMARY:Floating', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', '']);
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $entityManager->wrapInTransaction(static fn () => static::getContainer()->get(\App\Calendar\CalendarStore::class)->save(new \App\Entity\CalendarObject($calendar, 'floating@test', ''), \App\Calendar\ICalendar\CalendarDocument::parse($ical)));
        $this->runQueuedPlanning();

        self::assertSame($local->modify('-10 minutes')->setTimezone(new \DateTimeZone('UTC'))->format(\DATE_ATOM), $this->atom($this->notifications()[0]['fireAt']));
    }

    public function testAChangeToThisAndFutureOccurrencesIsWhatTheirRemindersSay(): void
    {
        $first = new \DateTimeImmutable('+1 day 10:00', new \DateTimeZone('UTC'));
        $second = $first->modify('+1 day');
        $calendar = static::getContainer()->get(\App\Repository\CalendarRepository::class)->findOneOwnedBy($this->user(), $this->calendarId);
        self::assertNotNull($calendar);
        $alarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM'];
        $ical = implode("\r\n", ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
            'BEGIN:VEVENT', 'UID:range@test', 'DTSTAMP:20261019T080000Z', 'DTSTART:'.$first->format('Ymd\THis\Z'), 'DURATION:PT30M', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Sync', ...$alarm, 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:range@test', 'DTSTAMP:20261019T080000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:'.$second->format('Ymd\THis\Z'), 'DTSTART:'.$second->modify('+1 hour')->format('Ymd\THis\Z'), 'DURATION:PT30M', 'SUMMARY:Sync, later', ...$alarm, 'END:VEVENT',
            'END:VCALENDAR', '']);
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $entityManager->wrapInTransaction(static fn () => static::getContainer()->get(\App\Calendar\CalendarStore::class)->save(new \App\Entity\CalendarObject($calendar, 'range@test', ''), \App\Calendar\ICalendar\CalendarDocument::parse($ical)));
        $this->runQueuedPlanning();

        $planned = array_map(fn (array $n): array => [$n['title'], $this->atom($n['fireAt'])], $this->notifications());
        usort($planned, static fn (array $a, array $b): int => $a[1] <=> $b[1]);

        self::assertSame([
            ['Sync', $first->modify('-10 minutes')->format(\DATE_ATOM)],
            ['Sync, later', $second->modify('+50 minutes')->format(\DATE_ATOM)],
            ['Sync, later', $second->modify('+1 day 50 minutes')->format(\DATE_ATOM)],
        ], $planned);
    }

    public function testOneUserWhosePlanningFailsDoesNotStopTheSweep(): void
    {
        $this->createUser('lisa@example.test', 'Lisa');
        $this->connection()->executeStatement("UPDATE notification_preferences SET time_zone = 'Mars/Olympus', planned_until = NULL FROM app_user u WHERE u.id = notification_preferences.user_id AND u.email = 'kim@example.test'");
        $this->connection()->executeStatement("UPDATE notification_preferences SET planned_until = NULL FROM app_user u WHERE u.id = notification_preferences.user_id AND u.email = 'lisa@example.test'");

        $this->sweep();

        $plans = $this->connection()->fetchAllKeyValue("SELECT u.email, p.planned_until IS NOT NULL FROM notification_preferences p JOIN app_user u ON u.id = p.user_id ORDER BY u.email");
        self::assertEquals(['kim@example.test' => false, 'lisa@example.test' => true], $plans, 'Lisa is planned although Kim fails.');
        self::assertNotNull($this->connection()->fetchOne("SELECT p.plan_retry_at FROM notification_preferences p JOIN app_user u ON u.id = p.user_id WHERE u.email = 'kim@example.test'"), 'Kim waits before the next try.');
    }

    public function testExposReceiptsRemovePhonesThatAreGone(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(6), ['useDefaultReminders' => false, 'reminders' => [['minutesBefore' => 5, 'channels' => ['phone']]]]);
        $this->fire($this->onlyNotificationId());
        $this->http()->respond('https://exp.host/--/api/v2/push/getReceipts', json_encode(['data' => ['ticket-1' => ['status' => 'error', 'message' => 'gone', 'details' => ['error' => 'DeviceNotRegistered']]]], \JSON_THROW_ON_ERROR));

        static::getContainer()->get(NotificationDispatcher::class)->checkReceipts(new \DateTimeImmutable('+20 minutes'));

        self::assertSame(['web_push', 'desktop'], array_column($this->getJson('/api/v1/notification-devices', $this->kim), 'kind'));
        self::assertSame(0, $this->connection()->fetchOne('SELECT COUNT(*)::int FROM notification_delivery WHERE ticket IS NOT NULL'));
    }

    public function testOtherUsersNotificationsDevicesRulesNotesAndEstimatesDoNotExist(): void
    {
        $this->registerDevices();
        $eventId = $this->createEvent($this->inMinutes(30), ['location' => 'Herengracht 1']);
        $notificationId = $this->notifications()[0]['id'];
        $devices = $this->getJson('/api/v1/notification-devices', $this->kim);
        $rules = $this->getJson('/api/v1/reminder-rules', $this->kim);
        self::assertIsArray($devices[0]);
        self::assertIsArray($rules[0]);
        $deviceId = $devices[0]['id'];
        $ruleId = $rules[0]['id'];
        self::assertIsString($notificationId);
        self::assertIsString($deviceId);
        self::assertIsString($ruleId);
        $this->createUser('lisa@example.test', 'Lisa');
        $lisa = $this->userHeaders('lisa@example.test', ['mail:read', 'calendar:read', 'calendar:write', 'settings:read', 'settings:write']);

        foreach ([
            ['POST', '/api/v1/notifications/'.$notificationId.'/dismiss', []],
            ['POST', '/api/v1/notifications/'.$notificationId.'/snooze', ['minutes' => 5]],
            ['PATCH', '/api/v1/notification-devices/'.$deviceId, ['enabled' => false]],
            ['DELETE', '/api/v1/notification-devices/'.$deviceId, null],
            ['PUT', '/api/v1/reminder-rules/'.$ruleId, ['name' => 'Taken', 'reminders' => []]],
            ['DELETE', '/api/v1/reminder-rules/'.$ruleId, null],
            ['PUT', '/api/v1/calendar-events/'.$eventId.'/note', ['text' => 'Mine now']],
            ['POST', '/api/v1/calendar-events/'.$eventId.'/leave-estimate', ['latitude' => 52.37, 'longitude' => 4.89]],
            ['GET', '/api/v1/calendar-events/'.$eventId.'/brief', null],
        ] as [$method, $uri, $body]) {
            if ('PATCH' === $method) {
                $this->client->request($method, $uri, server: [...$lisa, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode($body, \JSON_THROW_ON_ERROR));
            } elseif (null === $body) {
                $this->client->request($method, $uri, server: $lisa);
            } else {
                $this->client->jsonRequest($method, $uri, $body, $lisa);
            }
            self::assertResponseStatusCodeSame(404, $method.' '.$uri);
        }
        self::assertSame([], $this->getJson('/api/v1/notifications', $lisa));
    }

    public function testRemovingAnEventDropsItsPlannedNotifications(): void
    {
        $event = $this->createEvent($this->inMinutes(2 * 24 * 60));
        self::assertCount(1, $this->notifications());

        $this->client->request('DELETE', '/api/v1/calendar-events/'.$event, server: $this->kim);
        self::assertResponseStatusCodeSame(204);
        $this->runQueuedPlanning();

        self::assertSame([], $this->notifications());
    }

    public function testTheSweepDeliversWhatAMessageMissed(): void
    {
        $this->registerDevices();
        $this->createEvent($this->inMinutes(30));
        $id = $this->onlyNotificationId();
        $this->connection()->executeStatement('UPDATE scheduled_notification SET fire_at = :past WHERE id = :id', ['past' => new \DateTimeImmutable('-5 minutes')->format('Y-m-d H:i:s'), 'id' => $id]);

        static::getContainer()->get(NotificationHandlers::class)->sweep(new SweepNotifications());

        self::assertNotNull($this->notifications()[0]['deliveredAt']);
    }

    public function testValidatesDevices(): void
    {
        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'web_push', 'endpoint' => 'http://push.example.test/1', 'publicKey' => self::P256DH, 'authSecret' => self::AUTH, 'name' => 'Firefox'], $this->kim);
        self::assertResponseStatusCodeSame(422);
        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'web_push', 'endpoint' => self::PUSH_ENDPOINT, 'publicKey' => 'AAAA', 'authSecret' => self::AUTH, 'name' => 'Firefox'], $this->kim);
        self::assertResponseStatusCodeSame(422);
        $this->client->jsonRequest('POST', '/api/v1/notification-devices', ['kind' => 'expo', 'endpoint' => 'not-a-token', 'name' => 'Phone'], $this->kim);
        self::assertResponseStatusCodeSame(422);
    }

    public function testPrivateNotesReachTheDelta(): void
    {
        $event = $this->createEvent($this->inMinutes(60));

        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$event.'/note', ['text' => 'Ask about the Q4 numbers.'], $this->kim);
        self::assertResponseIsSuccessful();

        $delta = $this->getJson('/api/v1/sync/changes?since=0', $this->kim);
        self::assertIsArray($delta['eventNotes']);
        self::assertSame(['Ask about the Q4 numbers.'], array_column($delta['eventNotes'], 'text'));
    }

    /**
     * Stores a daily series of two as a provider sync would, its first occurrence with an override of its own or
     * without one, with a reminder that many minutes before.
     */
    private function storeSeries(\DateTimeImmutable $start, bool $override, int $minutesBefore): void
    {
        $calendar = static::getContainer()->get(\App\Repository\CalendarRepository::class)->findOneOwnedBy($this->user(), $this->calendarId);
        self::assertNotNull($calendar);
        $alarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT'.$minutesBefore.'M', 'END:VALARM'];
        $lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
            'BEGIN:VEVENT', 'UID:series@test', 'DTSTAMP:20261019T080000Z', 'DTSTART:'.$start->format('Ymd\THis\Z'), 'DURATION:PT30M', 'RRULE:FREQ=DAILY;COUNT=2', 'SUMMARY:Standup', ...$alarm, 'END:VEVENT'];
        if ($override) {
            $lines = [...$lines, 'BEGIN:VEVENT', 'UID:series@test', 'DTSTAMP:20261019T080000Z', 'RECURRENCE-ID:'.$start->format('Ymd\THis\Z'), 'DTSTART:'.$start->format('Ymd\THis\Z'), 'DURATION:PT30M', 'SUMMARY:Standup, room 2', ...$alarm, 'END:VEVENT'];
        }
        $ical = implode("\r\n", [...$lines, 'END:VCALENDAR', '']);
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $object = $entityManager->getRepository(\App\Entity\CalendarObject::class)->findOneBy(['calendar' => $calendar, 'uid' => 'series@test']) ?? new \App\Entity\CalendarObject($calendar, 'series@test', '');
        $entityManager->wrapInTransaction(static fn () => static::getContainer()->get(\App\Calendar\CalendarStore::class)->save($object, \App\Calendar\ICalendar\CalendarDocument::parse($ical)));
        $entityManager->clear();
        $this->runQueuedPlanning();
    }

    /** The id of the one notification for the occurrence starting then. */
    private function notificationFor(\DateTimeImmutable $start): string
    {
        $notifications = $this->notificationsFor($start);
        self::assertCount(1, $notifications);

        return self::string($notifications[0]['id']);
    }

    /** @return list<array<string, mixed>> */
    private function notificationsFor(\DateTimeImmutable $start): array
    {
        return array_values(array_filter($this->notifications(), fn (array $n): bool => $start->format(\DATE_ATOM) === $this->atom($n['occurrenceStartsAt'])));
    }

    /**
     * Changes one occurrence of a series (scope "this"), which gives it an override row.
     *
     * @param array<string, mixed> $changes
     */
    private function editOccurrence(string $eventId, \DateTimeImmutable $start, array $changes): void
    {
        $local = $start->setTimezone(new \DateTimeZone('Europe/Amsterdam'));
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId.'?'.http_build_query(['scope' => 'this', 'recurrenceId' => $start->format('Ymd\THis\Z')]), self::event($this->calendarId, [
            'summary' => 'Standup',
            'start' => ['dateTime' => $local->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => $local->modify('+30 minutes')->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
            'useDefaultReminders' => false,
            'reminders' => [['minutesBefore' => 25, 'channels' => ['phone']]],
            ...$changes,
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        $this->runQueuedPlanning();
    }

    /** A whole minute that many minutes from now. */
    private function inMinutes(int $minutes): \DateTimeImmutable
    {
        $moment = new \DateTimeImmutable(\sprintf('%+d minutes', $minutes), new \DateTimeZone('UTC'));

        return $moment->setTime((int) $moment->format('H'), (int) $moment->format('i'));
    }

    /**
     * Creates an event at that start (30 minutes long) and runs the planning it causes; returns its id.
     *
     * @param array<string, mixed> $overrides
     */
    private function createEvent(\DateTimeImmutable $start, array $overrides = [], int $expectStatus = 201): string
    {
        $local = $start->setTimezone(new \DateTimeZone('Europe/Amsterdam'));
        $this->client->jsonRequest('POST', '/api/v1/calendar-events', self::event($this->calendarId, [
            'summary' => 'Standup',
            'start' => ['dateTime' => $local->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => $local->modify('+30 minutes')->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
            ...$overrides,
        ]), $this->kim);
        self::assertResponseStatusCodeSame($expectStatus);
        if (201 !== $expectStatus) {
            return '';
        }
        $id = $this->responseString('id');
        $this->runQueuedPlanning();

        return $id;
    }

    /** An event the user is invited to, as an invitation or a provider would store it. */
    private function storeInvitation(string $uid, string $summary, string $startUtc): void
    {
        $calendar = static::getContainer()->get(\App\Repository\CalendarRepository::class)->findOneOwnedBy(static::getContainer()->get(\App\Repository\UserRepository::class)->findOneBy(['email' => 'kim@example.test']) ?? self::fail('No user.'), $this->calendarId);
        self::assertNotNull($calendar);
        $ical = implode("\r\n", ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'BEGIN:VEVENT', 'UID:'.$uid, 'DTSTAMP:20261019T080000Z', 'DTSTART:'.$startUtc, 'DURATION:PT30M',
            'SUMMARY:'.$summary, 'ORGANIZER:mailto:anna@finance.example', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:kim@example.test', 'END:VEVENT', 'END:VCALENDAR', '']);
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $entityManager->wrapInTransaction(static fn () => static::getContainer()->get(\App\Calendar\CalendarStore::class)->save(new \App\Entity\CalendarObject($calendar, $uid, ''), \App\Calendar\ICalendar\CalendarDocument::parse($ical)));
        $this->runQueuedPlanning();
    }

    /**
     * @param array<string, mixed> $overrides
     */
    private function updateEvent(string $eventId, \DateTimeImmutable $start, array $overrides = []): void
    {
        $local = $start->setTimezone(new \DateTimeZone('Europe/Amsterdam'));
        $this->client->jsonRequest('PUT', '/api/v1/calendar-events/'.$eventId, self::event($this->calendarId, [
            'summary' => 'Standup',
            'start' => ['dateTime' => $local->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
            'end' => ['dateTime' => $local->modify('+30 minutes')->format('Y-m-d\TH:i:s'), 'timeZone' => 'Europe/Amsterdam'],
            ...$overrides,
        ]), $this->kim);
        self::assertResponseIsSuccessful();
        $this->runQueuedPlanning();
    }

    /** @return list<string> statuses of the deliveries, sorted */
    private function deliveryStatuses(): array
    {
        /** @var list<string> */
        return $this->connection()->fetchFirstColumn('SELECT status FROM notification_delivery ORDER BY status');
    }

    /** @return list<array{method: string, url: string, body: string, headers: list<string>}> */
    private function pushesTo(string $url): array
    {
        return array_values(array_filter($this->http()->calls(), static fn (array $call): bool => $url === $call['url']));
    }

    private function sweep(): void
    {
        static::getContainer()->get(NotificationHandlers::class)->sweep(new SweepNotifications());
    }

    private function user(): \App\Entity\User
    {
        return static::getContainer()->get(\App\Repository\UserRepository::class)->findOneBy(['email' => 'kim@example.test']) ?? self::fail('No user.');
    }

    private function markWork(): void
    {
        $this->client->request('PATCH', '/api/v1/calendars/'.$this->calendarId, server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['work' => true], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
        self::assertTrue($this->decodedResponse()['work']);
        $this->runQueuedPlanning();
    }

    private function registerDevices(): void
    {
        $this->http()->respond(self::PUSH_ENDPOINT, '', 201);
        $this->http()->respond('https://exp.host/--/api/v2/push/send', json_encode(['data' => [['status' => 'ok', 'id' => 'ticket-1']]], \JSON_THROW_ON_ERROR));
        foreach ([
            ['kind' => 'web_push', 'endpoint' => self::PUSH_ENDPOINT, 'publicKey' => self::P256DH, 'authSecret' => self::AUTH, 'name' => 'Firefox'],
            ['kind' => 'expo', 'endpoint' => self::EXPO_TOKEN, 'name' => 'Phone'],
            ['kind' => 'desktop', 'endpoint' => 'desktop-installation-1', 'name' => 'Mac'],
        ] as $device) {
            $this->client->jsonRequest('POST', '/api/v1/notification-devices', $device, $this->kim);
            self::assertResponseIsSuccessful();
        }
    }

    /**
     * @param array<string, mixed> $changes
     */
    private function patchSettings(array $changes): void
    {
        $this->client->request('PATCH', '/api/v1/notification-settings', server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode($changes, \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
    }

    /** @return list<array<string, mixed>> */
    private function notifications(): array
    {
        /** @var list<array<string, mixed>> */
        return array_values($this->getJson('/api/v1/notifications', $this->kim));
    }

    private function onlyNotificationId(): string
    {
        $notifications = $this->notifications();
        self::assertCount(1, $notifications);

        return self::string($notifications[0]['id']);
    }

    private function fire(string $id, ?\DateTimeImmutable $at = null): void
    {
        $notification = static::getContainer()->get(EntityManagerInterface::class)->find(ScheduledNotification::class, Uuid::fromString($id));
        self::assertNotNull($notification);
        static::getContainer()->get(NotificationDeliverer::class)->fire($id, $at ?? $notification->getFireAt());
    }

    /** Runs the planning messages the requests queued, as the Messenger worker would. */
    private function runQueuedPlanning(): void
    {
        $transport = static::getContainer()->get('messenger.transport.push');
        self::assertInstanceOf(InMemoryTransport::class, $transport);
        $handlers = static::getContainer()->get(NotificationHandlers::class);
        foreach ($transport->getSent() as $envelope) {
            $message = $envelope->getMessage();
            if ($message instanceof PlanCalendarObject) {
                $handlers->plan($message);
            } elseif ($message instanceof PlanUserNotifications) {
                $handlers->planUser($message);
            }
        }
        $transport->reset();
    }

    private function http(): MockHttpRouter
    {
        return static::getContainer()->get(MockHttpRouter::class);
    }

    private function atom(mixed $value, string $zone = 'UTC'): string
    {
        return new \DateTimeImmutable(self::string($value))->setTimezone(new \DateTimeZone($zone))->format(\DATE_ATOM);
    }
}
