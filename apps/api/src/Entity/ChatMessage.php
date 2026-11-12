<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\ChatMediaKind;
use App\Repository\ChatMessageRepository;
use App\Sync\Change\TracksChanges;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * One message of a chat, as the relay found it in the bridge's store. Its WhatsApp id, sender and text (and a file's
 * name) are sealed with the owner's field key; the server finds a message it has by the fingerprint of its chat's JID
 * and its WhatsApp id ({@see \App\Chat\ChatFields::messageFingerprint()}). Plaintext: whether it is the user's own, its
 * time, and a file's kind and size.
 *
 * The account is kept beside the chat (as on a mail message), so the delta reads an account's messages through one
 * index.
 */
#[ORM\Entity(repositoryClass: ChatMessageRepository::class)]
#[ORM\Index(columns: ['chat_account_id', 'change_seq'])]
#[ORM\Index(columns: ['chat_id', 'sent_at'])]
#[ORM\UniqueConstraint(columns: ['chat_id', 'wa_fingerprint'])]
class ChatMessage implements TracksChanges
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

    /** Hex HMAC of the chat's JID and the WhatsApp id under the owner's index key. */
    #[ORM\Column(length: 64)]
    private string $waFingerprint;

    #[ORM\Column]
    private bool $fromMe;

    #[ORM\Column]
    private \DateTimeImmutable $sentAt;

    #[ORM\Column(type: Types::TEXT)]
    private string $sealedWaId;

    /** JSON {id, name} sealed; null for the user's own messages and when the channel named nobody. */
    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $sealedSender;

    /** The text, or a file's caption; empty when there is none. */
    #[ORM\Column(type: Types::TEXT)]
    private string $sealedText;

    #[ORM\Column(length: 16, nullable: true, enumType: ChatMediaKind::class)]
    private ?ChatMediaKind $mediaKind;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $sealedMediaName;

    #[ORM\Column(type: Types::BIGINT, nullable: true)]
    private ?int $mediaSize;

    /**
     * Made by {@see \App\Chat\ChatFields::newMessage()}, which seals its fields for $id.
     */
    public function __construct(
        Uuid $id,
        Chat $chat,
        string $waFingerprint,
        bool $fromMe,
        \DateTimeImmutable $sentAt,
        string $sealedWaId,
        ?string $sealedSender,
        string $sealedText,
        ?ChatMediaKind $mediaKind,
        ?string $sealedMediaName,
        ?int $mediaSize,
    ) {
        $this->id = $id;
        $this->chat = $chat;
        $this->chatAccount = $chat->getChatAccount();
        $this->waFingerprint = $waFingerprint;
        $this->fromMe = $fromMe;
        $this->sentAt = $sentAt;
        $this->sealedWaId = $sealedWaId;
        $this->sealedSender = $sealedSender;
        $this->sealedText = $sealedText;
        $this->mediaKind = $mediaKind;
        $this->sealedMediaName = $sealedMediaName;
        $this->mediaSize = $mediaSize;
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

    public function getWaFingerprint(): string
    {
        return $this->waFingerprint;
    }

    public function isFromMe(): bool
    {
        return $this->fromMe;
    }

    public function getSentAt(): \DateTimeImmutable
    {
        return $this->sentAt;
    }

    public function getSealedWaId(): string
    {
        return $this->sealedWaId;
    }

    public function getSealedSender(): ?string
    {
        return $this->sealedSender;
    }

    public function getSealedText(): string
    {
        return $this->sealedText;
    }

    public function getMediaKind(): ?ChatMediaKind
    {
        return $this->mediaKind;
    }

    public function getSealedMediaName(): ?string
    {
        return $this->sealedMediaName;
    }

    public function getMediaSize(): ?int
    {
        return $this->mediaSize;
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
        return 'chatMessage';
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
