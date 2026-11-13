<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\Chat;
use App\Entity\ChatUpload;
use App\Entity\User;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Uuid;

/**
 * Uploads are reached through their account, so through its owner: another user's upload looks like it does not exist.
 *
 * @extends ServiceEntityRepository<ChatUpload>
 */
class ChatUploadRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, ChatUpload::class);
    }

    /** The upload for this chat with this id, when its account belongs to the owner. */
    public function findOneForChat(User $owner, Chat $chat, string $id): ?ChatUpload
    {
        if (!Uuid::isValid($id)) {
            return null;
        }

        /** @var ChatUpload|null */
        return $this->createQueryBuilder('u')
            ->join('u.chatAccount', 'a')
            ->where('u.id = :id')
            ->andWhere('u.chat = :chat')
            ->andWhere('a.owner = :owner')
            ->setParameter('id', Uuid::fromString($id), 'uuid')
            ->setParameter('chat', $chat->getId(), 'uuid')
            ->setParameter('owner', $owner->getId(), 'uuid')
            ->getQuery()
            ->getOneOrNullResult();
    }
}
