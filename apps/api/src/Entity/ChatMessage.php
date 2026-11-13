<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\ChatMediaError;
use App\Enum\ChatMediaKind;
use App\Enum\ChatMediaState;
use App\Enum\ScanStatus;
use App\Enum\ScanFailure;
use App\Scan\ScanOutcome;
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
 *
 * A file stays on the relaying Mac until the user asks for it on another device ({@see ChatMediaState}): then the Mac
 * downloads it through its bridge and uploads it, and it is kept here sealed with the owner's key under
 * {@see \App\Storage\BlobKind::ChatMedia}, scanned like a mail attachment before it is served
 * ({@see \App\Chat\ChatMedia}).
 */
#[ORM\Entity(repositoryClass: ChatMessageRepository::class)]
#[ORM\Index(columns: ['chat_account_id', 'change_seq'])]
#[ORM\Index(columns: ['chat_id', 'sent_at'])]
#[ORM\Index(name: 'chat_message_account_sent', columns: ['chat_account_id', 'sent_at'])]
#[ORM\Index(name: 'chat_message_media_request', columns: ['chat_account_id', 'media_state', 'media_requested_at'])]
#[ORM\Index(name: 'chat_message_media_sha', columns: ['media_sha256'])]
#[ORM\Index(name: 'chat_message_media_scan', columns: ['media_scan_status', 'media_scan_requested_at'])]
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

    /** Null for a message without a file. */
    #[ORM\Column(length: 16, nullable: true, enumType: ChatMediaState::class)]
    private ?ChatMediaState $mediaState;

    #[ORM\Column(length: 16, nullable: true, enumType: ChatMediaError::class)]
    private ?ChatMediaError $mediaError = null;

    /** When the user last asked for the file; the relay takes requests oldest first. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $mediaRequestedAt = null;

    /** When the relay took the request; internal. A request taken long ago is handed out again. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $mediaClaimedAt = null;

    /** Where the stored file is; internal. */
    #[ORM\Column(length: 255, nullable: true)]
    private ?string $mediaObjectKey = null;

    /** The key version the stored file is encrypted with; internal. */
    #[ORM\Column(nullable: true)]
    private ?int $mediaKeyVersion = null;

    /** The owner's fingerprint of the stored file's content ({@see \App\Storage\BlobVault::fingerprint()}); internal. */
    #[ORM\Column(length: 64, nullable: true)]
    private ?string $mediaSha256 = null;

    /** The stored file's size in bytes (the relay's `mediaSize` is what the bridge's store said). */
    #[ORM\Column(type: Types::BIGINT, nullable: true)]
    private ?int $mediaStoredSize = null;

    /** What the stored file is, from its content; internal (it decides whether a download may show inline). */
    #[ORM\Column(length: 255, nullable: true)]
    private ?string $mediaContentType = null;

    /** The stored file's scan; null until it is stored. */
    #[ORM\Column(length: 16, nullable: true, enumType: ScanStatus::class)]
    private ?ScanStatus $mediaScanStatus = null;

    #[ORM\Column(length: 16, nullable: true, enumType: ScanFailure::class)]
    private ?ScanFailure $mediaScanFailure = null;

    /** When a scan was last queued; the sweeper queues one again for a file still pending long after. Internal. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $mediaScanRequestedAt = null;

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
        $this->mediaState = null === $mediaKind ? null : ChatMediaState::Remote;
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

    public function getMediaState(): ?ChatMediaState
    {
        return $this->mediaState;
    }

    public function getMediaError(): ?ChatMediaError
    {
        return $this->mediaError;
    }

    public function getMediaRequestedAt(): ?\DateTimeImmutable
    {
        return $this->mediaRequestedAt;
    }

    public function getMediaClaimedAt(): ?\DateTimeImmutable
    {
        return $this->mediaClaimedAt;
    }

    public function getMediaObjectKey(): ?string
    {
        return $this->mediaObjectKey;
    }

    public function getMediaKeyVersion(): ?int
    {
        return $this->mediaKeyVersion;
    }

    public function getMediaSha256(): ?string
    {
        return $this->mediaSha256;
    }

    public function getMediaStoredSize(): ?int
    {
        return $this->mediaStoredSize;
    }

    public function getMediaContentType(): ?string
    {
        return $this->mediaContentType;
    }

    public function getMediaScanStatus(): ?ScanStatus
    {
        return $this->mediaScanStatus;
    }

    public function getMediaScanFailure(): ?ScanFailure
    {
        return $this->mediaScanFailure;
    }

    /**
     * The user asked for the file: it waits for the relay. A file that is asked for already or stored stays as it is.
     *
     * @return bool whether this changed anything
     */
    public function requestMedia(\DateTimeImmutable $now): bool
    {
        if (!\in_array($this->mediaState, [ChatMediaState::Remote, ChatMediaState::Failed], true)) {
            return false;
        }
        $this->mediaState = ChatMediaState::Requested;
        $this->mediaError = null;
        $this->mediaRequestedAt = $now;
        $this->mediaClaimedAt = null;

        return true;
    }

    /** The relay took the request. */
    public function claimMedia(\DateTimeImmutable $now): void
    {
        $this->mediaClaimedAt = $now;
    }

    /** The relay brought the file; it is scanned before it is served. */
    public function storeMedia(string $objectKey, int $keyVersion, string $fingerprint, int $size, string $contentType, \DateTimeImmutable $now): void
    {
        $this->mediaState = ChatMediaState::Stored;
        $this->mediaError = null;
        $this->mediaClaimedAt = null;
        $this->mediaObjectKey = $objectKey;
        $this->mediaKeyVersion = $keyVersion;
        $this->mediaSha256 = $fingerprint;
        $this->mediaStoredSize = $size;
        $this->mediaContentType = $contentType;
        $this->mediaScanStatus = ScanStatus::Pending;
        $this->mediaScanFailure = null;
        $this->mediaScanRequestedAt = $now;
    }

    /** The relay could not bring the file; the user may ask again. */
    public function failMedia(ChatMediaError $error): void
    {
        $this->mediaState = ChatMediaState::Failed;
        $this->mediaError = $error;
        $this->mediaClaimedAt = null;
    }

    /** A verdict for the stored file, as {@see \App\Scan\AttachmentScans} records it in bulk; for tests and fixtures. */
    public function recordMediaScan(ScanOutcome $outcome): void
    {
        $this->mediaScanStatus = $outcome->status;
        $this->mediaScanFailure = $outcome->failure;
    }

    public function getChangeOwner(): User
    {
        return $this->chatAccount->getOwner();
    }

    /**
     * Everything a client sees. Where a stored file lives, which key it is sealed with, when a request or scan was taken
     * up and what the file's content type is stay inside; changing them is no change for clients.
     */
    public static function clientFields(): ?array
    {
        return ['chat', 'fromMe', 'sentAt', 'sealedWaId', 'sealedSender', 'sealedText', 'mediaKind', 'sealedMediaName', 'mediaSize', 'mediaState', 'mediaError', 'mediaStoredSize', 'mediaScanStatus', 'mediaScanFailure'];
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
