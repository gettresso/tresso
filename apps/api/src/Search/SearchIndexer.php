<?php

declare(strict_types=1);

namespace App\Search;

use App\Entity\MailAccount;
use App\Entity\Message;
use Doctrine\DBAL\Connection;
use Symfony\Component\Uid\Uuid;

/**
 * Keeps a user's search documents in step with their mail, using the change numbers client sync already keeps.
 *
 * Every write to a message (new mail, flags, folder moves, thread merges) gives it the owner's next change number,
 * and deletes leave tombstones. The indexer remembers up to which number a user is indexed ({@see
 * \App\Entity\SearchCursor}) and on each run sends the messages changed since then and deletes the tombstoned ones. So
 * a run that is late, repeated or lost is caught up by the next one, and no write path needs to know about search.
 *
 * Runs for one user take turns: the cursor row stays locked until the run has handed its writes to Meilisearch, which
 * applies them in the order received. Change numbers up to the user's committed number are all committed (see
 * {@see \App\Sync\Change\ChangeSequencer}), so nothing below the new cursor can still appear later.
 */
final readonly class SearchIndexer
{
    private const int PAGE_SIZE = 250;

    public function __construct(
        private Connection $connection,
        private MessageIndex $index,
        private MessageDocuments $documents,
    ) {
    }

    /**
     * Indexes what changed since the last run.
     */
    public function index(Uuid $userId): IndexRun
    {
        return $this->connection->transactional(function () use ($userId): IndexRun {
            $cursor = $this->lockCursor($userId);
            if (null === $cursor) {
                return IndexRun::nothing();
            }
            $target = $this->committedSeq($userId);
            if ($target <= $cursor) {
                return IndexRun::nothing();
            }

            $run = $this->send($userId, $cursor, $target);
            $run = $run->then($this->removeDeleted($userId, $cursor, $target));
            $this->saveCursor($userId, $target);

            return $run;
        });
    }

    /**
     * Drops all of the user's documents and indexes their mail from scratch.
     */
    public function rebuild(Uuid $userId): IndexRun
    {
        return $this->connection->transactional(function () use ($userId): IndexRun {
            if (null === $this->lockCursor($userId)) {
                return IndexRun::nothing();
            }
            $target = $this->committedSeq($userId);

            $run = new IndexRun(0, 0, $this->index->deleteOwnedBy($userId));
            $run = $run->then($this->send($userId, 0, $target));
            $this->saveCursor($userId, $target);

            return $run;
        });
    }

    private function send(Uuid $userId, int $fromSeq, int $toSeq): IndexRun
    {
        $run = IndexRun::nothing();
        foreach ($this->documents->changedBetween($userId, $fromSeq, $toSeq, self::PAGE_SIZE) as $documents) {
            // A message in no folder waits to be found elsewhere or deleted (see MessageJanitor): it is not found
            // meanwhile, and its next change brings it back once it is in a folder again.
            $inFolders = [];
            $orphans = [];
            foreach ($documents as $document) {
                if ([] !== $document['folderIds']) {
                    $inFolders[] = $document;
                } elseif (\is_string($document['id'])) {
                    $orphans[] = $document['id'];
                }
            }
            if ([] !== $inFolders) {
                $run = $run->then(new IndexRun(\count($inFolders), 0, $this->index->replace($inFolders)));
            }
            if ([] !== $orphans) {
                $run = $run->then(new IndexRun(0, \count($orphans), $this->index->delete($orphans)));
            }
        }

        return $run;
    }

    private function removeDeleted(Uuid $userId, int $fromSeq, int $toSeq): IndexRun
    {
        /** @var list<array{entity_type: string, entity_id: string}> $tombstones */
        $tombstones = $this->connection->fetchAllAssociative(
            'SELECT entity_type, entity_id FROM sync_tombstone
             WHERE user_id = :user AND change_seq > :from AND change_seq <= :to AND entity_type IN (:message, :account)
             ORDER BY change_seq',
            ['user' => $userId->toRfc4122(), 'from' => $fromSeq, 'to' => $toSeq, 'message' => Message::changeType(), 'account' => MailAccount::changeType()],
        );

        $run = IndexRun::nothing();
        $messageIds = [];
        foreach ($tombstones as $tombstone) {
            if (Message::changeType() === $tombstone['entity_type']) {
                $messageIds[] = $tombstone['entity_id'];
                continue;
            }
            // A removed account takes its messages along without a tombstone per message.
            $run = $run->then(new IndexRun(0, 0, $this->index->deleteAccount($tombstone['entity_id'])));
        }
        foreach (array_chunk($messageIds, 1000) as $chunk) {
            $run = $run->then(new IndexRun(0, \count($chunk), $this->index->delete($chunk)));
        }

        return $run;
    }

    /**
     * @return int|null the indexed change number, or null when the user no longer exists
     */
    private function lockCursor(Uuid $userId): ?int
    {
        $this->connection->executeStatement(
            'INSERT INTO search_cursor (user_id, indexed_seq) SELECT id, 0 FROM app_user WHERE id = :user ON CONFLICT (user_id) DO NOTHING',
            ['user' => $userId->toRfc4122()],
        );
        $cursor = $this->connection->fetchOne('SELECT indexed_seq FROM search_cursor WHERE user_id = :user FOR UPDATE', ['user' => $userId->toRfc4122()]);

        return is_numeric($cursor) ? (int) $cursor : null;
    }

    private function committedSeq(Uuid $userId): int
    {
        $seq = $this->connection->fetchOne('SELECT change_seq FROM app_user WHERE id = :user', ['user' => $userId->toRfc4122()]);
        if (!is_numeric($seq)) {
            throw new \LogicException(\sprintf('User %s disappeared while its search cursor was locked.', $userId->toRfc4122()));
        }

        return (int) $seq;
    }

    private function saveCursor(Uuid $userId, int $seq): void
    {
        $this->connection->executeStatement('UPDATE search_cursor SET indexed_seq = :seq WHERE user_id = :user', ['seq' => $seq, 'user' => $userId->toRfc4122()]);
    }
}
