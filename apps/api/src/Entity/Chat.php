<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\ChatKind;
use App\Repository\ChatRepository;
use App\Sync\Change\TracksChanges;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * One chat of a chat account: a person or a group. The JID and the name are sealed with the owner's field key; the
 * server finds a chat by the fingerprint of its JID ({@see \App\Chat\ChatFields::jidFingerprint()}), so it never
 * needs either readable.
 *
 * Read and archive are Tresso's own and never reach the channel: unread are the incoming messages after
 * {@see $readThrough}; the chat is out of the inbox while its last message is not after {@see $archivedThrough}, so a
 * new message brings it back.
 */
#[ORM\Entity(repositoryClass: ChatRepository::class)]
#[ORM\Index(columns: ['chat_account_id', 'change_seq'])]
#[ORM\UniqueConstraint(columns: ['chat_account_id', 'jid_fingerprint'])]
class Chat implements TracksChanges
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private ChatAccount $chatAccount;

    /** Hex HMAC of the JID under the owner's index key. */
    #[ORM\Column(length: 64)]
    private string $jidFingerprint;

    #[ORM\Column(type: Types::TEXT)]
    private string $sealedJid;

    /** Null when the channel gave no name. */
    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $sealedName;

    #[ORM\Column(length: 16, enumType: ChatKind::class)]
    private ChatKind $kind;

    #[ORM\Column]
    private \DateTimeImmutable $lastMessageAt;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $readThrough = null;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $archivedThrough = null;

    /** The user left this chat out: nothing of it is relayed. */
    #[ORM\Column(options: ['default' => false])]
    private bool $leftOut = false;

    /**
     * Made by {@see \App\Chat\ChatFields::newChat()}, which seals the JID and the name for $id.
     */
    public function __construct(
        Uuid $id,
        ChatAccount $chatAccount,
        string $jidFingerprint,
        string $sealedJid,
        ?string $sealedName,
        ChatKind $kind,
        \DateTimeImmutable $lastMessageAt,
    ) {
        $this->id = $id;
        $this->chatAccount = $chatAccount;
        $this->jidFingerprint = $jidFingerprint;
        $this->sealedJid = $sealedJid;
        $this->sealedName = $sealedName;
        $this->kind = $kind;
        $this->lastMessageAt = $lastMessageAt;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getChatAccount(): ChatAccount
    {
        return $this->chatAccount;
    }

    public function getJidFingerprint(): string
    {
        return $this->jidFingerprint;
    }

    public function getSealedJid(): string
    {
        return $this->sealedJid;
    }

    public function getSealedName(): ?string
    {
        return $this->sealedName;
    }

    /** Through {@see \App\Chat\ChatFields} only, which seals for this row. */
    public function sealName(?string $sealedName): void
    {
        $this->sealedName = $sealedName;
    }

    public function getKind(): ChatKind
    {
        return $this->kind;
    }

    public function getLastMessageAt(): \DateTimeImmutable
    {
        return $this->lastMessageAt;
    }

    public function getReadThrough(): ?\DateTimeImmutable
    {
        return $this->readThrough;
    }

    public function getArchivedThrough(): ?\DateTimeImmutable
    {
        return $this->archivedThrough;
    }

    public function isLeftOut(): bool
    {
        return $this->leftOut;
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
        return 'chat';
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
