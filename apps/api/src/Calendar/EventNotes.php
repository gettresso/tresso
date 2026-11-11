<?php

declare(strict_types=1);

namespace App\Calendar;

use App\Entity\CalendarEvent;
use App\Entity\CalendarObject;
use App\Entity\EventNote;
use App\Repository\EventNoteRepository;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The user's notes when the rows of an event change under them: a note hangs on the row that shows its occurrence,
 * so it is taken off before a resource is rewritten or replaced and hung on the rows that show the same occurrences
 * afterwards.
 */
final readonly class EventNotes
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private EventNoteRepository $notes,
    ) {
    }

    /**
     * The row that shows the occurrence with this key, as the occurrences answer gives it: its override, else the
     * override with RANGE=THISANDFUTURE that changed it, else the series (or single event). Null when none does.
     *
     * @param array<string, CalendarEvent> $rows by recurrence key
     */
    public static function rowFor(array $rows, string $key): ?CalendarEvent
    {
        if ('' === $key) {
            return $rows[''] ?? null;
        }
        if (isset($rows[$key])) {
            return $rows[$key];
        }
        $range = null;
        foreach ($rows as $row) {
            $rowKey = $row->getRecurrenceKey();
            if ($row->changesTheFuture() && $rowKey < $key && (null === $range || $rowKey > $range->getRecurrenceKey())) {
                $range = $row;
            }
        }

        return $range ?? $rows[''] ?? null;
    }

    /**
     * Takes the object's notes off their rows before the rows change under them, for every note $to gives a key
     * (null leaves the note where it is); {@see put()} hangs them on the rows that show those occurrences after the
     * save. They are removed first (and leave tombstones), so no row and key is ever held twice on the way.
     *
     * @param \Closure(string): ?string $to
     *
     * @return list<array{string, string}> each note's text and its new occurrence key
     */
    public function lift(CalendarObject $object, \Closure $to): array
    {
        $lifted = [];
        foreach ($this->notes->findForObject($object) as $note) {
            $key = $to($note->getOccurrenceKey());
            if (null === $key) {
                continue;
            }
            $lifted[] = [$note->getText(), $key];
            $this->entityManager->remove($note);
        }
        if ([] !== $lifted) {
            $this->entityManager->flush();
        }

        return $lifted;
    }

    /**
     * @param list<array{string, string}>  $lifted from {@see lift()}
     * @param array<string, CalendarEvent> $rows   the saved object's rows by recurrence key
     */
    public function put(array $lifted, array $rows): void
    {
        if ([] === $lifted || [] === $rows) {
            return;
        }
        /** @var array<string, EventNote> $placed */
        $placed = [];
        foreach ($lifted as [$text, $key]) {
            // A key no row shows (an occurrence the event no longer has) stays with the event, on its first row.
            $row = self::rowFor($rows, $key) ?? array_values($rows)[0];
            $slot = $row->getId()->toRfc4122().'|'.$key;
            $note = $placed[$slot] ?? $this->notes->findFor($row, $key);
            if (null === $note) {
                $note = new EventNote($row, $key);
                $note->write($text);
                $this->entityManager->persist($note);
            } else {
                // Two notes for one occurrence: joined, so no text is lost.
                $note->write(rtrim($note->getText())."\n\n".$text);
            }
            $placed[$slot] = $note;
        }
        $this->entityManager->flush();
    }
}
