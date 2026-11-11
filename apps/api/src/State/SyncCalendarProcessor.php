<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\Input\Sync\Calendar\CalendarListInput;
use App\ApiResource\Input\Sync\Calendar\CalendarStatusInput;
use App\ApiResource\Input\Sync\Calendar\InventoryInput;
use App\ApiResource\Input\Sync\Calendar\ObjectBatchInput;
use App\ApiResource\Input\Sync\Calendar\OperationResultInput;
use App\ApiResource\Input\Sync\OutboxClaimInput;
use App\ApiResource\Input\Sync\WorkerRequest;
use App\Entity\Calendar;
use App\Entity\CalendarOperation;
use App\Entity\MailAccount;
use App\Enum\CalendarSyncStatus;
use App\Sync\Calendar\CalendarListRejected;
use App\Sync\Calendar\CalendarListResult;
use App\Sync\Calendar\CalendarOperations;
use App\Sync\Calendar\CalendarStatusResult;
use App\Sync\Calendar\CalendarSynchronizer;
use App\Sync\Calendar\ClaimedOperation;
use App\Sync\Calendar\ClaimResult;
use App\Sync\Calendar\InventoryResult;
use App\Sync\Calendar\ObjectBatchResult;
use App\Sync\Calendar\OperationResult;
use App\Sync\LeaseGuard;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;
use Symfony\Component\Uid\Uuid;

/**
 * @implements ProcessorInterface<CalendarListInput|CalendarStatusInput|InventoryInput|ObjectBatchInput|OutboxClaimInput|OperationResultInput, CalendarListResult|CalendarStatusResult|InventoryResult|ObjectBatchResult|ClaimResult|OperationResult>
 */
final readonly class SyncCalendarProcessor implements ProcessorInterface
{
    public function __construct(
        private LeaseGuard $leaseGuard,
        private CalendarSynchronizer $synchronizer,
        private CalendarOperations $operations,
        private EntityManagerInterface $entityManager,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): CalendarListResult|CalendarStatusResult|InventoryResult|ObjectBatchResult|ClaimResult|OperationResult
    {
        if ($data instanceof CalendarListInput) {
            try {
                $this->synchronizer->checkServer($data);
            } catch (CalendarListRejected $e) {
                // Checked before the transaction, so the user still learns why their calendars stopped syncing.
                $this->entityManager->wrapInTransaction(function () use ($data, $uriVariables, $e): void {
                    $account = $this->leaseGuard->leasedAccount($uriVariables['accountId'] ?? null, $data->workerId);
                    $account->setCalendarStatus(CalendarSyncStatus::Error, $e->getMessage());
                });
                $this->entityManager->clear();
                throw new UnprocessableEntityHttpException($e->getMessage(), $e);
            }
        }
        $result = $this->handle($data, $uriVariables);
        $this->entityManager->clear();

        return $result;
    }

    /**
     * @param array<string, mixed> $uriVariables
     */
    private function handle(WorkerRequest $data, array $uriVariables): CalendarListResult|CalendarStatusResult|InventoryResult|ObjectBatchResult|ClaimResult|OperationResult
    {
        return $this->entityManager->wrapInTransaction(function () use ($data, $uriVariables): CalendarListResult|CalendarStatusResult|InventoryResult|ObjectBatchResult|ClaimResult|OperationResult {
            $account = $this->leaseGuard->leasedAccount($uriVariables['accountId'] ?? null, $data->workerId);
            $now = new \DateTimeImmutable();

            return match (true) {
                $data instanceof CalendarListInput => $this->synchronizer->syncCalendars($account, $data),
                $data instanceof CalendarStatusInput => $this->reportStatus($account, $data),
                $data instanceof InventoryInput => $this->synchronizer->inventory($this->calendar($account, $uriVariables['calendarId'] ?? null), $data),
                $data instanceof ObjectBatchInput => $this->synchronizer->objects($this->calendar($account, $uriVariables['calendarId'] ?? null), $data),
                $data instanceof OutboxClaimInput => new ClaimResult(array_map(ClaimedOperation::fromEntity(...), $this->operations->claim($account, $data->workerId, $now))),
                $data instanceof OperationResultInput => new OperationResult($this->operations->report($this->claimed($account, $uriVariables['operationId'] ?? null, $data->workerId), $data, $now)),
                default => throw new \LogicException('Unexpected worker request.'),
            };
        });
    }

    private function reportStatus(MailAccount $account, CalendarStatusInput $input): CalendarStatusResult
    {
        $status = $input->status ?? throw new \LogicException('Validation guarantees a status.');
        if (CalendarSyncStatus::Active === $status) {
            // Only a sync error is ended this way; a status the user must act on (a login, a permission, an address to
            // confirm) stays until the calendar list shows it is solved.
            if (CalendarSyncStatus::Error === $account->getCalendarStatus()) {
                $account->setCalendarStatus(CalendarSyncStatus::Active);
                $this->entityManager->flush();
            }

            return new CalendarStatusResult($account->getCalendarStatus()->value);
        }
        $detail = trim((string) $input->detail);
        $account->setCalendarStatus($status, '' === $detail ? null : $detail);
        $this->entityManager->flush();

        return new CalendarStatusResult($status->value);
    }

    private function calendar(MailAccount $account, mixed $id): Calendar
    {
        $calendar = \is_string($id) && Uuid::isValid($id) ? $this->entityManager->find(Calendar::class, Uuid::fromString($id), LockMode::PESSIMISTIC_WRITE) : null;
        if (!$calendar instanceof Calendar || $calendar->getMailAccount()?->getId()->equals($account->getId()) !== true) {
            throw new NotFoundHttpException('No such calendar for this account.');
        }

        return $calendar;
    }

    private function claimed(MailAccount $account, mixed $id, string $workerId): CalendarOperation
    {
        $operation = \is_string($id) && Uuid::isValid($id) ? $this->entityManager->find(CalendarOperation::class, Uuid::fromString($id), LockMode::PESSIMISTIC_WRITE) : null;
        if (!$operation instanceof CalendarOperation || !$operation->getMailAccount()->getId()->equals($account->getId())) {
            throw new NotFoundHttpException('No such calendar operation for this account.');
        }
        if ($workerId !== $operation->getClaimedBy()) {
            throw new ConflictHttpException('This worker does not hold the claim on the operation (any more).');
        }

        return $operation;
    }
}
