<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\ChatAccount;
use App\Entity\User;
use App\Enum\ChatChannel;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * Every lookup goes through the owner: another user's account looks like it does not exist.
 *
 * @extends ServiceEntityRepository<ChatAccount>
 */
class ChatAccountRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, ChatAccount::class);
    }

    /** @return list<ChatAccount> */
    public function findOwnedBy(User $owner): array
    {
        /** @var list<ChatAccount> */
        return $this->createQueryBuilder('a')
            ->where('a.owner = :owner')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->orderBy('a.createdAt')
            ->addOrderBy('a.id')
            ->getQuery()
            ->getResult();
    }

    /** Returns the account only when it belongs to the owner. */
    public function findOneOwnedBy(User $owner, string $id): ?ChatAccount
    {
        if (!Uuid::isValid($id)) {
            return null;
        }

        return $this->findOneBy(['id' => Uuid::fromString($id), 'owner' => $owner]);
    }

    public function findOneByChannel(User $owner, ChatChannel $channel): ?ChatAccount
    {
        return $this->findOneBy(['owner' => $owner, 'channel' => $channel]);
    }
}
