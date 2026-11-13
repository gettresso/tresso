<?php

declare(strict_types=1);

namespace App\Tests\Functional\Notification;

use App\Calendar\CalendarStore;
use App\Calendar\ICalendar\CalendarDocument;
use App\Entity\Calendar;
use App\Entity\CalendarObject;
use App\Entity\ScheduledNotification;
use App\Notification\NotificationPlanner;
use App\Repository\CalendarRepository;
use App\Repository\UserRepository;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\Calendar\CalendarTestHelpers;
use App\Tests\Functional\DatabaseTestCase;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Planning at a fixed moment, so the dates (and a daylight saving change) are known: series, overrides, all-day
 * events, and edits before delivery.
 */
final class NotificationPlanningTest extends DatabaseTestCase
{
    use AuthenticatesUsers;
    use CalendarTestHelpers;

    /** Tuesday 20 October 2026; summer time in Amsterdam ends on Sunday 25 October. */
    private const string NOW = '2026-10-20T09:00:00+00:00';

    /** @var array<string, string> */
    private array $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->kim = $this->userHeaders('kim@example.test', ['calendar:read', 'calendar:write', 'settings:read', 'settings:write']);
        $this->client->request('PATCH', '/api/v1/notification-settings', server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['timeZone' => 'Europe/Amsterdam'], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();
    }

    public function testASeriesKeepsItsLocalTimeAcrossTheClockChangeAndOverridesMoveTheirReminder(): void
    {
        $this->store('standup@test', [
            'BEGIN:VEVENT', 'UID:standup@test', 'DTSTAMP:20261019T080000Z', 'DTSTART;TZID=Europe/Amsterdam:20261021T090000', 'DURATION:PT15M',
            'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Standup', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:standup@test', 'DTSTAMP:20261019T080000Z', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20261104T090000',
            'DTSTART;TZID=Europe/Amsterdam:20261104T113000', 'DURATION:PT15M', 'SUMMARY:Standup, later', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
        ]);

        $this->planAt(self::NOW);

        // 09:00 in Amsterdam is 07:00 UTC in summer time and 08:00 UTC after it.
        self::assertSame(['2026-10-21T06:50:00+00:00', '2026-10-28T07:50:00+00:00'], $this->fireTimes(), 'Planned eight days ahead.');

        $this->planAt('2026-10-30T08:00:00+00:00');

        self::assertContains('2026-11-04T10:20:00+00:00', $this->fireTimes(), 'The override at 11:30 brings its own reminder.');
        self::assertNotContains('2026-11-04T07:50:00+00:00', $this->fireTimes());
    }

    public function testAllDayRemindersComeAtTheirTimeInTheUsersZone(): void
    {
        $this->store('holiday@test', [
            'BEGIN:VEVENT', 'UID:holiday@test', 'DTSTAMP:20261019T080000Z', 'DTSTART;VALUE=DATE:20261023', 'DTEND;VALUE=DATE:20261024', 'SUMMARY:Holiday', 'END:VEVENT',
        ]);

        $this->planAt(self::NOW);

        // The default rule for all-day events: 09:00 the day before, in Amsterdam.
        self::assertSame(['2026-10-22T07:00:00+00:00'], $this->fireTimes());
    }

    public function testAnEditBeforeDeliveryMovesThePlannedReminder(): void
    {
        $lines = static fn (string $start): array => [
            'BEGIN:VEVENT', 'UID:review@test', 'DTSTAMP:20261019T080000Z', 'DTSTART;TZID=Europe/Amsterdam:'.$start, 'DURATION:PT30M', 'SUMMARY:Review',
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT',
        ];
        $this->store('review@test', $lines('20261022T140000'));
        $this->planAt(self::NOW);
        self::assertSame(['2026-10-22T11:45:00+00:00'], $this->fireTimes());

        $this->store('review@test', $lines('20261022T160000'));
        $this->planAt(self::NOW);

        self::assertSame(['2026-10-22T13:45:00+00:00'], $this->fireTimes(), 'One notification, at the new time.');
    }

    public function testAReminderNamesTheMeetingAppAndThePlaceButNeverTheLink(): void
    {
        $this->store('teams@test', self::meeting('teams@test', '20261022T100000', ['CONFERENCE;VALUE=URI:https://teams.microsoft.com/l/meetup-join/19%3ameeting', 'LOCATION:Room 3.2\\, Herengracht office']));
        $this->store('meet@test', self::meeting('meet@test', '20261022T120000', ['X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij']));
        $this->store('other@test', self::meeting('other@test', '20261022T140000', ['CONFERENCE;VALUE=URI:https://video.example.com/room', 'LOCATION:Room 1']));
        $this->store('room@test', self::meeting('room@test', '20261022T160000', ['LOCATION:Room 1']));
        // Outlook writes the app in the place and the link in the description.
        $this->store('outlook@test', self::meeting('outlook@test', '20261023T100000', ['LOCATION:Microsoft Teams Meeting', 'DESCRIPTION:Join: https://teams.microsoft.com/l/meetup-join/19%3aoutlook']));
        // The link only in the place: it is the meeting, and not a place to name.
        $this->store('linkplace@test', self::meeting('linkplace@test', '20261023T120000', ['LOCATION:Room 2 (https://teams.microsoft.com/l/meetup-join/19%3aplace)']));
        // A host that only carries an app's link in its path is no app's meeting.
        $this->store('lookalike@test', self::meeting('lookalike@test', '20261023T140000', ['CONFERENCE;VALUE=URI:https://example.com/redirect/teams.microsoft.com/l/meetup-join/1']));
        // A link with a user name in it is not offered as a meeting at all.
        $this->store('unsafe@test', self::meeting('unsafe@test', '20261023T160000', ['CONFERENCE;VALUE=URI:https://meet.google.com@video.example.com/room', 'LOCATION:Room 4']));

        $this->planAt(self::NOW);

        self::assertSame([
            'teams@test: Thursday 22 October, 10:00 to 11:00, on Microsoft Teams. Or in Room 3.2, Herengracht office.',
            'meet@test: Thursday 22 October, 12:00 to 13:00, on Google Meet.',
            'other@test: Thursday 22 October, 14:00 to 15:00, online. Or in Room 1.',
            'room@test: Thursday 22 October, 16:00 to 17:00, Room 1',
            'outlook@test: Friday 23 October, 10:00 to 11:00, on Microsoft Teams.',
            'linkplace@test: Friday 23 October, 12:00 to 13:00, on Microsoft Teams. Or in Room 2.',
            'lookalike@test: Friday 23 October, 14:00 to 15:00, online.',
            'unsafe@test: Friday 23 October, 16:00 to 17:00, Room 4',
        ], $this->bodies());
        foreach ($this->bodies() as $body) {
            self::assertStringNotContainsString('http', $body, 'No link in a reminder.');
        }
    }

    public function testAnOccurrenceAndAnEditWithoutTheMeetingDropTheApp(): void
    {
        $this->store('sync@test', self::syncSeries(['X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij']));
        $this->planAt(self::NOW);

        self::assertSame([
            'sync@test: Wednesday 21 October, 10:00 to 10:30, on Google Meet.',
            'sync@test: Friday 23 October, 10:00 to 10:30, Room 1',
            'sync@test: Sunday 25 October, 10:00 to 10:30, on Google Meet.',
        ], $this->bodies());

        // The meeting is taken off the series before its reminders came.
        $this->store('sync@test', self::syncSeries([]));
        $this->planAt(self::NOW);

        self::assertSame([
            'sync@test: Wednesday 21 October, 10:00 to 10:30',
            'sync@test: Friday 23 October, 10:00 to 10:30, Room 1',
            'sync@test: Sunday 25 October, 10:00 to 10:30',
        ], $this->bodies());
    }

    /**
     * A one hour meeting with the given extra lines.
     *
     * @param list<string> $lines
     *
     * @return list<string>
     */
    private static function meeting(string $uid, string $start, array $lines): array
    {
        return ['BEGIN:VEVENT', 'UID:'.$uid, 'DTSTAMP:20261019T080000Z', 'DTSTART;TZID=Europe/Amsterdam:'.$start, 'DURATION:PT1H', 'SUMMARY:Meeting', ...$lines, 'END:VEVENT'];
    }

    /**
     * A series every other day from Wednesday 21 October, three times, with the given extra lines; its occurrence on
     * Friday 23 October is held in a room, without a meeting.
     *
     * @param list<string> $lines
     *
     * @return list<string>
     */
    private static function syncSeries(array $lines): array
    {
        return [
            'BEGIN:VEVENT', 'UID:sync@test', 'DTSTAMP:20261019T080000Z', 'DTSTART;TZID=Europe/Amsterdam:20261021T100000', 'DURATION:PT30M',
            'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3', 'SUMMARY:Sync', ...$lines, 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:sync@test', 'DTSTAMP:20261019T080000Z', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20261023T100000',
            'DTSTART;TZID=Europe/Amsterdam:20261023T100000', 'DURATION:PT30M', 'SUMMARY:Sync', 'LOCATION:Room 1', 'END:VEVENT',
        ];
    }

    /**
     * Stores an event the way a provider sync would (saving it queues a plan at the real time, which planAt() then
     * redoes at the fixed one).
     *
     * @param list<string> $lines
     */
    private function store(string $uid, array $lines): void
    {
        $calendar = $this->calendar();
        $ical = implode("\r\n", ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...$lines, 'END:VCALENDAR', '']);
        $entityManager = $this->entityManager();
        $object = $entityManager->getRepository(CalendarObject::class)->findOneBy(['calendar' => $calendar, 'uid' => $uid]) ?? new CalendarObject($calendar, $uid, '');
        $entityManager->wrapInTransaction(static fn () => static::getContainer()->get(CalendarStore::class)->save($object, CalendarDocument::parse($ical)));
    }

    private function planAt(string $now): void
    {
        $entityManager = $this->entityManager();
        $user = static::getContainer()->get(UserRepository::class)->findOneBy(['email' => 'kim@example.test']) ?? self::fail('No user.');
        $entityManager->wrapInTransaction(static fn () => static::getContainer()->get(NotificationPlanner::class)->planUser($user, new \DateTimeImmutable($now)));
        $entityManager->clear();
    }

    /** @return list<string> */
    private function fireTimes(): array
    {
        $times = array_map(
            static fn (ScheduledNotification $n): string => $n->getFireAt()->setTimezone(new \DateTimeZone('UTC'))->format(\DATE_ATOM),
            $this->entityManager()->getRepository(ScheduledNotification::class)->findBy([], ['fireAt' => 'ASC']),
        );

        return array_values(array_unique($times));
    }

    /**
     * The planned notifications in the order they come, each as its event's UID and its body.
     *
     * @return list<string>
     */
    private function bodies(): array
    {
        return array_map(
            static fn (ScheduledNotification $n): string => ($n->getEvent()?->getObject()->getUid() ?? '(no event)').': '.$n->getBody(),
            $this->entityManager()->getRepository(ScheduledNotification::class)->findBy([], ['fireAt' => 'ASC']),
        );
    }

    private function calendar(): Calendar
    {
        $user = static::getContainer()->get(UserRepository::class)->findOneBy(['email' => 'kim@example.test']) ?? self::fail('No user.');

        return static::getContainer()->get(CalendarRepository::class)->findOneBy(['owner' => $user, 'mailAccount' => null]) ?? self::fail('No calendar.');
    }

    private function entityManager(): EntityManagerInterface
    {
        return static::getContainer()->get(EntityManagerInterface::class);
    }
}
