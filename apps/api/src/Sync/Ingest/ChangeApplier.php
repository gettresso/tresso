<?php

declare(strict_types=1);

namespace App\Sync\Ingest;

use App\ApiResource\Input\Sync\ChangeBatchInput;
use App\Entity\MailAccount;
use App\Entity\MessageLocation;
use App\Repository\MailboxChangeRepository;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Applies flag changes and removals in one folder. A message that lost its last location is marked orphaned and
 * deleted once no copy showed up elsewhere within {@see MessageJanitor::GRACE}.
 */
final readonly class ChangeApplier
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private FolderLookup $folders,
        private MessageJanitor $janitor,
        private ChangeSequencer $sequencer,
        private MailboxChangeRepository $mailboxChanges,
    ) {
    }

    public function apply(MailAccount $account, ChangeBatchInput $batch): ChangeBatchResult
    {
        $result = $this->entityManager->wrapInTransaction(function () use ($account, $batch): ChangeBatchResult {
            $folder = $this->folders->get($account, $batch->folder);
            $updated = 0;
            /** @var list<string> $unknown */
            $unknown = [];
            // A flag change from Tresso the server has not confirmed yet keeps \Seen and \Flagged as the user set them.
            $pendingFlags = [] === $batch->flags ? [] : $this->mailboxChanges->messagesWithPendingFlags($account);

            foreach ($batch->flags as $change) {
                $location = $this->entityManager->getRepository(MessageLocation::class)->findOneBy(['folder' => $folder, 'remoteUid' => $change->remoteUid]);
                if (null === $location) {
                    $unknown[] = $change->remoteUid;
                    continue;
                }
                $message = $location->getMessage();
                $pending = isset($pendingFlags[$message->getId()->toRfc4122()]);
                $message->updateFlags(
                    $pending ? $message->isSeen() : $change->flags->seen,
                    $pending ? $message->isFlagged() : $change->flags->flagged,
                    $change->flags->answered,
                    $change->flags->draft,
                );
                $location->setModSeq($change->modSeq);
                ++$updated;
            }

            /** @var list<string> $affected messages that lost a folder */
            $affected = [];
            if ([] !== $batch->vanished) {
                $affected = $this->connection->fetchFirstColumn(
                    'DELETE FROM message_location WHERE folder_id = :folder AND remote_uid IN (:uids) RETURNING message_id',
                    ['folder' => $folder->getId()->toRfc4122(), 'uids' => array_values(array_unique($batch->vanished))],
                    ['uids' => ArrayParameterType::STRING],
                );
            }

            foreach ($batch->presence as $range) {
                // Only numeric (IMAP) uids take part; the regex guard keeps the cast safe.
                $affected = [...$affected, ...$this->connection->fetchFirstColumn(
                    "DELETE FROM message_location l
                     WHERE l.folder_id = :folder
                       AND l.remote_uid ~ '^[0-9]{1,18}$'
                       AND CAST(l.remote_uid AS BIGINT) BETWEEN :from AND :to
                       AND NOT (CAST(l.remote_uid AS BIGINT) = ANY(CAST(:uids AS BIGINT[])))
                     RETURNING l.message_id",
                    [
                        'folder' => $folder->getId()->toRfc4122(),
                        'from' => $range->fromUid,
                        'to' => $range->toUid,
                        'uids' => '{'.implode(',', $range->uids).'}',
                    ],
                )];
            }
            /** @var list<string> $affected */
            $removed = \count($affected);

            if (null !== $batch->cursor) {
                $folder->updateSyncState($folder->getUidValidity(), $batch->cursor);
            }
            $this->entityManager->flush();

            $affected = array_values(array_unique($affected));
            $orphaned = $this->janitor->markOrphans($account, $affected, new \DateTimeImmutable());
            // Every message that lost a folder changed its membership; an orphan shows in no folder now.
            $this->sequencer->touchMessages($account->getOwner()->getId(), $affected);

            $unknown = array_values(array_unique($unknown));

            return new ChangeBatchResult($updated, $removed, \count($unknown), $orphaned, $unknown);
        });

        return $result;
    }
}
