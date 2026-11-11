<?php

declare(strict_types=1);

namespace App\Calendar;

use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\EventReader;
use App\Entity\CalendarEvent;
use App\Entity\CalendarObject;
use App\Repository\CalendarEventRepository;
use App\Repository\ScheduledNotificationRepository;
use Doctrine\ORM\EntityManagerInterface;
use Sabre\VObject\Component\VCalendar;

/**
 * Brings the event rows of a resource in line with its iCalendar text: one row per VEVENT, created, updated or
 * removed. Removed rows leave tombstones through the change tracking, so clients drop them too.
 */
final readonly class EventProjector
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private CalendarEventRepository $events,
        private SelfAddresses $selfAddresses,
        private ScheduledNotificationRepository $notifications,
    ) {
    }

    /**
     * @return array<string, CalendarEvent> the rows by recurrence key
     */
    public function project(CalendarObject $object, VCalendar $calendar): array
    {
        $self = $this->selfAddresses->of($object->getCalendar()->getOwner());
        $existing = $this->objectIsNew($object) ? [] : $this->events->findForObject($object);

        // Every event is read before any row changes: one that cannot be read leaves the rows as they were.
        $read = [];
        foreach (CalendarDocument::events($calendar) as $vevent) {
            $data = EventReader::read($vevent, $calendar, $self);
            if ($data->uid !== $object->getUid() || isset($read[$data->recurrenceKey])) {
                continue;
            }
            $read[$data->recurrenceKey] = $data;
        }

        $rows = [];
        foreach ($read as $data) {
            $event = $existing[$data->recurrenceKey] ?? null;
            if (null === $event) {
                $event = new CalendarEvent($object, $data);
                $this->entityManager->persist($event);
            } else {
                $event->apply($data);
            }
            $rows[$data->recurrenceKey] = $event;
        }

        foreach ($existing as $key => $event) {
            if (isset($rows[$key])) {
                continue;
            }
            // An override that went: the series takes its occurrence back, and with it the occurrence's
            // notifications (a snooze, a delivery), which the replan then finds there.
            $series = $rows[''] ?? null;
            if (null !== $series) {
                $this->notifications->moveAll($event, $series);
            }
            $this->entityManager->remove($event);
        }

        return $rows;
    }

    /** Removes every row of a resource that is going away. */
    public function remove(CalendarObject $object): void
    {
        foreach ($this->events->findForObject($object) as $event) {
            $this->entityManager->remove($event);
        }
    }

    private function objectIsNew(CalendarObject $object): bool
    {
        return !$this->entityManager->contains($object) || $this->entityManager->getUnitOfWork()->isScheduledForInsert($object);
    }
}
