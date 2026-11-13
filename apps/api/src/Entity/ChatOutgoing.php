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
 *
 * A reply may carry a file a browser or phone uploaded ({@see ChatUpload}): sealed with the owner's key under
 * {@see \App\Storage\BlobKind::ChatMedia} until it went out (or the reply is cancelled), then removed. Its name and
 * size stay, as the record of what was sent.
 */
#[ORM\Entity(repositoryClass: ChatOutgoingRepository::class)]
#[ORM\Index(columns: ['chat_account_id', 'change_seq'])]
#[ORM\Index(columns: ['chat_account_id', 'status', 'id'])]
#[ORM\Index(name: 'chat_outgoing_file_sha', columns: ['file_sha256'])]
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
     * The device that claimed it to send; internal, never sent to clients. Null until a claim, and again after a final
     * result or Try again.
     */
    #[ORM\Column(type: UuidType::NAME, nullable: true)]
    private ?Uuid $claimedBy = null;

    /**
     * The secret of the claim, handed only to the claiming relay, which names it in its result; internal, never sent to
     * clients. Random and short-lived (it ends with a final result or Try again), so it is stored as it is, not sealed:
     * reading it from the database gives nothing the reader could not do with that access anyway.
     */
    #[ORM\Column(length: 43, nullable: true)]
    private ?string $claimToken = null;

    /** The file's name as it goes out, sealed; null for a text reply. */
    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $sealedFileName = null;

    /** The file's size in bytes; null for a text reply. */
    #[ORM\Column(type: Types::BIGINT, nullable: true)]
    private ?int $fileSize = null;

    /** Where the file is until it went out; internal. */
    #[ORM\Column(length: 255, nullable: true)]
    private ?string $fileObjectKey = null;

    /** The key version the file is encrypted with; internal. */
    #[ORM\Column(nullable: true)]
    private ?int $fileKeyVersion = null;

    /** The owner's fingerprint of the file's content; internal. */
    #[ORM\Column(length: 64, nullable: true)]
    private ?string $fileSha256 = null;

    /** What the file is, from its content or the uploader's word; internal. */
    #[ORM\Column(length: 255, nullable: true)]
    private ?string $fileContentType = null;

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

    public function getClaimedBy(): ?Uuid
    {
        return $this->claimedBy;
    }

    public function getClaimToken(): ?string
    {
        return $this->claimToken;
    }

    public function getSealedFileName(): ?string
    {
        return $this->sealedFileName;
    }

    public function getFileSize(): ?int
    {
        return $this->fileSize;
    }

    public function getFileObjectKey(): ?string
    {
        return $this->fileObjectKey;
    }

    public function getFileKeyVersion(): ?int
    {
        return $this->fileKeyVersion;
    }

    public function getFileSha256(): ?string
    {
        return $this->fileSha256;
    }

    public function getFileContentType(): ?string
    {
        return $this->fileContentType;
    }

    public function hasFile(): bool
    {
        return null !== $this->sealedFileName;
    }

    /**
     * Takes over an uploaded file, with its name sealed by {@see \App\Chat\ChatFields::attachFile()}.
     */
    public function attachFile(string $sealedName, ChatUpload $upload): void
    {
        $this->sealedFileName = $sealedName;
        $this->fileSize = $upload->getSize();
        $this->fileObjectKey = $upload->getObjectKey();
        $this->fileKeyVersion = $upload->getKeyVersion();
        $this->fileSha256 = $upload->getSha256();
        $this->fileContentType = $upload->getContentType();
    }

    /**
     * Final: the claim ends. The file went out, so it is no longer kept; its name and size stay.
     *
     * @return string|null the key of the file that is no longer needed here, for {@see \App\Chat\ChatMediaCollector}
     */
    public function markSent(\DateTimeImmutable $now): ?string
    {
        $this->status = ChatOutgoingStatus::Sent;
        $this->error = null;
        $this->sentAt = $now;
        $this->endClaim();
        $key = $this->fileObjectKey;
        $this->fileObjectKey = null;
        $this->fileKeyVersion = null;
        $this->fileSha256 = null;

        return $key;
    }

    /**
     * Final, except `unconfirmed`: then the claim stays, so its relay can still say that the reply went out.
     */
    public function markFailed(ChatOutgoingError $error): void
    {
        $this->status = ChatOutgoingStatus::Failed;
        $this->error = $error;
        if (ChatOutgoingError::Unconfirmed !== $error) {
            $this->endClaim();
        }
    }

    /** The user pressed Try again: it waits for the relay as a new reply would. */
    public function retry(): void
    {
        $this->status = ChatOutgoingStatus::Waiting;
        $this->error = null;
        $this->claimedAt = null;
        $this->endClaim();
    }

    private function endClaim(): void
    {
        $this->claimedBy = null;
        $this->claimToken = null;
    }

    public function getChangeOwner(): User
    {
        return $this->chatAccount->getOwner();
    }

    public static function clientFields(): ?array
    {
        return ['chat', 'sealedText', 'status', 'error', 'createdAt', 'claimedAt', 'sentAt', 'sealedFileName', 'fileSize'];
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
