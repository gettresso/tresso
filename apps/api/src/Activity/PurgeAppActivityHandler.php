<?php

declare(strict_types=1);

namespace App\Activity;

use App\Entity\AppActivity;
use Doctrine\DBAL\Connection;
use Psr\Clock\ClockInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Runs once a day on the `scheduler_default` transport (the `maintenance` worker): entries of the activity log go
 * after 90 days, a batch at a time, each batch a short statement of its own, so a large backlog never holds a long lock
 * on the table that every request of an app writes to. It runs until nothing older is left.
 */
#[AsMessageHandler]
final readonly class PurgeAppActivityHandler
{
    public const int BATCH = 5000;

    public function __construct(
        private Connection $connection,
        private ClockInterface $clock,
    ) {
    }

    /** @return int how many entries were removed */
    public function __invoke(PurgeAppActivity $message): int
    {
        $before = $this->clock->now()->sub(new \DateInterval(AppActivity::KEEP_FOR))->format('Y-m-d H:i:s');
        $removed = 0;
        do {
            $batch = (int) $this->connection->executeStatement(
                'DELETE FROM app_activity WHERE id IN (SELECT id FROM app_activity WHERE occurred_at < :before LIMIT '.self::BATCH.')',
                ['before' => $before],
            );
            $removed += $batch;
        } while (self::BATCH === $batch);
        // The per-day counts go with the days they count (one row per app and day: few, so in one statement).
        $this->connection->executeStatement('DELETE FROM app_activity_day WHERE day < :day', ['day' => substr($before, 0, 10)]);

        return $removed;
    }
}
