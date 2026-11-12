<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\Chat;
use App\Entity\ChatMessage;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

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

    /**
     * The chat's message with this WhatsApp id, by its fingerprint ({@see \App\Chat\ChatFields::messageFingerprint()}).
     */
    public function findOneByWaFingerprint(Chat $chat, string $fingerprint): ?ChatMessage
    {
        return $this->findOneBy(['chat' => $chat, 'waFingerprint' => $fingerprint]);
    }
}
