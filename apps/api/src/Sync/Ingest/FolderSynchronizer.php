<?php

declare(strict_types=1);

namespace App\Sync\Ingest;

use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Input\Sync\FolderInput;
use App\Entity\Folder;
use App\Entity\MailAccount;
use App\Entity\MailboxChange;
use App\Mailbox\MailboxChanges;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Makes the stored folders match the server's folder list.
 *
 * - New folders are created, renamed ones keep their messages (the remote name is the key).
 * - Folders missing from the list were deleted on the server: they go, with their message locations; moves from
 *   Tresso into them are undone first.
 * - A changed UIDVALIDITY invalidates every UID in that folder: its locations are dropped and the cursor reset, so
 *   the worker downloads the folder again (messages that still exist elsewhere are linked, not duplicated).
 * - Messages left in no folder are orphaned, not deleted: the download links them again (see {@see MessageJanitor}).
 */
final readonly class FolderSynchronizer
{
    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private MessageJanitor $janitor,
        private ChangeSequencer $sequencer,
        private MailboxChanges $changes,
    ) {
    }

    /**
     * @param list<FolderInput> $inputs
     *
     * @return list<FolderState>
     */
    public function sync(MailAccount $account, array $inputs): array
    {
        $this->assertUniqueNames($inputs);

        return $this->entityManager->wrapInTransaction(fn (): array => $this->apply($account, $inputs));
    }

    /**
     * @param list<FolderInput> $inputs
     *
     * @return list<FolderState>
     */
    private function apply(MailAccount $account, array $inputs): array
    {
        /** @var list<string> $affected messages that lost a folder */
        $affected = [];

        /** @var array<string, Folder> $existing */
        $existing = [];
        foreach ($this->entityManager->getRepository(Folder::class)->findBy(['mailAccount' => $account]) as $folder) {
            $existing[$folder->getRemoteName()] = $folder;
        }

        $states = [];
        foreach ($inputs as $input) {
            $folder = $existing[$input->remoteName] ?? null;
            unset($existing[$input->remoteName]);

            if (null === $folder) {
                $folder = new Folder($account, $input->remoteName, $input->displayName, $input->role);
                $folder->updateSyncState($input->uidValidity, null);
                $this->entityManager->persist($folder);
                $states[] = new FolderState($input->remoteName, $input->uidValidity, null, false);
                continue;
            }

            $folder->rename($input->displayName, $input->role);
            $reset = null !== $folder->getUidValidity() && null !== $input->uidValidity && $folder->getUidValidity() !== $input->uidValidity;
            if ($reset) {
                $affected = [...$affected, ...$this->removeLocations($folder)];
                $folder->updateSyncState($input->uidValidity, null);
            } elseif (null === $folder->getUidValidity() && null !== $input->uidValidity) {
                $folder->updateSyncState($input->uidValidity, $folder->getSyncCursor());
            }

            $states[] = new FolderState($input->remoteName, $folder->getUidValidity(), $folder->getSyncCursor(), $reset);
        }

        foreach ($existing as $deleted) {
            $affected = [...$affected, ...$this->changes->folderRemoved($deleted), ...$this->removeLocations($deleted)];
            // Placeholders still there (moves done but not landed yet) go with the folder too.
            /** @var list<string> $placeholders */
            $placeholders = $this->connection->fetchFirstColumn('SELECT message_id FROM message_location WHERE folder_id = :folder', ['folder' => $deleted->getId()->toRfc4122()]);
            $affected = [...$affected, ...$placeholders];
            $this->entityManager->remove($deleted);
        }

        $this->entityManager->flush();
        $affected = array_values(array_unique($affected));
        // A message whose only folder was reset or deleted waits for its copy to show up again (or elsewhere).
        $this->janitor->markOrphans($account, $affected, new \DateTimeImmutable());
        // Every message that lost a folder changed its membership.
        $this->sequencer->touchMessages($account->getOwner()->getId(), $affected);

        return $states;
    }

    /**
     * Forgets the folder's copies. Placeholder copies of moves from Tresso stay: the moves still go to this folder,
     * and the sync finds the copies again under their new uids.
     *
     * @return list<string> ids of the messages that were in the folder
     */
    private function removeLocations(Folder $folder): array
    {
        /** @var list<string> */
        return $this->connection->fetchFirstColumn(
            'DELETE FROM message_location WHERE folder_id = :folder AND remote_uid NOT LIKE :placeholder RETURNING message_id',
            ['folder' => $folder->getId()->toRfc4122(), 'placeholder' => MailboxChange::PLACEHOLDER_PREFIX.'%'],
        );
    }

    /**
     * @param list<FolderInput> $inputs
     */
    private function assertUniqueNames(array $inputs): void
    {
        $seen = [];
        foreach ($inputs as $index => $input) {
            if (isset($seen[$input->remoteName])) {
                throw new ValidationException(new ConstraintViolationList([
                    new ConstraintViolation('Folder names must be unique.', null, [], $inputs, \sprintf('folders[%d].remoteName', $index), $input->remoteName),
                ]));
            }
            $seen[$input->remoteName] = true;
        }
    }
}
