<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\Input\Sync\AccountStatusInput;
use App\ApiResource\Input\Sync\ChangeBatchInput;
use App\ApiResource\Input\Sync\FolderListInput;
use App\ApiResource\Input\Sync\MessageBatchInput;
use App\ApiResource\Input\Sync\WorkerRequest;
use App\Entity\MailAccount;
use App\Enum\MailAccountStatus;
use App\Sync\Ingest\AccountStatusResult;
use App\Sync\Ingest\ChangeApplier;
use App\Sync\Ingest\ChangeBatchResult;
use App\Sync\Ingest\FolderSynchronizer;
use App\Sync\Ingest\FolderSyncResult;
use App\Sync\Ingest\MessageBatchResult;
use App\Sync\Ingest\MessageIngestor;
use App\Security\Crypto\UserKeys;
use App\Storage\BlobKey;
use App\Storage\BlobKind;
use App\Sync\LeaseGuard;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * Checks the lease, then hands the report to the matching ingest service.
 *
 * @implements ProcessorInterface<WorkerRequest, FolderSyncResult|MessageBatchResult|ChangeBatchResult|AccountStatusResult>
 */
final readonly class SyncIngestProcessor implements ProcessorInterface
{
    public function __construct(
        private LeaseGuard $leaseGuard,
        private FolderSynchronizer $folders,
        private MessageIngestor $messages,
        private ChangeApplier $changes,
        private EntityManagerInterface $entityManager,
        private UserKeys $keys,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): FolderSyncResult|MessageBatchResult|ChangeBatchResult|AccountStatusResult
    {
        $account = $this->leaseGuard->leasedAccount($uriVariables['accountId'] ?? null, $data->workerId);

        $result = $this->entityManager->wrapInTransaction(fn (): FolderSyncResult|MessageBatchResult|ChangeBatchResult|AccountStatusResult => match (true) {
            $data instanceof FolderListInput => new FolderSyncResult($this->folders->sync($account, $data->folders)),
            $data instanceof MessageBatchInput => $this->ingestMessages($account, $data),
            $data instanceof ChangeBatchInput => $this->changes->apply($account, $data),
            $data instanceof AccountStatusInput => $this->updateStatus($account, $data),
            default => throw new \LogicException(\sprintf('Unexpected ingest input %s.', $data::class)),
        });

        // The services also work in SQL; never let a later request in this process see stale entities.
        $this->entityManager->clear();

        return $result;
    }

    /**
     * Content must be stored under the account owner, with a key version the owner still has: anything else could not
     * be read back, or would be read as another user's. The versions stay until the batch is committed.
     */
    private function ingestMessages(MailAccount $account, MessageBatchInput $batch): MessageBatchResult
    {
        $owner = $account->getOwner()->getId();
        $versions = $this->keys->lockOwnerShared($owner);
        foreach ($batch->messages as $message) {
            $key = BlobKey::parse($message->rawObjectKey);
            if (null === $key || BlobKind::Raw !== $key->kind || !$key->owner->equals($owner)) {
                throw new UnprocessableEntityHttpException(\sprintf('Message %s is not stored under the account owner.', $message->remoteUid));
            }
            if (!\in_array($message->keyVersion, $versions, true)) {
                throw new UnprocessableEntityHttpException(\sprintf('Message %s names key version %d, which the owner does not have; fetch the storage keys again.', $message->remoteUid, (int) $message->keyVersion));
            }
        }

        return $this->messages->ingest($account, $batch);
    }

    /**
     * The worker's view of the account, unless the user or the API decided otherwise meanwhile: a pause stays until the
     * user resumes, and a refused sign-in the API saw stays until the user signs in again, whatever a session that
     * started earlier reports. The row is locked first, so a pause committed after the lease check is seen.
     */
    private function updateStatus(MailAccount $account, AccountStatusInput $input): AccountStatusResult
    {
        $status = $input->status ?? throw new \LogicException('Validation guarantees a status.');
        $this->entityManager->refresh($account, LockMode::PESSIMISTIC_WRITE);
        $current = $account->getStatus();
        // An error would even hand the account to the leaser again, which skips refused sign-ins.
        if (MailAccountStatus::Paused === $current || (MailAccountStatus::AuthFailed === $current && MailAccountStatus::AuthFailed !== $status)) {
            return new AccountStatusResult($current);
        }
        $account->setStatus($status, $input->detail);
        if (MailAccountStatus::Active === $status) {
            $account->markSynced(new \DateTimeImmutable());
        }
        $this->entityManager->flush();

        return new AccountStatusResult($account->getStatus());
    }
}
