<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\ChatOutgoingError;
use App\Enum\ChatOutgoingStatus;
use App\Repository\ChatOutgoingRepository;
use App\Sync\Change\TracksChanges;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * A reply written in Tresso, queued for the relaying desktop, which sends it through the bridge. The id comes from the
 * client (a UUIDv7), so a repeated request makes no second reply. The text is sealed with the owner's field key.
 *
 * The bridge keeps no record of what it sends, so a row with status `sent` is the record of the reply.
 */
#[ORM\Entity(repositoryClass: ChatOutgoingRepository::class)]
#[ORM\Index(columns: ['chat_account_id', 'change_seq'])]
#[ORM\Index(columns: ['chat_account_id', 'status', 'id'])]
class ChatOutgoing implements TracksChanges
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Chat $chat;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private ChatAccount $chatAccount;

    #[ORM\Column(type: Types::TEXT)]
    private string $sealedText;

    #[ORM\Column(length: 16, enumType: ChatOutgoingStatus::class)]
    private ChatOutgoingStatus $status = ChatOutgoingStatus::Waiting;

    #[ORM\Column(length: 64, nullable: true, enumType: ChatOutgoingError::class)]
    private ?ChatOutgoingError $error = null;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $claimedAt = null;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $sentAt = null;

    /**
     * Made by {@see \App\Chat\ChatFields::newOutgoing()}, which seals the text for $id.
     */
    public function __construct(Uuid $id, Chat $chat, string $sealedText, \DateTimeImmutable $now)
    {
        $this->id = $id;
        $this->chat = $chat;
        $this->chatAccount = $chat->getChatAccount();
        $this->sealedText = $sealedText;
        $this->createdAt = $now;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getChat(): Chat
    {
        return $this->chat;
    }

    public function getChatAccount(): ChatAccount
    {
        return $this->chatAccount;
    }

    public function getSealedText(): string
    {
        return $this->sealedText;
    }

    public function getStatus(): ChatOutgoingStatus
    {
        return $this->status;
    }

    public function getError(): ?ChatOutgoingError
    {
        return $this->error;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getClaimedAt(): ?\DateTimeImmutable
    {
        return $this->claimedAt;
    }

    public function getSentAt(): ?\DateTimeImmutable
    {
        return $this->sentAt;
    }

    public function markSent(\DateTimeImmutable $now): void
    {
        $this->status = ChatOutgoingStatus::Sent;
        $this->error = null;
        $this->sentAt = $now;
    }

    public function markFailed(ChatOutgoingError $error): void
    {
        $this->status = ChatOutgoingStatus::Failed;
        $this->error = $error;
    }

    /** The user pressed Try again: it waits for the relay as a new reply would. */
    public function retry(): void
    {
        $this->status = ChatOutgoingStatus::Waiting;
        $this->error = null;
        $this->claimedAt = null;
    }

    public function getChangeOwner(): User
    {
        return $this->chatAccount->getOwner();
    }

    public static function clientFields(): ?array
    {
        return null;
    }

    public static function changeType(): string
    {
        return 'chatOutgoing';
    }

    public function getChangeSeq(): int
    {
        return $this->changeSeq;
    }

    public function setChangeSeq(int $changeSeq): void
    {
        $this->changeSeq = $changeSeq;
    }
}
