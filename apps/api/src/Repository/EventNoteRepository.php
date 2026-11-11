<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\CalendarEvent;
use App\Entity\CalendarObject;
use App\Entity\EventNote;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<EventNote>
 */
class EventNoteRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, EventNote::class);
    }

    public function findFor(CalendarEvent $event, string $occurrenceKey): ?EventNote
    {
        return $this->findOneBy(['event' => $event, 'occurrenceKey' => $occurrenceKey]);
    }

    /**
     * @param list<CalendarEvent> $events
     *
     * @return list<EventNote>
     */
    public function findForEvents(array $events): array
    {
        if ([] === $events) {
            return [];
        }

        /** @var list<EventNote> */
        return $this->createQueryBuilder('n')
            ->where('n.event IN (:events)')
            ->setParameter('events', array_map(static fn (CalendarEvent $event): string => $event->getId()->toRfc4122(), $events))
            ->orderBy('n.id')
            ->getQuery()
            ->getResult();
    }

    /**
     * @return list<EventNote>
     */
    public function findForObject(CalendarObject $object): array
    {
        /** @var list<EventNote> */
        return $this->createQueryBuilder('n')
            ->join('n.event', 'e')
            ->where('e.object = :object')
            ->setParameter('object', $object->getId(), 'uuid')
            ->orderBy('n.id')
            ->getQuery()
            ->getResult();
    }
}
