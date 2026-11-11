<?php

declare(strict_types=1);

namespace App\Bulk;

use App\Enum\BulkActionStatus;
use Doctrine\DBAL\Connection;
use Psr\Clock\ClockInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Messenger\MessageBusInterface;

/**
 * The continuation of a bulk action is only ever the next {@see RunBulkAction}. When that message is lost (the queue
 * was unreachable right after the action committed, or lost the stream), the action would stay under way forever and
 * block every later bulk action of its user. A run handles an action under way at least every 30 seconds (see
 * {@see BulkAction::touch()}), so one untouched for {@see STALE_AFTER} has no runner: it gets a new one. Each is marked
 * touched as it is queued, so overlapping sweeps queue it once; a runner that turns out to be a second one is harmless,
 * as every batch takes the action's row lock and the runs end with the action.
 *
 * @see \App\Entity\BulkAction::touch()
 */
#[AsMessageHandler]
final readonly class SweepBulkActionsHandler
{
    public const string STALE_AFTER = 'PT10M';
    private const int LIMIT = 100;

    public function __construct(
        private Connection $connection,
        private MessageBusInterface $bus,
        private ClockInterface $clock,
    ) {
    }

    public function __invoke(SweepBulkActions $message): void
    {
        $now = $this->clock->now()->setTimezone(new \DateTimeZone('UTC'));
        /** @var list<string> $stale */
        $stale = $this->connection->fetchFirstColumn(
            'UPDATE bulk_action SET updated_at = :now WHERE id IN (
                SELECT id FROM bulk_action WHERE status IN (:running, :undoing) AND updated_at < :stale
                ORDER BY updated_at LIMIT :limit FOR UPDATE SKIP LOCKED
             ) RETURNING id',
            [
                'now' => $now->format('Y-m-d H:i:s'),
                'stale' => $now->sub(new \DateInterval(self::STALE_AFTER))->format('Y-m-d H:i:s'),
                'running' => BulkActionStatus::Running->value,
                'undoing' => BulkActionStatus::Undoing->value,
                'limit' => self::LIMIT,
            ],
        );
        foreach ($stale as $id) {
            $this->bus->dispatch(new RunBulkAction($id));
        }
    }
}
