<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\MailAccount;
use App\Entity\ProviderGrant;
use App\Entity\User;
use App\Enum\CalendarSyncStatus;
use App\Enum\MailProvider;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * @extends ServiceEntityRepository<MailAccount>
 */
class MailAccountRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, MailAccount::class);
    }

    /** @return list<MailAccount> */
    public function findOwnedBy(User $owner): array
    {
        /** @var list<MailAccount> */
        return $this->createQueryBuilder('a')
            ->where('a.owner = :owner')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->orderBy('a.createdAt')
            ->getQuery()
            ->getResult();
    }

    /**
     * Returns the account only when it belongs to the owner, so other users' accounts look like they do not exist.
     */
    public function findOneOwnedBy(User $owner, string $id): ?MailAccount
    {
        if (!Uuid::isValid($id)) {
            return null;
        }

        return $this->findOneBy(['id' => Uuid::fromString($id), 'owner' => $owner]);
    }

    public function existsForOwner(User $owner, string $emailAddress): bool
    {
        return null !== $this->findOneBy(['owner' => $owner, 'emailAddress' => mb_strtolower($emailAddress)]);
    }

    public function findOneByOwnerAndAddress(User $owner, string $emailAddress): ?MailAccount
    {
        return $this->findOneBy(['owner' => $owner, 'emailAddress' => mb_strtolower($emailAddress)]);
    }

    /** @return list<MailAccount> */
    public function findByProviderGrant(ProviderGrant $grant): array
    {
        /** @var list<MailAccount> */
        return $this->findBy(['providerGrant' => $grant]);
    }

    /**
     * Of the given Gmail and Microsoft accounts, those whose calendar status is still unknown: calendars were just
     * allowed (or the account is new) and the worker has not listed them yet. The heartbeat names them, so a worker
     * that missed the realtime wake-up after the user allowed calendars does not wait for its next retry.
     *
     * @param list<string> $accountIds
     *
     * @return list<string>
     */
    public function accountsAwaitingCalendars(array $accountIds): array
    {
        if ([] === $accountIds) {
            return [];
        }

        /** @var list<string> */
        return $this->getEntityManager()->getConnection()->fetchFirstColumn(
            'SELECT id FROM mail_account
             WHERE id = ANY(CAST(:ids AS UUID[]))
               AND calendar_status = :unknown
               AND provider IN (:gmail, :microsoft)',
            [
                'ids' => '{'.implode(',', $accountIds).'}',
                'unknown' => CalendarSyncStatus::Unknown->value,
                'gmail' => MailProvider::Gmail->value,
                'microsoft' => MailProvider::Microsoft->value,
            ],
        );
    }
}
