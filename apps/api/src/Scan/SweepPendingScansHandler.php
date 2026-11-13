<?php

declare(strict_types=1);

namespace App\Scan;

use Doctrine\DBAL\Connection;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Messenger\MessageBusInterface;

/**
 * Claims pending attachments whose scan was never queued (stored before scanning existed) or was queued long ago, by
 * moving their request time forward, so concurrent sweeps never queue the same ones, then queues one scan per distinct
 * content: its verdict settles every pending attachment with that content. Works through a backlog in batches until
 * its time budget is used up; the next run continues.
 */
#[AsMessageHandler]
final readonly class SweepPendingScansHandler
{
    /** A queued scan normally finishes within seconds; retries take about ten minutes in all. */
    public const string STALE_AFTER = 'PT15M';

    private const int BATCH = 1000;
    private const float BUDGET_SECONDS = 20.0;

    public function __construct(
        private Connection $connection,
        private MessageBusInterface $bus,
    ) {
    }

    public function __invoke(SweepPendingScans $message): void
    {
        $started = microtime(true);
        $now = new \DateTimeImmutable();
        $stale = $now->sub(new \DateInterval(self::STALE_AFTER));

        foreach (['attachment' => ScanTarget::Received, 'draft_attachment' => ScanTarget::Draft, 'chat_message' => ScanTarget::Chat] as $table => $target) {
            // Each claim follows the (scan_status, scan_requested_at) index: never queued first, then oldest first.
            foreach (['IS NULL', '< :stale'] as $condition) {
                do {
                    $claimed = $this->claim($table, $condition, $now, $stale);
                    foreach (array_column($claimed, 'id', 'sha256') as $id) {
                        $this->bus->dispatch(new ScanAttachment($id, $target));
                    }
                } while (\count($claimed) === self::BATCH && microtime(true) - $started < self::BUDGET_SECONDS);
            }
        }
    }

    /**
     * @return list<array{id: string, sha256: string}>
     */
    private function claim(string $table, string $condition, \DateTimeImmutable $now, \DateTimeImmutable $stale): array
    {
        // A WhatsApp file keeps its scan in columns of its message, named for the file.
        [$status, $requested, $sha] = 'chat_message' === $table
            ? ['media_scan_status', 'media_scan_requested_at', 'media_sha256']
            : ['scan_status', 'scan_requested_at', 'sha256'];

        /** @var list<array{id: string, sha256: string}> */
        return $this->connection->fetchAllAssociative(
            "UPDATE {$table} SET {$requested} = :now WHERE id IN (
                SELECT id FROM {$table} WHERE {$status} = 'pending' AND {$requested} {$condition}
                ORDER BY {$requested} LIMIT :batch FOR UPDATE SKIP LOCKED
             ) RETURNING id, {$sha} AS sha256",
            ['now' => $now->format('Y-m-d H:i:s'), 'batch' => self::BATCH] + (str_contains($condition, ':stale') ? ['stale' => $stale->format('Y-m-d H:i:s')] : []),
        );
    }
}
