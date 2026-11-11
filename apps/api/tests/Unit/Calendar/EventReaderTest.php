<?php

declare(strict_types=1);

namespace App\Tests\Unit\Calendar;

use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\EventReader;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Enum\EventStatus;
use App\Enum\ParticipationStatus;
use App\Enum\Transparency;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class EventReaderTest extends TestCase
{
    public function testReadsWindowsTimeZonesAsIanaZones(): void
    {
        $data = self::read(['DTSTART;TZID=W. Europe Standard Time:20261021T140000', 'DTEND;TZID=W. Europe Standard Time:20261021T150000']);

        self::assertSame(['dateTime' => '2026-10-21T14:00:00', 'timeZone' => 'Europe/Berlin'], $data->start->toArray());
        self::assertSame('2026-10-21T12:00:00+00:00', $data->startsAt->format(\DATE_ATOM));
        self::assertSame('2026-10-21T13:00:00+00:00', $data->endsAt->format(\DATE_ATOM));
    }

    public function testTurnsADurationIntoAnEnd(): void
    {
        $data = self::read(['DTSTART:20261021T140000Z', 'DURATION:PT1H30M']);

        self::assertSame(['dateTime' => '2026-10-21T15:30:00', 'timeZone' => 'UTC'], $data->end->toArray());
    }

    public function testADateWithoutEndLastsOneDay(): void
    {
        $data = self::read(['DTSTART;VALUE=DATE:20261021']);

        self::assertTrue($data->isAllDay());
        self::assertSame(['date' => '2026-10-22'], $data->end->toArray());
    }

    public function testKeepsFloatingTimesWithoutZone(): void
    {
        $data = self::read(['DTSTART:20261021T080000', 'DTEND:20261021T083000']);

        self::assertSame(['dateTime' => '2026-10-21T08:00:00', 'timeZone' => null], $data->start->toArray());
    }

    public function testReadsTheOwnResponseAndTheOrganizer(): void
    {
        $data = self::read([
            'DTSTART:20261021T140000Z',
            'ORGANIZER;CN=Anna:mailto:Anna@Finance.example',
            'ATTENDEE;CN=Kim;PARTSTAT=TENTATIVE;ROLE=OPT-PARTICIPANT;RSVP=TRUE:mailto:kim@company.example',
            'ATTENDEE;CUTYPE=ROOM;PARTSTAT=ACCEPTED:mailto:room3@company.example',
        ], ['kim@company.example']);

        self::assertSame(['address' => 'anna@finance.example', 'name' => 'Anna'], $data->organizer);
        self::assertSame(ParticipationStatus::Tentative, $data->selfPartstat);
        self::assertSame(['address' => 'kim@company.example', 'name' => 'Kim', 'role' => 'optional', 'partstat' => 'tentative', 'rsvp' => true, 'kind' => 'individual'], $data->attendees[0]);
        self::assertSame('room', $data->attendees[1]['kind']);
    }

    public function testTheOrganizerHasNoOwnResponse(): void
    {
        $data = self::read(['DTSTART:20261021T140000Z', 'ORGANIZER:mailto:kim@company.example', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:kim@company.example'], ['kim@company.example']);

        self::assertNull($data->selfPartstat);
    }

    public function testComputesTheEndOfAFiniteSeries(): void
    {
        $data = self::read(['DTSTART:20261019T090000Z', 'DTEND:20261019T093000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20261020T090000Z']);

        self::assertSame('FREQ=DAILY;COUNT=3', $data->rrule);
        self::assertSame(['20261020T090000Z'], $data->exdates);
        self::assertSame('2026-10-21T09:30:00+00:00', $data->seriesEndsAt?->format(\DATE_ATOM));
    }

    public function testAnEndlessSeriesHasNoEnd(): void
    {
        self::assertNull(self::read(['DTSTART:20261019T090000Z', 'RRULE:FREQ=WEEKLY'])->seriesEndsAt);
    }

    public function testAnEndlessRuleWithExtraDatesHasNoEnd(): void
    {
        self::assertNull(self::read(['DTSTART:20261019T090000Z', 'RRULE:FREQ=WEEKLY', 'RDATE:20261020T090000Z'])->seriesEndsAt);
    }

    public function testTheSeriesEndsAtItsLatestDateInItsOwnZone(): void
    {
        $data = self::read(['DTSTART:20261019T090000Z', 'DTEND:20261019T093000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'RDATE;TZID=America/New_York:20261105T090000', 'RDATE:20261101T090000Z']);

        self::assertSame('2026-11-05T14:30:00+00:00', $data->seriesEndsAt?->format(\DATE_ATOM));
    }

    public function testAZoneOfItsOwnIsReadFromTheEventsDefinition(): void
    {
        $calendar = CalendarDocument::parse(implode("\r\n", [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
            'BEGIN:VTIMEZONE', 'TZID:Customized Time Zone',
            'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
            'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT',
            'END:VTIMEZONE',
            'BEGIN:VEVENT', 'UID:custom@example', 'DTSTART;TZID=Customized Time Zone:20261021T140000', 'DTEND;TZID=Customized Time Zone:20261021T150000', 'END:VEVENT',
            'END:VCALENDAR', '',
        ]));

        $data = EventReader::read(CalendarDocument::events($calendar)[0], $calendar, []);

        self::assertSame('2026-10-21T12:00:00+00:00', $data->startsAt->format(\DATE_ATOM));
    }

    public function testReadsStatusTransparencyAndReminders(): void
    {
        $data = self::read(['DTSTART:20261019T090000Z', 'STATUS:CANCELLED', 'TRANSP:TRANSPARENT', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT5M', 'END:VALARM', 'BEGIN:VALARM', 'ACTION:EMAIL', 'TRIGGER;VALUE=DATE-TIME:20261018T120000Z', 'END:VALARM']);

        self::assertSame(EventStatus::Cancelled, $data->status);
        self::assertSame(Transparency::Free, $data->transparency);
        self::assertSame([
            ['action' => 'display', 'trigger' => '-PT5M', 'relatedTo' => 'end', 'at' => null, 'channels' => ['phone', 'desktop']],
            ['action' => 'email', 'trigger' => null, 'relatedTo' => 'start', 'at' => '20261018T120000Z', 'channels' => ['email']],
        ], $data->reminders);
    }

    /**
     * @param list<string> $properties
     */
    #[DataProvider('conferences')]
    public function testFindsTheOnlineMeeting(array $properties, string $provider, string $url): void
    {
        $conference = self::read(['DTSTART:20261019T090000Z', ...$properties])->conference;

        self::assertNotNull($conference);
        self::assertSame($provider, $conference['provider']);
        self::assertSame($url, $conference['url']);
    }

    /**
     * @return iterable<string, array{list<string>, string, string}>
     */
    public static function conferences(): iterable
    {
        yield 'Google property' => [['X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij'], 'meet', 'https://meet.google.com/abc-defg-hij'];
        yield 'Teams property' => [['X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting'], 'teams', 'https://teams.microsoft.com/l/meetup-join/19%3ameeting'];
        yield 'RFC 7986' => [['CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://example.zoom.us/j/123456'], 'zoom', 'https://example.zoom.us/j/123456'];
        yield 'link in the description' => [['DESCRIPTION:Join: https://company.webex.com/meet/kim or call'], 'webex', 'https://company.webex.com/meet/kim'];
    }

    public function testReadsTressoChannelsTravelTimeAndTheDefaults(): void
    {
        $own = self::read(['DTSTART:20261019T090000Z', 'X-TRESSO-TRAVEL-MINUTES:25', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT30M', 'X-TRESSO-CHANNELS:phone,email,pager', 'END:VALARM']);
        self::assertSame(['phone', 'email'], $own->reminders[0]['channels'], 'Unknown channels are left out.');
        self::assertSame(25, $own->travelMinutes);
        self::assertFalse($own->defaultReminders);

        self::assertTrue(self::read(['DTSTART:20261019T090000Z'])->defaultReminders);
        self::assertFalse(self::read(['DTSTART:20261019T090000Z', 'X-TRESSO-DEFAULT-REMINDERS:FALSE'])->defaultReminders);
        self::assertSame(45, self::read(['DTSTART:20261019T090000Z', 'X-APPLE-TRAVEL-DURATION;VALUE=DURATION:PT45M'])->travelMinutes);
    }

    public function testRefusesEventsWithoutUid(): void
    {
        $calendar = CalendarDocument::parse("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nDTSTART:20261019T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");

        $this->expectException(InvalidCalendarData::class);
        EventReader::read(CalendarDocument::events($calendar)[0], $calendar, []);
    }

    /**
     * @return iterable<string, array{list<string>}>
     */
    public static function valuesTheDatabaseOrSabreCannotTake(): iterable
    {
        yield 'a start with dashes' => [['DTSTART:2026-10-19T09:00:00']];
        yield 'an end with dashes' => [['DTSTART:20261019T090000Z', 'DTEND:2026-10-19T10:00:00']];
        yield 'a duration without P' => [['DTSTART:20261019T090000Z', 'DURATION:1H']];
        yield 'a frequency sabre does not know' => [['DTSTART:20261019T090000Z', 'RRULE:FREQ=FORTNIGHTLY;COUNT=3']];
        yield 'a frequency sabre does not know, without an end' => [['DTSTART:20261019T090000Z', 'RRULE:FREQ=FORTNIGHTLY']];
        yield 'an exception date that is not a date' => [['DTSTART:20261019T090000Z', 'RRULE:FREQ=WEEKLY', 'EXDATE:garbage']];
        yield 'a recurrence id that is not a date' => [['DTSTART:20261019T090000Z', 'RECURRENCE-ID:garbage']];
    }

    /**
     * @param list<string> $properties
     */
    #[DataProvider('valuesTheDatabaseOrSabreCannotTake')]
    public function testRefusesValuesSabreCannotRead(array $properties): void
    {
        $this->expectException(InvalidCalendarData::class);
        self::read($properties);
    }

    public function testRefusesAUidLongerThanTheColumn(): void
    {
        $uid = str_repeat('x', 1025);
        $calendar = CalendarDocument::parse("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:".$uid."\r\nDTSTART:20261019T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");

        $this->expectException(InvalidCalendarData::class);
        EventReader::read(CalendarDocument::events($calendar)[0], $calendar, []);
    }

    public function testASequenceLargerThanTheColumnIsReadAsTheLargestItHolds(): void
    {
        self::assertSame(2147483647, self::read(['DTSTART:20261019T090000Z', 'SEQUENCE:3000000000'])->sequence);
        self::assertSame(0, self::read(['DTSTART:20261019T090000Z', 'SEQUENCE:-4'])->sequence);
    }

    /**
     * @param list<string> $properties
     * @param list<string> $self
     */
    private static function read(array $properties, array $self = []): \App\Calendar\ICalendar\EventData
    {
        $calendar = CalendarDocument::parse(implode("\r\n", ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'BEGIN:VEVENT', 'UID:test@example', ...$properties, 'END:VEVENT', 'END:VCALENDAR', '']));

        return EventReader::read(CalendarDocument::events($calendar)[0], $calendar, $self);
    }
}
