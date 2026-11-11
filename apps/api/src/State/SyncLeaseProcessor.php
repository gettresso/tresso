<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use App\ApiResource\SyncLease;
use App\HandOver\HandOvers;
use App\Outbox\DraftFiling;
use App\Outbox\Outbox;
use App\Repository\DraftCopyRemovalRepository;
use App\Repository\MailboxChangeRepository;
use App\Repository\DraftRepository;
use App\Repository\CalendarOperationRepository;
use App\Repository\MailAccountRepository;
use App\Repository\OutgoingMessageRepository;
use App\Sync\AccountLeaser;
use App\Sync\LeaseResult;
use App\Sync\LeasedAccount;
use App\Unsubscribe\Unsubscriptions;
use Doctrine\ORM\EntityManagerInterface;

/**
 * @implements ProcessorInterface<SyncLease, LeaseResult>
 */
final readonly class SyncLeaseProcessor implements ProcessorInterface
{
    public function __construct(
        private AccountLeaser $leaser,
        private Outbox $outbox,
        private OutgoingMessageRepository $outgoing,
        private CalendarOperationRepository $calendarOperations,
        private EntityManagerInterface $entityManager,
        private DraftRepository $drafts,
        private DraftCopyRemovalRepository $removals,
        private MailboxChangeRepository $mailboxChanges,
        private Unsubscriptions $unsubscriptions,
        private HandOvers $handOvers,
        private MailAccountRepository $mailAccounts,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): LeaseResult
    {
        $accounts = array_map(
            static fn (array $account): LeasedAccount => new LeasedAccount($account['id'], $account['emailAddress'], $account['provider'], $account['leaseExpiresAt']),
            $this->leaser->lease($data->workerId, $data->capacity),
        );
        $accountIds = array_map(static fn (LeasedAccount $account): string => $account->id, $accounts);

        // Every heartbeat also releases scheduled mail whose time has come and marks hand-overs whose due date passed,
        // in case their delayed message got lost, and tells the worker which accounts have outbound work, in case it
        // missed the realtime notification.
        $now = new \DateTimeImmutable();
        $this->entityManager->wrapInTransaction(fn () => $this->outbox->releaseDue($accountIds, $now));
        $this->entityManager->wrapInTransaction(fn () => $this->handOvers->markDue($accountIds, $now));

        // Mail to send, drafts to file or remove, changes to messages, calendar changes to write and one-click
        // unsubscribes are all handled when the worker hears the account has outbound work. So are calendars just
        // allowed at Google or Microsoft: the worker waits for that wake-up before it asks again.
        $work = array_values(array_unique([
            ...$this->outgoing->accountsWithClaimable($accountIds, $now),
            ...$this->drafts->accountsWithFiling($accountIds, $now, $now->sub(new \DateInterval(DraftFiling::REST))),
            ...$this->removals->accountsWithRemovals($accountIds, $now),
            ...$this->mailboxChanges->accountsWithDueChanges($accountIds, $now),
            ...$this->calendarOperations->accountsWithClaimable($accountIds, $now),
            ...$this->unsubscriptions->accountsWithDueRequests($accountIds, $now),
            ...$this->mailAccounts->accountsAwaitingCalendars($accountIds),
        ]));

        return new LeaseResult(AccountLeaser::LEASE_SECONDS, $accounts, $work);
    }
}
