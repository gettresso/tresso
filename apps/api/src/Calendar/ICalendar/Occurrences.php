<?php

declare(strict_types=1);

namespace App\Calendar\ICalendar;

use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\InvalidDataException;
use Sabre\VObject\Recur\MaxInstancesExceededException;
use Sabre\VObject\Recur\RRuleIterator;

/**
 * The occurrences of one resource in a range, and turning one occurrence of a series into its own VEVENT (an
 * override), the way RFC 5545 models a changed occurrence.
 *
 * A series is the union of its RRULE and RDATE starts (and DTSTART), less its EXDATEs, with overrides in place of the
 * occurrences they change (RFC 5545 3.8.5). An override with RANGE=THISANDFUTURE (3.8.4.4) changes every later
 * occurrence too, shifted by as much as it moves its own. sabre's EventIterator takes either RRULE or RDATE, not both, and keeps
 * RDATEs in the order written, so the starts are put together here. Floating and all-day times are read in the
 * user's zone; recurrence ids of floating series are their wall-clock times, as RecurrenceKey reads them.
 */
final class Occurrences
{
    /**
     * Steps of a rule walked for one look at a series, the skip to the range included: an old series of a regular
     * frequency is jumped to near the range, so only an endless or huge irregular walk reaches this.
     */
    public const int MAX_STEPS = 100000;

    /**
     * Whether a series repeats more often than hourly. sabre/vobject does not advance such rules reliably, and they
     * would produce more occurrences than anyone can use, so they are refused when stored.
     */
    public static function tooDense(VEvent $event): bool
    {
        $rule = Props::text($event, 'RRULE');

        return null !== $rule && 1 === preg_match('/(^|;)FREQ=(SECONDLY|MINUTELY)(;|$)/i', $rule);
    }

    /**
     * The instances of the resource's events that overlap [$from, $to), one at a time and at most $limit, in order of
     * their start within each series. Each is keyed by the recurrence key of the component it comes from: '' for a
     * single event or the master, the override's for an override and for the occurrences a THISANDFUTURE one changes.
     *
     * @return \Generator<string, VEvent>
     */
    public static function instances(VCalendar $calendar, \DateTimeImmutable $from, \DateTimeImmutable $to, \DateTimeZone $zone, int $limit): \Generator
    {
        $count = 0;
        $master = null;
        $overrides = [];
        foreach (CalendarDocument::events($calendar) as $event) {
            if (null !== Props::get($event, 'RECURRENCE-ID')) {
                $overrides[CalendarDocument::recurrenceKey($event)] = $event;
            } elseif (null !== Props::get($event, 'RRULE') || null !== Props::get($event, 'RDATE')) {
                $master = $event;
            } elseif (self::overlaps($event, $from, $to, $zone)) {
                yield '' => $event;
                if (++$count >= $limit) {
                    return;
                }
            }
        }

        if (null === $master) {
            // Occurrences without their series (invitations to single occurrences): each one on its own.
            foreach ($overrides as $key => $override) {
                if (self::overlaps($override, $from, $to, $zone)) {
                    yield (string) $key => $override;
                    if (++$count >= $limit) {
                        return;
                    }
                }
            }

            return;
        }
        if (self::tooDense($master)) {
            return;
        }

        $ranges = array_filter($overrides, static fn (VEvent $override): bool => self::changesTheFuture($override));
        ksort($ranges, \SORT_STRING);
        $length = self::length($master, $zone);
        // A THISANDFUTURE override may move its occurrences later or earlier; start looking early enough for either.
        $reach = max([0, $length, ...array_map(static fn (VEvent $range): int => abs(self::shift($range, $zone)) + self::length($range, $zone), $ranges)]);
        $seen = [];
        foreach (self::starts($master, $zone, $from->modify(\sprintf('-%d seconds', $reach))) as $key => $start) {
            if ($start >= $to->modify(\sprintf('+%d seconds', $reach))) {
                break;
            }
            $key = (string) $key;
            $seen[$key] = true;
            $source = $key;
            $instance = $overrides[$key] ?? null;
            if (null === $instance) {
                $range = self::rangeFor($ranges, $key);
                $source = null === $range ? '' : CalendarDocument::recurrenceKey($range);
                $instance = null === $range ? self::instance($master, $start, $length) : self::changed($master, $range, $start, $zone);
            }
            if (self::overlaps($instance, $from, $to, $zone)) {
                yield $source => $instance;
                if (++$count >= $limit) {
                    return;
                }
            }
        }
        // Overrides moved into the range from an occurrence outside it, and overrides whose occurrence the series no
        // longer has (clients show those too, as their own event).
        foreach ($overrides as $key => $override) {
            if (!isset($seen[$key]) && self::overlaps($override, $from, $to, $zone)) {
                yield (string) $key => $override;
                if (++$count >= $limit) {
                    return;
                }
            }
        }
    }

    /**
     * The starts of a series in order, by recurrence key: DTSTART, every RRULE and RDATE start, less the EXDATEs. With
     * $from, starts before it are skipped quickly.
     *
     * @return \Generator<string, \DateTimeImmutable>
     */
    public static function starts(VEvent $master, \DateTimeZone $zone, ?\DateTimeImmutable $from = null): \Generator
    {
        $dtStart = Props::dateTime($master, 'DTSTART') ?? throw new InvalidCalendarData('The series has no start.');
        $isDate = !$dtStart->hasTime();
        $floating = true === $dtStart->isFloating();

        $excluded = [];
        foreach (Props::dateTimes($master, 'EXDATE') as $property) {
            foreach ($property->getDateTimes($zone) as $value) {
                $excluded[self::key(\DateTimeImmutable::createFromInterface($value), $isDate, $floating)] = true;
            }
        }

        $first = \DateTimeImmutable::createFromInterface($dtStart->getDateTime($zone));
        $extra = [];
        foreach (Props::dateTimes($master, 'RDATE') as $property) {
            // RDATE;VALUE=PERIOD is not supported by sabre's reader; dates and date-times are, each in its own TZID,
            // and taken into the series' zone, so an occurrence (and an override saved from it) uses the zone the
            // resource defines.
            foreach ($property->getDateTimes($zone) as $value) {
                $extra[] = \DateTimeImmutable::createFromInterface($value)->setTimezone($first->getTimezone());
            }
        }
        usort($extra, static fn (\DateTimeImmutable $a, \DateTimeImmutable $b): int => $a <=> $b);

        $rule = Props::text($master, 'RRULE');
        $ruled = null === $rule ? new \ArrayIterator([$first]) : self::ruleStarts($rule, $first, $from);

        $seen = [];
        $rdates = new \ArrayIterator($extra);
        foreach (self::merge($ruled, $rdates) as $raw) {
            if (null !== $from && $raw < $from) {
                continue;
            }
            $start = self::readBack($raw, $isDate, $floating);
            $key = self::key($start, $isDate, $floating);
            if (isset($seen[$key]) || isset($excluded[$key])) {
                continue;
            }
            $seen[$key] = true;
            yield $key => $start;
        }
    }

    /**
     * How many RRULE occurrences come before a recurrence key, counting those an EXDATE removes, as COUNT does
     * (RFC 5545 3.3.10: COUNT applies to the rule's set, before EXDATE). Null when the series has no RRULE.
     */
    public static function ruleOccurrencesBefore(VEvent $master, string $key, \DateTimeZone $zone): ?int
    {
        $dtStart = Props::dateTime($master, 'DTSTART');
        $rule = Props::text($master, 'RRULE');
        if (null === $dtStart || null === $rule) {
            return null;
        }
        $before = 0;
        foreach (self::ruleStarts($rule, \DateTimeImmutable::createFromInterface($dtStart->getDateTime($zone)), null) as $start) {
            $isDate = !$dtStart->hasTime();
            $floating = true === $dtStart->isFloating();
            if (self::key(self::readBack($start, $isDate, $floating), $isDate, $floating) >= $key) {
                break;
            }
            ++$before;
        }

        return $before;
    }

    /**
     * The override for the occurrence: the existing one, or a new copy of the master at that occurrence, added to the
     * calendar.
     */
    public static function override(VCalendar $calendar, VEvent $master, string $key): VEvent
    {
        $existing = CalendarDocument::override($calendar, $key);
        if (null !== $existing) {
            return $existing;
        }

        $zone = new \DateTimeZone('UTC');
        foreach (self::starts($master, $zone, self::lookFrom($key)) as $current => $start) {
            if ($current === $key) {
                $instance = self::instance($master, $start, self::length($master, $zone));
                unset($instance->VALARM);
                foreach (Props::components($master, 'VALARM') as $alarm) {
                    $instance->add(clone $alarm);
                }
                $calendar->add($instance);

                return $instance;
            }
            // Starts come in order, so a later one means there is none at that time.
            if ($current > $key) {
                break;
            }
        }

        // A rule sabre cannot expand: devices expand it themselves and name the occurrence, which is taken as they name
        // it (the server cannot tell it from one the rule does not have).
        $rule = Props::text($master, 'RRULE');
        $dtStart = Props::dateTime($master, 'DTSTART');
        if (null !== $rule && null !== $dtStart && RecurrenceKey::isValid($key) && !self::ruleReadable($rule, \DateTimeImmutable::createFromInterface($dtStart->getDateTime($zone)))) {
            $first = \DateTimeImmutable::createFromInterface($dtStart->getDateTime($zone));
            $isDate = !$dtStart->hasTime();
            $start = RecurrenceKey::require($key)->setTimezone($first->getTimezone());
            if ($start >= $first && self::key(self::readBack($start, $isDate, true === $dtStart->isFloating()), $isDate, true === $dtStart->isFloating()) === $key) {
                $instance = self::instance($master, $start, self::length($master, $zone));
                unset($instance->VALARM);
                foreach (Props::components($master, 'VALARM') as $alarm) {
                    $instance->add(clone $alarm);
                }
                $calendar->add($instance);

                return $instance;
            }
        }

        throw new InvalidCalendarData('The series has no occurrence at that time.');
    }

    /**
     * Where to start looking for the occurrence with this key: a little before it, as floating and all-day keys are
     * read in a zone, so a long series is not walked from its first occurrence.
     */
    private static function lookFrom(string $key): ?\DateTimeImmutable
    {
        $moment = RecurrenceKey::toDateTime($key);

        return false === $moment ? null : $moment->modify('-2 days');
    }

    private static function changesTheFuture(VEvent $override): bool
    {
        $recurrenceId = Props::get($override, 'RECURRENCE-ID');

        return null !== $recurrenceId && 'THISANDFUTURE' === strtoupper(Props::param($recurrenceId, 'RANGE') ?? '');
    }

    /**
     * The THISANDFUTURE override that changes the occurrence with this key: the latest one before it.
     *
     * @param array<string, VEvent> $ranges sorted by key
     */
    private static function rangeFor(array $ranges, string $key): ?VEvent
    {
        $found = null;
        foreach ($ranges as $rangeKey => $range) {
            if ((string) $rangeKey >= $key) {
                break;
            }
            $found = $range;
        }

        return $found;
    }

    /** How far a THISANDFUTURE override moves its occurrence, in seconds. */
    private static function shift(VEvent $range, \DateTimeZone $zone): int
    {
        $recurrenceId = Props::dateTime($range, 'RECURRENCE-ID') ?? throw new InvalidCalendarData('The override has no recurrence id.');
        $start = Props::dateTime($range, 'DTSTART') ?? throw new InvalidCalendarData('The override has no start.');

        return $start->getDateTime($zone)->getTimestamp() - $recurrenceId->getDateTime($zone)->getTimestamp();
    }

    /**
     * A later occurrence as a THISANDFUTURE override changes it: the override's properties, moved as far from the
     * occurrence's own start as the override moved from its.
     */
    private static function changed(VEvent $master, VEvent $range, \DateTimeImmutable $start, \DateTimeZone $zone): VEvent
    {
        $recurrenceId = Props::dateTime($range, 'RECURRENCE-ID') ?? throw new InvalidCalendarData('The override has no recurrence id.');
        $rangeStart = Props::dateTime($range, 'DTSTART') ?? throw new InvalidCalendarData('The override has no start.');
        $moved = $start->add(\DateTimeImmutable::createFromInterface($recurrenceId->getDateTime($zone))->diff($rangeStart->getDateTime($zone)));
        $length = self::length($range, $zone);

        $instance = clone $range;
        $instance->remove('RECURRENCE-ID');
        $dtStart = Props::dateTime($instance, 'DTSTART') ?? throw new InvalidCalendarData('The override has no start.');
        $dtStart->setDateTime($moved, $dtStart->isFloating());
        Props::dateTime($instance, 'DTEND')?->setDateTime(self::end($range, $moved, $length), $dtStart->isFloating());
        $masterStart = Props::dateTime($master, 'DTSTART') ?? throw new InvalidCalendarData('The series has no start.');
        $occurrenceId = clone $masterStart;
        $occurrenceId->name = 'RECURRENCE-ID';
        $occurrenceId->setDateTime($start, $masterStart->isFloating());
        $instance->add($occurrenceId);

        return $instance;
    }

    /**
     * A start as it reads back once written into an event: the clock time in its zone, read again. The rule walk can
     * land on the first of two 02:30s on the night clocks go back, while the occurrence written from it (instance(),
     * an override's RECURRENCE-ID, an EXDATE) reads back as the zone resolves that clock time. Keying starts by the
     * read-back time makes them match the occurrence, its override and its EXDATE.
     */
    private static function readBack(\DateTimeImmutable $start, bool $isDate, bool $floating): \DateTimeImmutable
    {
        if ($isDate || $floating) {
            return $start;
        }

        return new \DateTimeImmutable($start->format('Y-m-d H:i:s'), $start->getTimezone());
    }

    /**
     * The recurrence key of a start: the date for all-day series, the wall-clock time for floating ones, else the
     * instant in UTC.
     */
    private static function key(\DateTimeImmutable $start, bool $isDate, bool $floating): string
    {
        return match (true) {
            $isDate => RecurrenceKey::fromDate($start),
            $floating => $start->format('Ymd\THis').'Z',
            default => RecurrenceKey::fromInstant($start),
        };
    }

    /** Whether sabre can expand the rule (it refuses parts it does not know, such as RSCALE or an X- part). */
    public static function ruleReadable(string $rule, \DateTimeImmutable $start): bool
    {
        try {
            new RRuleIterator($rule, $start);
        } catch (InvalidDataException) {
            return false;
        }

        return true;
    }

    /**
     * The starts an RRULE gives (the first being DTSTART), from $from on when given. At most MAX_STEPS steps are
     * walked, the skip to $from included: sabre walks there one occurrence at a time, so an hourly series from year 1
     * would take seconds on every look. A rule of a fixed period (HOURLY, DAILY, WEEKLY) without COUNT is first
     * jumped to a couple of periods before $from, which gives the same occurrences.
     *
     * @return \Generator<int, \DateTimeImmutable>
     */
    private static function ruleStarts(string $rule, \DateTimeImmutable $first, ?\DateTimeImmutable $from): \Generator
    {
        try {
            $iterator = new RRuleIterator($rule, null === $from ? $first : self::jump($rule, $first, $from));
        } catch (InvalidDataException) {
            // A rule sabre cannot expand: the series is its first occurrence here (devices may expand more).
            if (null === $from || $first >= $from) {
                yield $first;
            }

            return;
        }
        $steps = 0;
        while ($iterator->valid()) {
            if (++$steps > self::MAX_STEPS) {
                throw new MaxInstancesExceededException('The series has more occurrences than can be looked through.');
            }
            $current = $iterator->current();
            if (!$current instanceof \DateTimeInterface) {
                return;
            }
            if (null === $from || $current >= $from) {
                yield \DateTimeImmutable::createFromInterface($current);
            }
            $iterator->next();
        }
    }

    /**
     * A start of the series a couple of periods before $from, for rules whose occurrences repeat every so many hours,
     * days or weeks from DTSTART; DTSTART itself for the others (COUNT counts from DTSTART, months and years vary).
     */
    private static function jump(string $rule, \DateTimeImmutable $first, \DateTimeImmutable $from): \DateTimeImmutable
    {
        $parts = [];
        foreach (explode(';', strtoupper($rule)) as $part) {
            [$name, $value] = array_pad(explode('=', $part, 2), 2, '');
            $parts[$name] = $value;
        }
        $unit = ['HOURLY' => ['hours', 3600], 'DAILY' => ['days', 86400], 'WEEKLY' => ['weeks', 604800]][$parts['FREQ'] ?? ''] ?? null;
        if (null === $unit || isset($parts['COUNT'])) {
            return $first;
        }
        $interval = max(1, (int) ($parts['INTERVAL'] ?? 1));
        // Two periods of slack: a daylight saving change shortens a day by an hour.
        $periods = intdiv($from->getTimestamp() - $first->getTimestamp(), $unit[1] * $interval) - 2;

        return $periods > 0 ? $first->modify(\sprintf('+%d %s', $periods * $interval, $unit[0])) : $first;
    }

    /**
     * Two ascending streams as one.
     *
     * @param \Iterator<mixed, \DateTimeImmutable> $a
     * @param \Iterator<mixed, \DateTimeImmutable> $b
     *
     * @return \Generator<int, \DateTimeImmutable>
     */
    private static function merge(\Iterator $a, \Iterator $b): \Generator
    {
        $a->rewind();
        $b->rewind();
        while ($a->valid() || $b->valid()) {
            if (!$b->valid() || ($a->valid() && $a->current() <= $b->current())) {
                yield $a->current();
                $a->next();
            } else {
                yield $b->current();
                $b->next();
            }
        }
    }

    /** One occurrence of the master as its own event, as sabre's EventIterator::getEventObject() makes it. */
    private static function instance(VEvent $master, \DateTimeImmutable $start, int $length): VEvent
    {
        $instance = clone $master;
        foreach (['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'RECURRENCE-ID'] as $name) {
            $instance->remove($name);
        }
        $dtStart = Props::dateTime($instance, 'DTSTART') ?? throw new InvalidCalendarData('The series has no start.');
        $dtStart->setDateTime($start, $dtStart->isFloating());
        Props::dateTime($instance, 'DTEND')?->setDateTime(self::end($master, $start, $length), $dtStart->isFloating());
        $recurrenceId = clone $dtStart;
        $recurrenceId->name = 'RECURRENCE-ID';
        $instance->add($recurrenceId);

        return $instance;
    }

    /**
     * Where an occurrence of the event that starts at $start ends: for dates as many calendar days later as the event
     * lasts (a day of 23 hours is still a day), for date-times $length seconds later.
     */
    private static function end(VEvent $event, \DateTimeImmutable $start, int $length): \DateTimeImmutable
    {
        $dtStart = Props::dateTime($event, 'DTSTART') ?? throw new InvalidCalendarData('The event has no start.');
        if ($dtStart->hasTime()) {
            return $start->modify(\sprintf('+%d seconds', $length));
        }
        $dtEnd = Props::dateTime($event, 'DTEND');
        $days = null === $dtEnd ? 1 : (int) \DateTimeImmutable::createFromInterface($dtStart->getDateTime())->diff($dtEnd->getDateTime())->format('%r%a');
        $duration = Props::get($event, 'DURATION');
        if (null === $dtEnd && $duration instanceof \Sabre\VObject\Property\ICalendar\Duration) {
            return $start->add($duration->getDateInterval());
        }

        return $start->modify(\sprintf('%+d days', $days));
    }

    /**
     * Where an event or one occurrence of it ends, in $zone: DTEND, else its start plus DURATION, else a day after a
     * date start and the start itself for a date-time. Instances of a series keep the master's DURATION, so this is
     * the only reading that gives them their length.
     */
    public static function endOf(VEvent $event, \DateTimeZone $zone): \DateTimeImmutable
    {
        $start = Props::dateTime($event, 'DTSTART') ?? throw new InvalidCalendarData('The event has no start.');
        $startValue = \DateTimeImmutable::createFromInterface($start->getDateTime($zone));
        $end = Props::dateTime($event, 'DTEND');
        if (null !== $end) {
            return max($startValue, \DateTimeImmutable::createFromInterface($end->getDateTime($zone)));
        }
        $duration = Props::get($event, 'DURATION');
        if ($duration instanceof \Sabre\VObject\Property\ICalendar\Duration) {
            // A negative DURATION ends at the start, as the event row reads it.
            return max($startValue, $startValue->add($duration->getDateInterval()));
        }

        return $start->hasTime() ? $startValue : $startValue->modify('+1 day');
    }

    /** The event's length in seconds: DTEND, else DURATION, else a day for dates and nothing for date-times. */
    private static function length(VEvent $event, \DateTimeZone $zone): int
    {
        $start = Props::dateTime($event, 'DTSTART') ?? throw new InvalidCalendarData('The event has no start.');
        $startValue = $start->getDateTime($zone);
        $end = Props::dateTime($event, 'DTEND');
        if (null !== $end) {
            return $end->getDateTime($zone)->getTimestamp() - $startValue->getTimestamp();
        }
        $duration = Props::get($event, 'DURATION');
        if ($duration instanceof \Sabre\VObject\Property\ICalendar\Duration) {
            return \DateTimeImmutable::createFromInterface($startValue)->add($duration->getDateInterval())->getTimestamp() - $startValue->getTimestamp();
        }

        return $start->hasTime() ? 0 : 86400;
    }

    /**
     * Whether an event overlaps [$from, $to), with floating and all-day times in the user's zone. A moment (no length)
     * overlaps when it lies in the range.
     */
    private static function overlaps(VEvent $event, \DateTimeImmutable $from, \DateTimeImmutable $to, \DateTimeZone $zone): bool
    {
        $start = Props::dateTime($event, 'DTSTART');
        if (null === $start) {
            return false;
        }
        $startValue = \DateTimeImmutable::createFromInterface($start->getDateTime($zone));
        $end = $startValue->modify(\sprintf('+%d seconds', self::length($event, $zone)));

        return $startValue == $end ? $startValue >= $from && $startValue < $to : $startValue < $to && $end > $from;
    }
}
