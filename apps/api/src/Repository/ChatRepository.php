<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * Chats are reached through their account, so through its owner: another user's chat looks like it does not exist.
 *
 * @extends ServiceEntityRepository<Chat>
 */
class ChatRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Chat::class);
    }

    /** Returns the chat only when its account belongs to the owner. */
    public function findOneOwnedBy(User $owner, string $id): ?Chat
    {
        if (!Uuid::isValid($id)) {
            return null;
        }

        /** @var Chat|null */
        return $this->createQueryBuilder('c')
            ->join('c.chatAccount', 'a')
            ->where('c.id = :id')
            ->andWhere('a.owner = :owner')
            ->setParameter('id', Uuid::fromString($id), 'uuid')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * The account's chat with this JID, by the JID's fingerprint ({@see \App\Chat\ChatFields::jidFingerprint()}).
     */
    public function findOneByJidFingerprint(ChatAccount $account, string $fingerprint): ?Chat
    {
        return $this->findOneBy(['chatAccount' => $account, 'jidFingerprint' => $fingerprint]);
    }
}
