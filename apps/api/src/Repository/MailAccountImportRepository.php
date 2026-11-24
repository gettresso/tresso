<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\MailAccountImport;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * @extends ServiceEntityRepository<MailAccountImport>
 */
class MailAccountImportRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, MailAccountImport::class);
    }

    /**
     * The owner's list with this id while it has not expired; another user's list, or one that expired, looks like it
     * does not exist.
     */
    public function findLiveOwnedBy(User $owner, string $id, \DateTimeImmutable $now): ?MailAccountImport
    {
        if (!Uuid::isValid($id)) {
            return null;
        }

        /** @var MailAccountImport|null */
        return $this->createQueryBuilder('i')
            ->where('i.id = :id')
            ->andWhere('i.owner = :owner')
            ->andWhere('i.expiresAt > :now')
            ->setParameter('id', Uuid::fromString($id), 'uuid')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->setParameter('now', $now)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * The owner's lists that have not expired, newest first.
     *
     * @return list<MailAccountImport>
     */
    public function findAllLiveOwnedBy(User $owner, \DateTimeImmutable $now): array
    {
        /** @var list<MailAccountImport> */
        return $this->createQueryBuilder('i')
            ->where('i.owner = :owner')
            ->andWhere('i.expiresAt > :now')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->setParameter('now', $now)
            ->orderBy('i.createdAt', 'DESC')
            // Ids are UUIDv7: within one second they still order by time.
            ->addOrderBy('i.id', 'DESC')
            ->getQuery()
            ->getResult();
    }

    /** How many lists the owner has that have not expired. */
    public function countLiveOwnedBy(User $owner, \DateTimeImmutable $now): int
    {
        return (int) $this->createQueryBuilder('i')
            ->select('COUNT(i.id)')
            ->where('i.owner = :owner')
            ->andWhere('i.expiresAt > :now')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->setParameter('now', $now)
            ->getQuery()
            ->getSingleScalarResult();
    }
}
