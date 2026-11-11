<?php

declare(strict_types=1);

namespace App\Calendar;

use App\Calendar\ICalendar\CalendarDocument;
use App\Calendar\ICalendar\EventReader;
use App\Entity\CalendarEvent;
use App\Entity\CalendarObject;
use App\Entity\EventNote;
use App\Repository\CalendarEventRepository;
use App\Repository\EventNoteRepository;
use App\Repository\ScheduledNotificationRepository;
use Doctrine\ORM\EntityManagerInterface;
use Sabre\VObject\Component\VCalendar;

/**
 * Brings the event rows of a resource in line with its iCalendar text: one row per VEVENT, created, updated or
 * removed. Removed rows leave tombstones through the change tracking, so clients drop them too. The user's notes
 * follow their occurrence from row to row.
 */
final readonly class EventProjector
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private CalendarEventRepository $events,
        private SelfAddresses $selfAddresses,
        private ScheduledNotificationRepository $notifications,
        private EventNoteRepository $notes,
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

        $this->followOccurrences(array_values($existing), $rows);

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

    /**
     * Removes every row of a resource that is going away, and the notes on them through the entity manager, so they
     * leave tombstones (the database would delete them silently).
     */
    public function remove(CalendarObject $object): void
    {
        $rows = $this->events->findForObject($object);
        foreach ($this->notes->findForEvents(array_values($rows)) as $note) {
            $this->entityManager->remove($note);
        }
        foreach ($rows as $event) {
            $this->entityManager->remove($event);
        }
    }

    /**
     * Notes hang on the row that shows their occurrence: an override that went hands its note to the series, a new
     * override takes the series' note for its occurrence. A note whose event is gone altogether is removed. Two notes
     * that end up on one occurrence are joined, so no text is lost.
     *
     * @param list<CalendarEvent>          $existing the rows before this projection
     * @param array<string, CalendarEvent> $rows     the rows after it, by recurrence key
     */
    private function followOccurrences(array $existing, array $rows): void
    {
        /** @var array<string, array{CalendarEvent, string, list<EventNote>}> $targets */
        $targets = [];
        foreach ($this->notes->findForEvents($existing) as $note) {
            if (!\in_array($note->getEvent(), $existing, true) || $this->entityManager->getUnitOfWork()->isScheduledForDelete($note)) {
                // Already taken elsewhere, or removed, in this unit of work.
                continue;
            }
            $key = $note->getOccurrenceKey();
            // The row that shows its occurrence; a key no row shows stays with the event (on its first row), and only
            // a note of an event without rows goes.
            $target = EventNotes::rowFor($rows, $key) ?? ([] === $rows ? null : array_values($rows)[0]);
            if (null === $target) {
                $this->entityManager->remove($note);
                continue;
            }
            $slot = spl_object_id($target).'|'.$key;
            $targets[$slot] ??= [$target, $key, []];
            // The note already in place keeps its id; others join it.
            if ($note->getEvent() === $target) {
                array_unshift($targets[$slot][2], $note);
            } else {
                $targets[$slot][2][] = $note;
            }
        }

        foreach ($targets as [$target, $key, $notes]) {
            $kept = array_shift($notes);
            if (null === $kept) {
                continue;
            }
            if ($kept->getEvent() !== $target) {
                $kept->moveTo($target, $key);
            }
            foreach ($notes as $other) {
                $kept->write(rtrim($kept->getText())."\n\n".$other->getText());
                $this->entityManager->remove($other);
            }
        }
    }

    private function objectIsNew(CalendarObject $object): bool
    {
        return !$this->entityManager->contains($object) || $this->entityManager->getUnitOfWork()->isScheduledForInsert($object);
    }
}
