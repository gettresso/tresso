<?php

declare(strict_types=1);

namespace App\Calendar\ICalendar;

use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\Reader;

/**
 * Reading and writing iCalendar text with sabre/vobject, with the checks every entry point needs.
 */
final class CalendarDocument
{
    public const string PRODID = '-//Tresso//Tresso Calendar//EN';
    /** One calendar object is never this large in practice; larger input is refused. */
    public const int MAX_BYTES = 1048576;

    public static function parse(string $ical): VCalendar
    {
        ObservanceTimezoneGuesser::register();
        if (\strlen($ical) > self::MAX_BYTES) {
            throw new InvalidCalendarData('The calendar object is too large.');
        }
        if (str_contains($ical, "\0")) {
            // sabre keeps it, and no text column takes it.
            throw new InvalidCalendarData('The calendar object holds a NUL character.');
        }
        try {
            $calendar = Reader::read($ical, Reader::OPTION_FORGIVING | Reader::OPTION_IGNORE_INVALID_LINES);
        } catch (\Exception $e) {
            // ParseException, and InvalidDataException for values sabre reads at once (an RRULE without "=").
            throw new InvalidCalendarData('Not valid iCalendar data: '.$e->getMessage(), previous: $e);
        }
        if (!$calendar instanceof VCalendar) {
            throw new InvalidCalendarData('Not an iCalendar object.');
        }

        return $calendar;
    }

    public static function create(): VCalendar
    {
        $calendar = new VCalendar();
        Props::set($calendar, 'PRODID', self::PRODID);

        return $calendar;
    }

    /**
     * @return list<VEvent>
     */
    public static function events(VCalendar $calendar): array
    {
        $events = [];
        foreach ($calendar->select('VEVENT') as $event) {
            if ($event instanceof VEvent) {
                $events[] = $event;
            }
        }

        return $events;
    }

    /**
     * The VEVENTs grouped by UID: one group per resource.
     *
     * @return array<string, list<VEvent>>
     */
    public static function eventsByUid(VCalendar $calendar): array
    {
        $groups = [];
        foreach (self::events($calendar) as $event) {
            $uid = Props::uid($event);
            if ('' !== $uid) {
                $groups[$uid][] = $event;
            }
        }

        return $groups;
    }

    /**
     * A calendar with only the events of one UID and the time zones they use, as one resource stores it.
     */
    public static function forUid(VCalendar $source, string $uid): VCalendar
    {
        $calendar = self::create();
        $zones = [];
        foreach (self::eventsByUid($source)[$uid] ?? [] as $event) {
            $calendar->add(clone $event);
            foreach ($event->children() as $property) {
                if ($property instanceof \Sabre\VObject\Property && null !== ($tzid = Props::param($property, 'TZID'))) {
                    $zones[$tzid] = true;
                }
            }
        }
        foreach (Props::components($source, 'VTIMEZONE') as $zone) {
            if (isset($zones[Props::text($zone, 'TZID') ?? ''])) {
                $calendar->add(clone $zone);
            }
        }

        return $calendar;
    }

    /** The key of an override, or '' for a master or single event. */
    public static function recurrenceKey(VEvent $event): string
    {
        $recurrenceId = Props::dateTime($event, 'RECURRENCE-ID');

        return null === $recurrenceId ? '' : RecurrenceKey::fromProperty($recurrenceId);
    }

    public static function master(VCalendar $calendar): ?VEvent
    {
        foreach (self::events($calendar) as $event) {
            if (null === Props::get($event, 'RECURRENCE-ID')) {
                return $event;
            }
        }

        return null;
    }

    public static function override(VCalendar $calendar, string $recurrenceKey): ?VEvent
    {
        foreach (self::events($calendar) as $event) {
            $recurrenceId = Props::dateTime($event, 'RECURRENCE-ID');
            if (null !== $recurrenceId && RecurrenceKey::fromProperty($recurrenceId) === $recurrenceKey) {
                return $event;
            }
        }

        return null;
    }
}
