<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\ChatOutgoing;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * Replies are reached through their account, so through its owner: another user's reply looks like it does not exist.
 *
 * @extends ServiceEntityRepository<ChatOutgoing>
 */
class ChatOutgoingRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, ChatOutgoing::class);
    }

    /** Returns the reply only when its account belongs to the owner. */
    public function findOneOwnedBy(User $owner, string $id): ?ChatOutgoing
    {
        if (!Uuid::isValid($id)) {
            return null;
        }

        /** @var ChatOutgoing|null */
        return $this->createQueryBuilder('o')
            ->join('o.chatAccount', 'a')
            ->where('o.id = :id')
            ->andWhere('a.owner = :owner')
            ->setParameter('id', Uuid::fromString($id), 'uuid')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->getQuery()
            ->getOneOrNullResult();
    }
}
