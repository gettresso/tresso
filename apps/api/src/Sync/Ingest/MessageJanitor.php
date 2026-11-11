<?php

declare(strict_types=1);

namespace App\Sync\Ingest;

use App\Entity\MailAccount;
use App\Entity\Message;
use App\Entity\Thread;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\Connection;

/**
 * Messages exist as long as they are in at least one folder.
 *
 * A message that lost its last folder is not deleted at once: a move made in another mail app reaches Tresso as the
 * copy vanishing from one folder and, up to a folder poll later, showing up in another, where the ingest links it to
 * the stored message by Message-ID. So the message is marked orphaned ({@see markOrphans()}) and only deleted once it
 * stayed in no folder for {@see GRACE} ({@see removeExpiredOrphans()}, run by {@see SweepOrphanedMessagesHandler}).
 * Meanwhile clients see it in no folder, so it is in no list.
 *
 * Deleting also deletes threads that became empty, recounts the threads that lost messages, and records all of it for
 * client sync (tombstones, new change numbers; todos and hand-overs of a deleted message change too, as they lose
 * their link). It works in chunks of {@see CHUNK} messages, each with its own change number, so clients page through a
 * large deletion like through any other change.
 *
 * Works in SQL inside the caller's transaction, and only on the messages it is given (or the account's expired
 * orphans, through a partial index), never on all messages of an account: call it after flushing, and clear the entity
 * manager afterwards.
 */
final readonly class MessageJanitor
{
    /** Longer than the worker takes to see a copy in another folder: other folders are polled every 5 minutes. */
    public const string GRACE = 'PT15M';
    public const int CHUNK = 1000;

    /**
     * @param positive-int $chunkSize
     */
    public function __construct(
        private Connection $connection,
        private ChangeSequencer $sequencer,
        private int $chunkSize = self::CHUNK,
    ) {
    }

    /**
     * Marks the given messages that are in no folder anymore as orphaned, from $now. Messages already orphaned keep
     * their time.
     *
     * @param list<string> $messageIds messages that just lost a folder
     *
     * @return int number of messages that became orphans
     */
    public function markOrphans(MailAccount $account, array $messageIds, \DateTimeImmutable $now): int
    {
        if ([] === $messageIds) {
            return 0;
        }

        return \count($this->connection->fetchFirstColumn(
            'UPDATE message m SET orphaned_at = :now
             WHERE m.id = ANY(CAST(:ids AS UUID[])) AND m.mail_account_id = :account AND m.orphaned_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM message_location l WHERE l.message_id = m.id)
             RETURNING m.id',
            ['ids' => self::uuids($messageIds), 'account' => $account->getId()->toRfc4122(), 'now' => self::utc($now)],
        ));
    }

    /**
     * Deletes the given messages that are in no folder at once, for callers that know their copy will not show up
     * elsewhere.
     *
     * @param list<string> $messageIds
     *
     * @return int number of deleted messages
     */
    public function removeOrphans(MailAccount $account, array $messageIds): int
    {
        if ([] === $messageIds) {
            return 0;
        }
        $deleted = 0;
        foreach (array_chunk(array_values(array_unique($messageIds)), $this->chunkSize) as $chunk) {
            /** @var list<string> $doomed */
            $doomed = $this->connection->fetchFirstColumn(
                'SELECT m.id FROM message m
                 WHERE m.id = ANY(CAST(:ids AS UUID[])) AND m.mail_account_id = :account
                   AND NOT EXISTS (SELECT 1 FROM message_location l WHERE l.message_id = m.id)
                 ORDER BY m.id
                 FOR UPDATE',
                ['ids' => self::uuids($chunk), 'account' => $account->getId()->toRfc4122()],
            );
            $deleted += $this->delete($account, $doomed);
        }

        return $deleted;
    }

    /**
     * Deletes the account's messages that have been in no folder since before $orphanedBefore, at most $limit of them.
     *
     * @return int number of deleted messages
     */
    public function removeExpiredOrphans(MailAccount $account, \DateTimeImmutable $orphanedBefore, int $limit): int
    {
        // A copy that showed up through a path that did not clear the mark keeps its message.
        $this->connection->executeStatement(
            'UPDATE message m SET orphaned_at = NULL
             WHERE m.orphaned_at < :before AND m.mail_account_id = :account
               AND EXISTS (SELECT 1 FROM message_location l WHERE l.message_id = m.id)',
            ['before' => self::utc($orphanedBefore), 'account' => $account->getId()->toRfc4122()],
        );
        $deleted = 0;
        while ($deleted < $limit) {
            /** @var list<string> $doomed */
            $doomed = $this->connection->fetchFirstColumn(
                'SELECT m.id FROM message m
                 WHERE m.orphaned_at < :before AND m.mail_account_id = :account
                   AND NOT EXISTS (SELECT 1 FROM message_location l WHERE l.message_id = m.id)
                 ORDER BY m.orphaned_at, m.id
                 LIMIT :limit
                 FOR UPDATE',
                ['before' => self::utc($orphanedBefore), 'account' => $account->getId()->toRfc4122(), 'limit' => min($this->chunkSize, $limit - $deleted)],
            );
            if ([] === $doomed) {
                break;
            }
            $deleted += $this->delete($account, $doomed);
        }

        return $deleted;
    }

    /**
     * Deletes messages that are locked and in no folder, as one change number.
     *
     * @param list<string> $messageIds
     */
    private function delete(MailAccount $account, array $messageIds): int
    {
        if ([] === $messageIds) {
            return 0;
        }
        $ids = self::uuids($messageIds);

        // Todos keep going without their email; the foreign key drops the link, and they change for clients below.
        /** @var list<string> $todos */
        $todos = $this->connection->fetchFirstColumn('SELECT o.id FROM todo o WHERE o.message_id = ANY(CAST(:ids AS UUID[]))', ['ids' => $ids]);
        // Hand-overs lose the link to these messages (SET NULL): they reach clients as changed.
        /** @var list<string> $handOvers */
        $handOvers = $this->connection->fetchFirstColumn(
            'SELECT h.id FROM hand_over h WHERE h.message_id = ANY(CAST(:ids AS UUID[])) OR h.reply_id = ANY(CAST(:ids AS UUID[]))',
            ['ids' => $ids],
        );
        /** @var list<array{id: string, thread_id: string}> $deleted */
        $deleted = $this->connection->fetchAllAssociative('DELETE FROM message m WHERE m.id = ANY(CAST(:ids AS UUID[])) RETURNING m.id, m.thread_id', ['ids' => $ids]);
        if ([] === $deleted) {
            return 0;
        }

        $owner = $account->getOwner()->getId();
        $seq = $this->sequencer->next($owner);
        $this->sequencer->tombstones($owner, Message::changeType(), array_column($deleted, 'id'), $seq);
        if ([] !== $todos) {
            $this->connection->executeStatement(
                'UPDATE todo SET change_seq = :seq, updated_at = :now WHERE id = ANY(CAST(:todos AS UUID[]))',
                ['seq' => $seq, 'now' => self::utc(new \DateTimeImmutable()), 'todos' => self::uuids($todos)],
            );
        }
        if ([] !== $handOvers) {
            $this->connection->executeStatement(
                'UPDATE hand_over SET change_seq = :seq WHERE id = ANY(CAST(:ids AS UUID[]))',
                ['seq' => $seq, 'ids' => self::uuids(array_values(array_unique($handOvers)))],
            );
        }

        $threads = self::uuids(array_values(array_unique(array_column($deleted, 'thread_id'))));
        /** @var list<string> $emptyThreads */
        $emptyThreads = $this->connection->fetchFirstColumn(
            'DELETE FROM thread t
             WHERE t.id = ANY(CAST(:threads AS UUID[])) AND NOT EXISTS (SELECT 1 FROM message m WHERE m.thread_id = t.id)
             RETURNING t.id',
            ['threads' => $threads],
        );
        $this->sequencer->tombstones($owner, Thread::changeType(), $emptyThreads, $seq);

        $this->connection->executeStatement(
            'UPDATE thread t SET message_count = s.message_count, last_message_at = s.last_message_at, change_seq = :seq
             FROM (SELECT thread_id, COUNT(*) AS message_count, MAX(received_at) AS last_message_at
                   FROM message WHERE thread_id = ANY(CAST(:threads AS UUID[])) GROUP BY thread_id) s
             WHERE t.id = s.thread_id',
            ['threads' => $threads, 'seq' => $seq],
        );

        return \count($deleted);
    }

    /** @param list<string> $ids */
    private static function uuids(array $ids): string
    {
        return '{'.implode(',', $ids).'}';
    }

    private static function utc(\DateTimeImmutable $time): string
    {
        return $time->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    }
}
