<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * Tells clients that an entity was deleted. Written by the change tracking, never through the ORM.
 */
#[ORM\Entity(readOnly: true)]
#[ORM\Index(columns: ['user_id', 'change_seq'])]
// A WhatsApp reply's id is refused once its reply was removed ({@see \App\Chat\ChatQueue::queue()}): this finds that removal.
#[ORM\Index(name: 'sync_tombstone_chat_outgoing', columns: ['user_id', 'entity_id'], options: ['where' => "((entity_type)::text = 'chatOutgoing'::text)"])]
class SyncTombstone
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $user;

    #[ORM\Column(length: 32)]
    private string $entityType;

    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $entityId;

    #[ORM\Column(type: Types::BIGINT)]
    private int $changeSeq;

    public function __construct(User $user, string $entityType, Uuid $entityId, int $changeSeq)
    {
        $this->id = Uuid::v7();
        $this->user = $user;
        $this->entityType = $entityType;
        $this->entityId = $entityId;
        $this->changeSeq = $changeSeq;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getUser(): User
    {
        return $this->user;
    }

    public function getEntityType(): string
    {
        return $this->entityType;
    }

    public function getEntityId(): Uuid
    {
        return $this->entityId;
    }

    public function getChangeSeq(): int
    {
        return $this->changeSeq;
    }
}
