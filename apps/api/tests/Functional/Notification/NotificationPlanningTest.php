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
    private const string TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting';

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
        $this->store('teams@test', self::meeting('teams@test', '20261022T100000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:Room 3.2\, Herengracht office']));
        $this->store('meet@test', self::meeting('meet@test', '20261022T120000', ['X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij']));
        $this->store('other@test', self::meeting('other@test', '20261022T140000', ['CONFERENCE;VALUE=URI:https://video.example.com/room', 'LOCATION:Room 1']));
        $this->store('room@test', self::meeting('room@test', '20261022T160000', ['LOCATION:Room 1']));
        $this->store('zoom@test', self::meeting('zoom@test', '20261022T180000', ['CONFERENCE;VALUE=URI:https://zoom.us/j/123?pwd=abc', 'LOCATION:Zoom Meeting']));
        $this->store('webex@test', self::meeting('webex@test', '20261022T200000', ['CONFERENCE;VALUE=URI:https://acme.webex.com/meet/kim']));
        $this->store('allday@test', ['BEGIN:VEVENT', 'UID:allday@test', 'DTSTAMP:20261019T080000Z', 'DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261025', 'SUMMARY:Offsite', 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', 'END:VEVENT']);
        // Outlook writes the app in the place and the link in the description.
        $this->store('outlook@test', self::meeting('outlook@test', '20261023T100000', ['LOCATION:Microsoft Teams Meeting', 'DESCRIPTION:Join: https://teams.microsoft.com/l/meetup-join/19%3aoutlook']));
        // The link only in the place: it is the meeting, and not a place to name or travel to.
        $this->store('linkplace@test', self::meeting('linkplace@test', '20261023T120000', ['LOCATION:Room 2 (https://teams.microsoft.com/l/meetup-join/19%3aplace)', 'X-TRESSO-TRAVEL-MINUTES:15']));
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
            'zoom@test: Thursday 22 October, 18:00 to 19:00, on Zoom.',
            'webex@test: Thursday 22 October, 20:00 to 21:00, on Webex.',
            'allday@test: Saturday 24 October (all day), on Google Meet.',
            'outlook@test: Friday 23 October, 10:00 to 11:00, on Microsoft Teams.',
            'linkplace@test: Leave now: about 15 minutes to Room 2.',
            'linkplace@test: Friday 23 October, 12:00 to 13:00, on Microsoft Teams. Or in Room 2.',
            'lookalike@test: Friday 23 October, 14:00 to 15:00, online.',
            'unsafe@test: Friday 23 October, 16:00 to 17:00, Room 4',
        ], $this->bodies());
        $this->assertNoLinks();
    }

    public function testAPlaceLosesItsLinksAlsoWithoutAMeetingAndInEveryForm(): void
    {
        // No meeting is found in these, so the place alone said where to go, link and all.
        $this->store('jitsi@test', self::meeting('jitsi@test', '20261022T100000', ['LOCATION:https://jitsi.example.org/SecretRoom']));
        $this->store('http@test', self::meeting('http@test', '20261022T120000', ['LOCATION:Room 7 http://teams.microsoft.com/l/meetup-join/secret']));
        $this->store('passcode@test', self::meeting('passcode@test', '20261022T140000', ['LOCATION:https://zoom.us/s/123?pwd=abc']));
        $this->store('appscheme@test', self::meeting('appscheme@test', '20261022T160000', ['LOCATION:Room 8 msteams://teams.microsoft.com/l/meetup-join/secret']));
        // With a meeting: a link without its scheme, and one glued to a word.
        $this->store('noscheme@test', self::meeting('noscheme@test', '20261023T100000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:teams.microsoft.com/l/meetup-join/19%3asecret']));
        $this->store('glued@test', self::meeting('glued@test', '20261023T120000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:Roomhttps://teams.microsoft.com/l/meetup-join/secret']));

        $this->planAt(self::NOW);

        self::assertSame([
            'jitsi@test: Thursday 22 October, 10:00 to 11:00',
            'http@test: Thursday 22 October, 12:00 to 13:00, Room 7',
            'passcode@test: Thursday 22 October, 14:00 to 15:00',
            'appscheme@test: Thursday 22 October, 16:00 to 17:00, Room 8',
            'noscheme@test: Friday 23 October, 10:00 to 11:00, on Microsoft Teams.',
            'glued@test: Friday 23 October, 12:00 to 13:00, on Microsoft Teams.',
        ], $this->bodies());
        $this->assertNoLinks();
    }

    public function testAPlaceKeepsItsBracketsAndOneThatOnlySaysOnlineIsLeftOut(): void
    {
        $this->store('floor@test', self::meeting('floor@test', '20261022T100000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:Herengracht office (3rd floor)']));
        $this->store('tbd@test', self::meeting('tbd@test', '20261022T120000', ['CONFERENCE;VALUE=URI:https://video.example.com/room', 'LOCATION:(TBD)']));
        $this->store('vergadering@test', self::meeting('vergadering@test', '20261022T140000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:Microsoft Teams-vergadering']));
        $this->store('word@test', self::meeting('word@test', '20261022T160000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:Teams']));
        $this->store('online@test', self::meeting('online@test', '20261023T100000', ['CONFERENCE;VALUE=URI:https://video.example.com/room', 'LOCATION:Online']));
        $this->store('dots@test', self::meeting('dots@test', '20261023T120000', ['X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', 'LOCATION:...']));

        $this->planAt(self::NOW);

        self::assertSame([
            'floor@test: Thursday 22 October, 10:00 to 11:00, on Microsoft Teams. Or in Herengracht office (3rd floor).',
            'tbd@test: Thursday 22 October, 12:00 to 13:00, online. Or in (TBD).',
            'vergadering@test: Thursday 22 October, 14:00 to 15:00, on Microsoft Teams.',
            'word@test: Thursday 22 October, 16:00 to 17:00, on Microsoft Teams.',
            'online@test: Friday 23 October, 10:00 to 11:00, online.',
            'dots@test: Friday 23 October, 12:00 to 13:00, on Google Meet.',
        ], $this->bodies());
    }

    public function testLookalikeAndBrokenLinksAreNotCalledAnApp(): void
    {
        $this->store('suffix@test', self::meeting('suffix@test', '20261022T100000', ['CONFERENCE;VALUE=URI:https://teams.microsoft.com.evil.example/l/meetup-join/1']));
        // A Cyrillic "o" in "microsoft".
        $this->store('homograph@test', self::meeting('homograph@test', '20261022T120000', ["CONFERENCE;VALUE=URI:https://teams.micr\u{43E}soft.com/l/meetup-join/1"]));
        $this->store('fragment@test', self::meeting('fragment@test', '20261022T140000', ['CONFERENCE;VALUE=URI:https://evil.example#@teams.microsoft.com/l/meetup-join/1']));
        // A conference property without an address.
        $this->store('empty@test', self::meeting('empty@test', '20261022T160000', ['X-GOOGLE-CONFERENCE:https://', 'LOCATION:Room 1']));

        $this->planAt(self::NOW);

        self::assertSame([
            'suffix@test: Thursday 22 October, 10:00 to 11:00, online.',
            'homograph@test: Thursday 22 October, 12:00 to 13:00, online.',
            'fragment@test: Thursday 22 October, 14:00 to 15:00, online.',
            'empty@test: Thursday 22 October, 16:00 to 17:00, Room 1',
        ], $this->bodies());
        $this->assertNoLinks();
    }

    public function testLinksWithoutASchemeGoAndPlaceNamesWithADotAndASlashStay(): void
    {
        $this->store('ip@test', self::meeting('ip@test', '20261022T100000', ['LOCATION:192.168.1.5/room?pwd=1']));
        $this->store('query@test', self::meeting('query@test', '20261022T120000', ['LOCATION:Room 6 zoom.us?pwd=abc']));
        $this->store('pauli@test', self::meeting('pauli@test', '20261022T140000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:St.Pauli/Hamburg']));
        $this->store('district@test', self::meeting('district@test', '20261022T160000', ['LOCATION:Kantoor Amsterdam.Zuid/WTC']));

        $this->planAt(self::NOW);

        self::assertSame([
            'ip@test: Thursday 22 October, 10:00 to 11:00',
            'query@test: Thursday 22 October, 12:00 to 13:00, Room 6',
            'pauli@test: Thursday 22 October, 14:00 to 15:00, on Microsoft Teams. Or in St.Pauli/Hamburg.',
            'district@test: Thursday 22 October, 16:00 to 17:00, Kantoor Amsterdam.Zuid/WTC',
        ], $this->bodies());
        $this->assertNoLinks();
    }

    public function testWhatALinkStoodInGoesWithItAndAPlaceKeepsItsOwnPunctuation(): void
    {
        $this->store('comma@test', self::meeting('comma@test', '20261022T100000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:https://zoom.us/j/1?pwd=a\;tk=SECRET\, Room 1']));
        $this->store('see@test', self::meeting('see@test', '20261022T120000', ['LOCATION:Room 2 (see https://a.example/x)']));
        $this->store('label@test', self::meeting('label@test', '20261022T140000', ['LOCATION:Room 3 [link: https://a.example/x ]']));
        $this->store('colon@test', self::meeting('colon@test', '20261022T160000', ['LOCATION:Room 4: https://a.example/x']));
        $this->store('bang@test', self::meeting('bang@test', '20261023T100000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:Room 5!']));
        // A phone capitalises the first letter of a typed link.
        $this->store('capital@test', self::meeting('capital@test', '20261023T120000', ['LOCATION:Room 9 Zoom.us/j/123?pwd=abc']));
        $this->store('period@test', self::meeting('period@test', '20261023T140000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:Microsoft Teams Meeting.']));
        $this->store('middle@test', self::meeting('middle@test', '20261023T160000', ['LOCATION:Room (see https://a.example/x) and (see https://b.example/y) hall']));

        $this->planAt(self::NOW);

        self::assertSame([
            'comma@test: Thursday 22 October, 10:00 to 11:00, on Microsoft Teams. Or in Room 1.',
            'see@test: Thursday 22 October, 12:00 to 13:00, Room 2',
            'label@test: Thursday 22 October, 14:00 to 15:00, Room 3',
            'colon@test: Thursday 22 October, 16:00 to 17:00, Room 4',
            'bang@test: Friday 23 October, 10:00 to 11:00, on Microsoft Teams. Or in Room 5!',
            'capital@test: Friday 23 October, 12:00 to 13:00, Room 9',
            'period@test: Friday 23 October, 14:00 to 15:00, on Microsoft Teams.',
            'middle@test: Friday 23 October, 16:00 to 17:00, Room and hall',
        ], $this->bodies());
        $this->assertNoLinks();
    }

    public function testARoomNamedAfterTheAppIsAPlace(): void
    {
        $this->store('zoomroom@test', self::meeting('zoomroom@test', '20261022T100000', ['CONFERENCE;VALUE=URI:https://zoom.us/j/123', 'LOCATION:Zoom Room']));
        $this->store('teamsroom@test', self::meeting('teamsroom@test', '20261022T120000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:Teams-kamer']));
        $this->store('meetkim@test', self::meeting('meetkim@test', '20261022T140000', ['X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij', 'LOCATION:Meet Kim']));

        $this->planAt(self::NOW);

        self::assertSame([
            'zoomroom@test: Thursday 22 October, 10:00 to 11:00, on Zoom. Or in Zoom Room.',
            'teamsroom@test: Thursday 22 October, 12:00 to 13:00, on Microsoft Teams. Or in Teams-kamer.',
            'meetkim@test: Thursday 22 October, 14:00 to 15:00, on Google Meet. Or in Meet Kim.',
        ], $this->bodies());
    }

    public function testNonLatinAndLongPlacesAreShownWhole(): void
    {
        $long = trim(str_repeat('Long place ', 60));
        $this->store('arabic@test', self::meeting('arabic@test', '20261022T100000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:غرفة ٣']));
        $this->store('long@test', self::meeting('long@test', '20261022T120000', ['CONFERENCE;VALUE=URI:'.self::TEAMS, 'LOCATION:'.$long]));

        $this->planAt(self::NOW);

        self::assertSame([
            'arabic@test: Thursday 22 October, 10:00 to 11:00, on Microsoft Teams. Or in غرفة ٣.',
            'long@test: Thursday 22 October, 12:00 to 13:00, on Microsoft Teams. Or in '.$long.'.',
        ], $this->bodies());
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

    /** No planned notification (reminder or leave-now) holds a link. */
    private function assertNoLinks(): void
    {
        foreach ($this->bodies() as $body) {
            self::assertDoesNotMatchRegularExpression('~https?:|://|www\\.|microsoft\\.com|secret~i', $body, 'No link in a notification.');
        }
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
