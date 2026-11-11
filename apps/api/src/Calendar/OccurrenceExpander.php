<?php

declare(strict_types=1);

namespace App\Calendar;

use App\ApiResource\CalendarOccurrence;
use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\InvalidCalendarData;
use App\Calendar\ICalendar\Occurrences;
use App\Calendar\ICalendar\Props;
use App\Entity\CalendarEvent;
use App\Entity\CalendarObject;
use App\Entity\User;
use App\Repository\CalendarEventRepository;
use Psr\Log\LoggerInterface;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\Recur\MaxInstancesExceededException;
use Sabre\VObject\Settings;

/**
 * Occurrences in a time range: every candidate object's iCalendar is expanded with sabre/vobject (RRULE, RDATE,
 * EXDATE and overrides as RFC 5545 has them), and each occurrence points at the stored row it comes from.
 */
final readonly class OccurrenceExpander
{
    public const string MAX_RANGE = 'P400D';
    /**
     * Occurrences one request returns; more means the range is too long for what the calendars hold. An hourly series
     * fits in the longest range, so no series is ever cut short without the caller being told.
     */
    public const int MAX_OCCURRENCES = 10000;
    private const int MAX_RECURRENCES = 100000;

    public function __construct(
        private CalendarEventRepository $events,
        private LoggerInterface $logger,
    ) {
        Settings::$maxRecurrences = self::MAX_RECURRENCES;
    }

    /**
     * @param list<string> $calendarIds
     *
     * @return list<CalendarOccurrence> ordered by start
     *
     * @throws \InvalidArgumentException when the range is empty or longer than MAX_RANGE
     * @throws TooManyOccurrences        when the range holds more than MAX_OCCURRENCES
     */
    public function expand(User $owner, array $calendarIds, \DateTimeImmutable $from, \DateTimeImmutable $to, \DateTimeZone $zone): array
    {
        if ($to <= $from) {
            throw new \InvalidArgumentException('to must be after from.');
        }
        if ($to > $from->add(new \DateInterval(self::MAX_RANGE))) {
            throw new \InvalidArgumentException('The range can be at most 400 days.');
        }

        $occurrences = [];
        $utc = new \DateTimeZone('UTC');
        $objects = $this->events->objectsInRange($owner, $calendarIds, $from, $to);
        $rowsByObject = $this->events->findForObjects($objects);
        foreach ($objects as $object) {
            $rows = $rowsByObject[$object->getId()->toRfc4122()] ?? [];
            try {
                // One more than fits, so a range that holds too many is refused rather than cut short.
                $limit = self::MAX_OCCURRENCES - \count($occurrences) + 1;
                foreach (Occurrences::instances(CalendarDocument::parse($object->getIcal()), $from->setTimezone($utc), $to->setTimezone($utc), $zone, $limit) as $source => $instance) {
                    $occurrence = $this->occurrence($object, $rows, $source, $instance, $zone);
                    if (null === $occurrence) {
                        continue;
                    }
                    $occurrences[] = $occurrence;
                    if (\count($occurrences) > self::MAX_OCCURRENCES) {
                        throw new TooManyOccurrences(\sprintf('This range holds more than %d occurrences. Ask for a shorter range.', self::MAX_OCCURRENCES));
                    }
                }
            } catch (MaxInstancesExceededException|\Sabre\VObject\InvalidDataException|InvalidCalendarData $e) {
                $this->logger->warning('Calendar object could not be expanded', ['object' => $object->getId()->toRfc4122(), 'error' => $e->getMessage()]);
                continue;
            }
        }

        usort($occurrences, static fn (CalendarOccurrence $a, CalendarOccurrence $b): int => [self::sortKey($a->start, $zone), $a->id] <=> [self::sortKey($b->start, $zone), $b->id]);

        return $occurrences;
    }

    /**
     * @param array<string, CalendarEvent> $rows
     * @param string                         $source the recurrence key of the component the instance comes from
     */
    private function occurrence(CalendarObject $object, array $rows, string $source, VEvent $instance, \DateTimeZone $zone): ?CalendarOccurrence
    {
        $start = Props::dateTime($instance, 'DTSTART');
        if (null === $start) {
            return null;
        }
        $key = CalendarDocument::recurrenceKey($instance);
        $row = $rows[$source] ?? $rows[''] ?? null;
        if (null === $row) {
            return null;
        }
        $allDay = !$start->hasTime();
        $startValue = $start->getDateTime($zone);
        $endValue = Occurrences::endOf($instance, $zone);

        return new CalendarOccurrence(
            $row->getId()->toRfc4122().('' === $key ? '' : ':'.$key),
            $row->getId()->toRfc4122(),
            $object->getCalendar()->getId()->toRfc4122(),
            '' === $key ? null : $key,
            $row->isOverride() || $row->isRecurring(),
            $allDay,
            $allDay ? ['date' => $startValue->format('Y-m-d')] : ['dateTime' => $startValue->setTimezone(new \DateTimeZone('UTC'))->format(\DATE_ATOM)],
            $allDay ? ['date' => $endValue->format('Y-m-d')] : ['dateTime' => $endValue->setTimezone(new \DateTimeZone('UTC'))->format(\DATE_ATOM)],
            $row->isAllDay() ? null : $row->getStart()->timeZone,
            $row->getStatus()->value,
            $row->getSummary(),
            $row->getLocation(),
            $row->getTransparency()->value,
            $row->getVisibility()->value,
            $row->getOrganizer(),
            \count($row->getAttendees()),
            $row->getSelfPartstat()?->value,
            $row->getConference(),
        );
    }

    /**
     * @param array{date: string}|array{dateTime: string} $time
     */
    private static function sortKey(array $time, \DateTimeZone $zone): int
    {
        return isset($time['date'])
            ? new \DateTimeImmutable($time['date'], $zone)->getTimestamp()
            : new \DateTimeImmutable($time['dateTime'])->getTimestamp();
    }
}
