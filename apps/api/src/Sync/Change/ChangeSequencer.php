<?php

declare(strict_types=1);

namespace App\Sync\Change;

use App\Realtime\RealtimeNotifier;
use App\Search\SearchIndexScheduler;
use Doctrine\DBAL\Connection;
use Symfony\Component\Uid\Uuid;

/**
 * Hands out per-user change numbers.
 *
 * The number comes from UPDATE ... RETURNING on the user's row, which locks that row until the transaction ends. So
 * writes for one user commit in the order of their numbers: a client that saw number N can never later meet a
 * smaller number that was still uncommitted. That only holds inside a transaction, hence the guard. Different users
 * never wait on each other.
 *
 * Every number is also reported to the {@see RealtimeNotifier}, which tells the user's clients once it is committed,
 * and to the {@see SearchIndexScheduler}, which brings the user's search documents up to date after the commit.
 */
final readonly class ChangeSequencer
{
    /** Rows one bulk change number covers at most, so clients page through a large change like through any other. */
    public const int CHUNK = 1000;

    /**
     * @param positive-int $chunkSize
     */
    public function __construct(
        private Connection $connection,
        private RealtimeNotifier $notifier,
        private SearchIndexScheduler $search,
        private int $chunkSize = self::CHUNK,
    ) {
    }

    public function next(Uuid $userId): int
    {
        if (!$this->connection->isTransactionActive()) {
            throw new \LogicException('Change numbers must be allocated inside a transaction; wrap the write in EntityManager::wrapInTransaction().');
        }

        $seq = $this->connection->fetchOne(
            'UPDATE app_user SET change_seq = change_seq + 1 WHERE id = :id RETURNING change_seq',
            ['id' => $userId->toRfc4122()],
        );
        if (!is_numeric($seq)) {
            throw new \LogicException(\sprintf('User %s does not exist.', $userId->toRfc4122()));
        }

        $seq = (int) $seq;
        $this->notifier->changed($userId, $seq);
        $this->search->changed($userId);

        return $seq;
    }

    /**
     * @param list<string> $entityIds
     */
    public function tombstones(Uuid $userId, string $entityType, array $entityIds, int $seq): void
    {
        // One statement per chunk, not one per row: a deleted folder can take many thousands of messages along.
        foreach (array_chunk($entityIds, $this->chunkSize) as $chunk) {
            $ids = array_map(static fn (): string => Uuid::v7()->toRfc4122(), $chunk);
            $this->connection->executeStatement(
                'INSERT INTO sync_tombstone (id, user_id, entity_type, entity_id, change_seq)
                 SELECT t.id, :user, :type, t.entity_id, :seq FROM unnest(CAST(:ids AS UUID[]), CAST(:entities AS UUID[])) AS t(id, entity_id)',
                ['user' => $userId->toRfc4122(), 'type' => $entityType, 'seq' => $seq, 'ids' => '{'.implode(',', $ids).'}', 'entities' => '{'.implode(',', $chunk).'}'],
            );
        }
    }

    /**
     * Marks messages changed whose folder membership changed in bulk SQL (the ORM listener does not see those), with a
     * change number per {@see CHUNK} messages: a page of the delta never splits a change number, so one number for a
     * whole folder would make one unbounded page.
     *
     * @param list<string> $messageIds
     */
    public function touchMessages(Uuid $userId, array $messageIds): void
    {
        foreach (array_chunk(array_values(array_unique($messageIds)), $this->chunkSize) as $chunk) {
            $this->connection->executeStatement(
                'UPDATE message SET change_seq = :seq WHERE id = ANY(CAST(:ids AS UUID[]))',
                ['seq' => $this->next($userId), 'ids' => '{'.implode(',', $chunk).'}'],
            );
        }
    }

    /**
     * Marks chat messages changed whose file changed in bulk SQL (a scan verdict), with a change number per
     * {@see CHUNK} messages, so clients learn whether the file may be downloaded.
     *
     * @param list<string> $messageIds
     */
    public function touchChatMessages(Uuid $userId, array $messageIds): void
    {
        foreach (array_chunk(array_values(array_unique($messageIds)), $this->chunkSize) as $chunk) {
            $this->connection->executeStatement(
                'UPDATE chat_message SET change_seq = :seq WHERE id = ANY(CAST(:ids AS UUID[]))',
                ['seq' => $this->next($userId), 'ids' => '{'.implode(',', $chunk).'}'],
            );
        }
    }

    /**
     * Marks drafts changed whose files changed in bulk SQL (a scan verdict), so clients fetch their attachments again.
     *
     * @param list<string> $draftIds
     */
    public function touchDrafts(Uuid $userId, array $draftIds): void
    {
        if ([] === $draftIds) {
            return;
        }
        $this->connection->executeStatement(
            'UPDATE draft SET change_seq = :seq WHERE id = ANY(CAST(:ids AS UUID[]))',
            ['seq' => $this->next($userId), 'ids' => '{'.implode(',', array_unique($draftIds)).'}'],
        );
    }
}
