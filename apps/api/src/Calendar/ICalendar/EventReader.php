<?php

declare(strict_types=1);

namespace App\Calendar\ICalendar;

use App\Enum\EventStatus;
use App\Enum\EventVisibility;
use App\Enum\NotificationChannel;
use App\Enum\ParticipationStatus;
use App\Enum\Transparency;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\Property;
use Sabre\VObject\Property\ICalendar\DateTime as DateTimeProperty;
use Sabre\VObject\Property\ICalendar\Duration as DurationProperty;
use Sabre\VObject\Recur\MaxInstancesExceededException;
use Sabre\VObject\TimeZoneUtil;

/**
 * Reads one VEVENT into {@see EventData}: time zones resolved to IANA names (Windows names and custom VTIMEZONEs
 * included), DURATION turned into an end, recurrence reduced to its rule plus occurrence keys, and the end of the
 * series computed for range queries.
 *
 * @phpstan-import-type Address from EventData
 * @phpstan-import-type Attendee from EventData
 * @phpstan-import-type Reminder from EventData
 */
final class EventReader
{
    /** Series longer than this are treated as endless for range queries, which only widens them. */
    private const int MAX_COUNTED_OCCURRENCES = 20000;
    /** Tresso's own properties: alarm channels, travel time, and "no reminders" for an event without alarms. */
    public const string CHANNELS = 'X-TRESSO-CHANNELS';
    public const string TRAVEL = 'X-TRESSO-TRAVEL-MINUTES';
    public const string DEFAULT_REMINDERS = 'X-TRESSO-DEFAULT-REMINDERS';

    /**
     * @param list<string> $selfAddresses the owner's addresses, lower case, to find their own response
     */
    public static function read(VEvent $event, VCalendar $calendar, array $selfAddresses): EventData
    {
        try {
            return self::readValues($event, $calendar, $selfAddresses);
        } catch (InvalidCalendarData $e) {
            throw $e;
        } catch (\Exception $e) {
            // sabre parses dates and durations only when they are read, and PHP refuses dates and intervals it
            // cannot hold: whatever fails here makes the event unreadable, never the caller's batch.
            throw new InvalidCalendarData(\sprintf('Event %s has a value that cannot be read: %s', Props::uid($event), $e->getMessage()), previous: $e);
        }
    }

    /**
     * @param list<string> $selfAddresses
     */
    private static function readValues(VEvent $event, VCalendar $calendar, array $selfAddresses): EventData
    {
        $utc = new \DateTimeZone('UTC');
        $uid = Props::uid($event);
        if ('' === $uid) {
            throw new InvalidCalendarData('An event has no UID.');
        }
        if (mb_strlen($uid) > Props::MAX_UID_LENGTH) {
            throw new InvalidCalendarData(\sprintf('An event has a UID longer than %d characters.', Props::MAX_UID_LENGTH));
        }
        $dtStart = Props::dateTime($event, 'DTSTART');
        if (null === $dtStart) {
            throw new InvalidCalendarData(\sprintf('Event %s has no start.', $uid));
        }

        $start = self::time($dtStart, $calendar);
        $end = self::end($event, $start, $calendar);
        $startsAt = $start->toInstant($utc)->setTimezone($utc);
        $endsAt = $end->toInstant($utc)->setTimezone($utc);
        if ($endsAt < $startsAt) {
            $end = $start;
            $endsAt = $startsAt;
        }

        if (!self::storable($startsAt) || !self::storable($endsAt) || !self::storableValue($start) || !self::storableValue($end)) {
            throw new InvalidCalendarData(\sprintf('Event %s lies outside the years 1 to 9999.', $uid));
        }

        $recurrenceKey = CalendarDocument::recurrenceKey($event);
        if ('' !== $recurrenceKey && !RecurrenceKey::isValid($recurrenceKey)) {
            throw new InvalidCalendarData(\sprintf('Event %s changes an occurrence outside the years 1 to 9999.', $uid));
        }

        $rrule = '' === $recurrenceKey ? Props::text($event, 'RRULE') : null;
        $rdates = '' === $recurrenceKey ? self::keys($event, 'RDATE') : [];
        $exdates = '' === $recurrenceKey ? self::keys($event, 'EXDATE') : [];
        $recurring = null !== $rrule || [] !== $rdates;
        // A rule sabre cannot expand (FREQ=FORTNIGHTLY, an X- part, RSCALE) is kept as written, for the devices that
        // expand it themselves; the server shows its first occurrence ({@see Occurrences::starts()}) and the series
        // counts as endless.
        $ruleReadable = null === $rrule || Occurrences::ruleReadable($rrule, $startsAt);
        $recurrenceId = Props::get($event, 'RECURRENCE-ID');
        $thisAndFuture = null !== $recurrenceId && 'THISANDFUTURE' === strtoupper(Props::param($recurrenceId, 'RANGE') ?? '');

        $organizer = self::organizer($event);
        $attendees = self::attendees($event);

        return new EventData(
            $uid,
            $recurrenceKey,
            Props::sequence($event),
            EventStatus::fromICalendar(self::text($event, 'STATUS')),
            self::text($event, 'SUMMARY') ?? '',
            self::text($event, 'DESCRIPTION') ?? '',
            self::text($event, 'LOCATION') ?? '',
            self::url($event),
            Transparency::fromICalendar(self::text($event, 'TRANSP')),
            EventVisibility::fromICalendar(self::text($event, 'CLASS')),
            $start,
            $end,
            $startsAt,
            $endsAt,
            $recurring ? $rrule : null,
            $rdates,
            $exdates,
            // An override that changes the future reaches as far as its series does, which only the series knows.
            match (true) {
                $recurring => $ruleReadable ? self::seriesEnd($event, $endsAt->getTimestamp() - $startsAt->getTimestamp()) : null,
                $thisAndFuture => null,
                default => $endsAt,
            },
            $organizer,
            $attendees,
            self::selfPartstat($organizer, $attendees, $selfAddresses),
            self::reminders($event),
            ConferenceDetector::detect($event),
            self::travelMinutes($event),
            self::usesDefaultReminders($event),
            self::isImportant($event),
            $thisAndFuture,
        );
    }

    public static function time(DateTimeProperty $property, VCalendar $calendar): EventTime
    {
        if (!$property->hasTime()) {
            return EventTime::date($property->getDateTime(new \DateTimeZone('UTC')));
        }
        if ($property->isFloating()) {
            return EventTime::dateTime($property->getDateTime(new \DateTimeZone('UTC')), null);
        }

        $value = $property->getDateTime(new \DateTimeZone('UTC'));
        $tzid = Props::param($property, 'TZID');
        if (null !== $tzid) {
            $value = $value->setTimezone(TimeZoneUtil::getTimeZone($tzid, $calendar));
        }
        $name = $value->getTimezone()->getName();
        if ('Z' === $name || !self::isIanaZone($name)) {
            // A fixed offset that matches no known zone: keep the instant, in UTC.
            $value = $value->setTimezone(new \DateTimeZone('UTC'));
            $name = 'UTC';
        }

        return EventTime::dateTime($value, $name);
    }

    public static function isIanaZone(string $name): bool
    {
        return 'UTC' === $name || \in_array($name, \DateTimeZone::listIdentifiers(\DateTimeZone::ALL_WITH_BC), true);
    }

    private static function end(VEvent $event, EventTime $start, VCalendar $calendar): EventTime
    {
        $dtEnd = Props::dateTime($event, 'DTEND');
        if (null !== $dtEnd && $dtEnd->hasTime() === !$start->isDate) {
            return self::time($dtEnd, $calendar);
        }

        $startValue = $start->toInstant(new \DateTimeZone($start->timeZone ?? 'UTC'));
        $duration = Props::get($event, 'DURATION');
        if ($duration instanceof DurationProperty) {
            $endValue = $startValue->add($duration->getDateInterval());
        } elseif (null !== $dtEnd) {
            // DTEND of another kind than DTSTART (date against date-time): keep the length it describes.
            $endValue = $startValue->add($start->isDate ? new \DateInterval('P1D') : new \DateInterval('PT0S'));
            $other = $dtEnd->getDateTime(new \DateTimeZone($start->timeZone ?? 'UTC'));
            if ($other > $startValue) {
                $endValue = $start->isDate ? $other->setTime(0, 0) : $other;
            }
        } else {
            // RFC 5545 3.6.1: a date start without end lasts one day, a date-time start without end takes no time.
            $endValue = $start->isDate ? $startValue->add(new \DateInterval('P1D')) : $startValue;
        }

        return $start->isDate ? EventTime::date($endValue) : EventTime::dateTime($endValue, $start->timeZone);
    }

    /**
     * End of the last occurrence, or null when the series does not end (or has more occurrences than are worth
     * counting).
     */
    private static function seriesEnd(VEvent $master, int $lengthSeconds): ?\DateTimeImmutable
    {
        // An RRULE without COUNT or UNTIL never ends, whatever RDATEs come with it.
        $rule = Props::text($master, 'RRULE');
        if (null !== $rule && 1 !== preg_match('/(^|;)(COUNT|UNTIL)=/i', $rule)) {
            return null;
        }

        $last = null;
        $count = 0;
        try {
            // In order, RRULE and RDATE together (Occurrences::starts), so the last start is the series' end.
            foreach (Occurrences::starts($master, new \DateTimeZone('UTC')) as $start) {
                $last = $start;
                if (++$count > self::MAX_COUNTED_OCCURRENCES) {
                    return null;
                }
            }
        } catch (MaxInstancesExceededException|InvalidCalendarData) {
            return null;
        }

        $end = null === $last ? null : $last->setTimezone(new \DateTimeZone('UTC'))->modify(\sprintf('+%d seconds', $lengthSeconds));

        // Past what the database holds the series counts as endless, which only widens it.
        return null !== $end && self::storable($end) ? $end : null;
    }

    /** Whether an instant fits a timestamp column: the years 1 to 9999. */
    private static function storable(\DateTimeImmutable $instant): bool
    {
        $year = (int) $instant->setTimezone(new \DateTimeZone('UTC'))->format('Y');

        return $year >= 1 && $year <= 9999;
    }

    /** Whether a wall clock value fits its column (Y-m-d or Y-m-d\TH:i:s with a four digit year from 1 on). */
    private static function storableValue(EventTime $time): bool
    {
        return 1 === preg_match('/^(?!0000)\d{4}-\d{2}-\d{2}/', $time->value) && \strlen($time->value) <= 19;
    }


    /**
     * @return list<string>
     */
    private static function keys(VEvent $event, string $name): array
    {
        $keys = [];
        foreach (Props::dateTimes($event, $name) as $property) {
            array_push($keys, ...RecurrenceKey::allFromProperty($property));
        }
        // An exception date no occurrence can have (year 10000) matches nothing anyway.
        $keys = array_filter($keys, RecurrenceKey::isValid(...));
        $keys = array_values(array_unique($keys));
        sort($keys);

        return $keys;
    }

    /**
     * @return Address|null
     */
    private static function organizer(VEvent $event): ?array
    {
        $organizer = Props::get($event, 'ORGANIZER');
        if (null === $organizer) {
            return null;
        }
        $address = self::address(Props::value($organizer));

        return null === $address ? null : ['address' => $address, 'name' => self::param($organizer, 'CN')];
    }

    /**
     * @return list<Attendee>
     */
    private static function attendees(VEvent $event): array
    {
        $attendees = [];
        foreach (Props::all($event, 'ATTENDEE') as $attendee) {
            $address = self::address(Props::value($attendee));
            if (null === $address || isset($attendees[$address])) {
                continue;
            }
            $attendees[$address] = [
                'address' => $address,
                'name' => self::param($attendee, 'CN'),
                'role' => match (strtoupper((string) self::param($attendee, 'ROLE'))) {
                    'CHAIR' => 'chair',
                    'OPT-PARTICIPANT' => 'optional',
                    'NON-PARTICIPANT' => 'non-participant',
                    default => 'required',
                },
                'partstat' => ParticipationStatus::fromICalendar(self::param($attendee, 'PARTSTAT'))->value,
                'rsvp' => 'TRUE' === strtoupper((string) self::param($attendee, 'RSVP')),
                'kind' => match (strtoupper((string) self::param($attendee, 'CUTYPE'))) {
                    'GROUP' => 'group',
                    'RESOURCE' => 'object',
                    'ROOM' => 'room',
                    'UNKNOWN' => 'unknown',
                    default => 'individual',
                },
            ];
        }

        return array_values($attendees);
    }

    /**
     * @param Address|null   $organizer
     * @param list<Attendee> $attendees
     * @param list<string>   $selfAddresses
     */
    private static function selfPartstat(?array $organizer, array $attendees, array $selfAddresses): ?ParticipationStatus
    {
        if (null !== $organizer && \in_array($organizer['address'], $selfAddresses, true)) {
            return null;
        }
        foreach ($attendees as $attendee) {
            if (\in_array($attendee['address'], $selfAddresses, true)) {
                return ParticipationStatus::from($attendee['partstat']);
            }
        }

        return null;
    }

    /**
     * @return list<Reminder>
     */
    private static function reminders(VEvent $event): array
    {
        $reminders = [];
        foreach (Props::components($event, 'VALARM') as $alarm) {
            $trigger = Props::get($alarm, 'TRIGGER');
            if (null === $trigger) {
                continue;
            }
            $action = strtolower(Props::text($alarm, 'ACTION') ?? 'DISPLAY');
            $channels = self::channels($alarm, $action);
            if ($trigger instanceof DateTimeProperty) {
                $reminders[] = ['action' => $action, 'trigger' => null, 'relatedTo' => 'start', 'at' => RecurrenceKey::fromInstant($trigger->getDateTime(new \DateTimeZone('UTC'))), 'channels' => $channels];
                continue;
            }
            $reminders[] = [
                'action' => $action,
                'trigger' => strtoupper(trim(Props::value($trigger))),
                'relatedTo' => 'END' === strtoupper((string) self::param($trigger, 'RELATED')) ? 'end' : 'start',
                'at' => null,
                'channels' => $channels,
            ];
        }

        return $reminders;
    }

    /**
     * Tresso's channels for an alarm (X-TRESSO-CHANNELS), else what its action means: email for EMAIL, the phone and
     * the desktop otherwise.
     *
     * @return list<string>
     */
    private static function channels(\Sabre\VObject\Component $alarm, string $action): array
    {
        $listed = Props::text($alarm, self::CHANNELS);
        if (null !== $listed) {
            $channels = array_values(array_unique(array_filter(
                array_map(static fn (string $channel): string => strtolower(trim($channel)), explode(',', $listed)),
                static fn (string $channel): bool => \in_array($channel, NotificationChannel::values(), true),
            )));
            if ([] !== $channels) {
                return $channels;
            }
        }

        return 'email' === $action ? [NotificationChannel::Email->value] : [NotificationChannel::Phone->value, NotificationChannel::Desktop->value];
    }

    /** RFC 5545 PRIORITY: 1 to 4 is high; 0 is undefined. */
    private static function isImportant(VEvent $event): bool
    {
        $priority = Props::int($event, 'PRIORITY');

        return $priority >= 1 && $priority <= 4;
    }

    /** Tresso's own travel time, else Apple Calendar's travel duration. */
    private static function travelMinutes(VEvent $event): ?int
    {
        $minutes = Props::text($event, self::TRAVEL);
        if (null !== $minutes && ctype_digit($minutes)) {
            return min((int) $minutes, 1440);
        }
        $apple = Props::get($event, 'X-APPLE-TRAVEL-DURATION');
        if (null !== $apple) {
            try {
                $interval = new \DateInterval(ltrim(strtoupper(trim(Props::value($apple))), '+'));
            } catch (\Exception) {
                return null;
            }

            return min($interval->d * 1440 + $interval->h * 60 + $interval->i, 1440);
        }

        return null;
    }

    private static function usesDefaultReminders(VEvent $event): bool
    {
        return [] === Props::components($event, 'VALARM') && 'FALSE' !== strtoupper(Props::text($event, self::DEFAULT_REMINDERS) ?? '');
    }

    private static function address(string $value): ?string
    {
        $value = trim($value);
        if (str_starts_with(strtolower($value), 'mailto:')) {
            $value = substr($value, 7);
        }
        $value = mb_strtolower(rawurldecode($value));

        return false === filter_var($value, \FILTER_VALIDATE_EMAIL) ? null : $value;
    }

    private static function url(VEvent $event): ?string
    {
        $url = self::text($event, 'URL');

        return null !== $url && 1 === preg_match('~^https?://~i', $url) && \strlen($url) <= 2048 ? $url : null;
    }

    private static function text(VEvent $event, string $name): ?string
    {
        return Props::text($event, $name);
    }

    private static function param(Property $property, string $name): ?string
    {
        return Props::param($property, $name);
    }
}
