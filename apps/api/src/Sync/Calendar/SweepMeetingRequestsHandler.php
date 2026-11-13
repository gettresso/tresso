<?php

declare(strict_types=1);

namespace App\Sync\Calendar;

use App\Calendar\CalendarStore;
use App\Entity\CalendarObject;
use App\Entity\CalendarOperation;
use App\Repository\CalendarObjectRepository;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Clock\ClockInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Uid\Uuid;

/**
 * Runs every minute on the `scheduler_default` transport (the `maintenance` worker). A meeting request is settled by
 * the result of its write, or by the next synced version of the event ({@see CalendarSynchronizer::upsert()}). When
 * neither comes (the write reported `pending`, and Google sends no change afterwards because it made no meeting), the
 * request would stay pending for good, and Retry on another device would see it as still on its way. So a request
 * still pending {@see CalendarSynchronizer::STALE_REQUEST} after it was asked for, with no write of the event waiting,
 * fails with `refused`, as the next sync would have done. The meeting can still arrive later: a synced version that
 * has it clears the request.
 *
 * Each event is settled in a transaction of its own, under the object's row lock as every write of it takes, and the
 * conditions are checked again under that lock. The master row's change gets a new change number, so clients see it.
 * The candidates are read through the partial index of objects with a request, and only stale ones count to the limit.
 */
#[AsMessageHandler]
final readonly class SweepMeetingRequestsHandler
{
    /** Events per run; the rest come on the next. */
    private const int LIMIT = 500;

    public function __construct(
        private Connection $connection,
        private EntityManagerInterface $entityManager,
        private CalendarObjectRepository $objects,
        private CalendarStore $store,
        private ClockInterface $clock,
    ) {
    }

    public function __invoke(SweepMeetingRequests $message): void
    {
        $this->sweep();
    }

    /**
     * @return int the requests marked failed
     */
    public function sweep(): int
    {
        $before = $this->clock->now()->sub(new \DateInterval(CalendarSynchronizer::STALE_REQUEST));
        $ids = $this->connection->fetchFirstColumn(
            "SELECT o.id FROM calendar_object o
              WHERE o.conference_request IS NOT NULL AND o.conference_request->>'status' = 'pending'
                AND CAST(o.conference_request->>'requestedAt' AS TIMESTAMPTZ) < CAST(:before AS TIMESTAMPTZ)
                AND NOT EXISTS (SELECT 1 FROM calendar_operation op WHERE op.object_id = o.id)
              LIMIT :limit",
            ['before' => $before->format(\DATE_ATOM), 'limit' => self::LIMIT],
        );

        $failed = 0;
        foreach ($ids as $id) {
            if (!\is_string($id)) {
                throw new \UnexpectedValueException('Expected an object id.');
            }
            if ($this->entityManager->wrapInTransaction(fn (): bool => $this->settle(Uuid::fromString($id), $before))) {
                ++$failed;
            }
            $this->entityManager->clear();
        }

        return $failed;
    }

    private function settle(Uuid $id, \DateTimeImmutable $before): bool
    {
        $object = $this->objects->find($id);
        if (!$object instanceof CalendarObject) {
            return false;
        }
        $object = $this->objects->lock($object);
        $request = $object->getConferenceRequest();
        if (null === $request || 'pending' !== $request['status'] || new \DateTimeImmutable($request['requestedAt']) >= $before
            || null !== $this->entityManager->getRepository(CalendarOperation::class)->findOneBy(['object' => $object])) {
            return false;
        }
        $this->store->setConferenceRequest($object, ['status' => 'failed', 'reason' => 'refused'] + $request);

        return true;
    }
}
