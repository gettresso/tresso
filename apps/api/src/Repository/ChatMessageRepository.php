<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\Chat;
use App\Entity\ChatMessage;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * Messages are reached through their chat, which callers loaded through its owner.
 *
 * @extends ServiceEntityRepository<ChatMessage>
 */
class ChatMessageRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, ChatMessage::class);
    }

    /** Returns the message only when its account belongs to the owner. */
    public function findOneOwnedBy(User $owner, string $id): ?ChatMessage
    {
        if (!Uuid::isValid($id)) {
            return null;
        }

        /** @var ChatMessage|null */
        return $this->createQueryBuilder('m')
            ->join('m.chatAccount', 'a')
            ->where('m.id = :id')
            ->andWhere('a.owner = :owner')
            ->setParameter('id', Uuid::fromString($id), 'uuid')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * The chat's message with this WhatsApp id, by its fingerprint ({@see \App\Chat\ChatFields::messageFingerprint()}).
     */
    public function findOneByWaFingerprint(Chat $chat, string $fingerprint): ?ChatMessage
    {
        return $this->findOneBy(['chat' => $chat, 'waFingerprint' => $fingerprint]);
    }
}
