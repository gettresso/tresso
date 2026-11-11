<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\OutgoingStatus;
use App\Repository\OutgoingMessageRepository;
use App\Sync\Change\TracksChanges;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * A message on its way out. The API builds the complete MIME message and stores it in object storage; the worker that
 * leases the account sends it over SMTP and files a copy in the Sent folder.
 */
#[ORM\Entity(repositoryClass: OutgoingMessageRepository::class)]
#[ORM\Index(columns: ['mail_account_id', 'status', 'send_at'])]
#[ORM\Index(columns: ['mail_account_id', 'change_seq'])]
class OutgoingMessage implements TracksChanges
{
    /** Attempts before a message that keeps failing temporarily is given up. */
    public const int MAX_ATTEMPTS = 6;

    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private MailAccount $mailAccount;

    #[ORM\Column(length: 16, enumType: OutgoingStatus::class)]
    private OutgoingStatus $status;

    #[ORM\Column]
    private \DateTimeImmutable $sendAt;

    /** Without angle brackets. */
    #[ORM\Column(length: 998)]
    private string $messageIdHeader;

    #[ORM\Column(length: 998)]
    private string $subject;

    /**
     * Shown in the outbox; Bcc is kept separately because it never appears in the message itself.
     *
     * @var array{to: list<array{address: string, name: ?string}>, cc: list<array{address: string, name: ?string}>, bcc: list<array{address: string, name: ?string}>}
     */
    #[ORM\Column(type: Types::JSON)]
    private array $recipients;

    #[ORM\Column(length: 255)]
    private string $rawObjectKey;

    /** The key version the message is encrypted with; null for plaintext stored before encryption. */
    #[ORM\Column(nullable: true)]
    private ?int $rawKeyVersion;

    #[ORM\Column]
    private int $size;

    /** The message this one replies to or forwards. */
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(onDelete: 'SET NULL')]
    private ?Message $inReplyTo = null;

    #[ORM\Column]
    private int $attempts = 0;

    #[ORM\Column(length: 500, nullable: true)]
    private ?string $lastError = null;

    #[ORM\Column(length: 120, nullable: true)]
    private ?string $claimedBy = null;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $claimedUntil = null;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $sentAt = null;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    /**
     * @param array{to: list<array{address: string, name: ?string}>, cc: list<array{address: string, name: ?string}>, bcc: list<array{address: string, name: ?string}>} $recipients
     */
    public function __construct(
        MailAccount $mailAccount,
        string $messageIdHeader,
        string $subject,
        array $recipients,
        string $rawObjectKey,
        int $rawKeyVersion,
        int $size,
        \DateTimeImmutable $sendAt,
        ?Message $inReplyTo,
        \DateTimeImmutable $now,
    ) {
        $this->id = Uuid::v7();
        $this->mailAccount = $mailAccount;
        $this->messageIdHeader = $messageIdHeader;
        $this->subject = $subject;
        $this->recipients = $recipients;
        $this->rawObjectKey = $rawObjectKey;
        $this->rawKeyVersion = $rawKeyVersion;
        $this->size = $size;
        // Stored without a zone and read back as UTC: an API client may send any offset.
        $this->sendAt = self::utc($sendAt);
        $this->inReplyTo = $inReplyTo;
        $this->createdAt = $now;
        $this->status = $sendAt > $now ? OutgoingStatus::Scheduled : OutgoingStatus::Queued;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getMailAccount(): MailAccount
    {
        return $this->mailAccount;
    }

    public function getStatus(): OutgoingStatus
    {
        return $this->status;
    }

    public function getSendAt(): \DateTimeImmutable
    {
        return $this->sendAt;
    }

    public function getMessageIdHeader(): string
    {
        return $this->messageIdHeader;
    }

    public function getSubject(): string
    {
        return $this->subject;
    }

    /**
     * @return array{to: list<array{address: string, name: ?string}>, cc: list<array{address: string, name: ?string}>, bcc: list<array{address: string, name: ?string}>}
     */
    public function getRecipients(): array
    {
        return $this->recipients;
    }

    /** @return list<string> every address the server must deliver to, Bcc included */
    public function getEnvelopeRecipients(): array
    {
        return array_values(array_unique(array_map(
            static fn (array $recipient): string => $recipient['address'],
            [...$this->recipients['to'], ...$this->recipients['cc'], ...$this->recipients['bcc']],
        )));
    }

    public function getRawObjectKey(): string
    {
        return $this->rawObjectKey;
    }

    public function getRawKeyVersion(): ?int
    {
        return $this->rawKeyVersion;
    }

    /** The message was encrypted again (or for the first time) and is now stored at $key. */
    public function rawReencrypted(string $key, int $keyVersion): void
    {
        $this->rawObjectKey = $key;
        $this->rawKeyVersion = $keyVersion;
    }

    public function getSize(): int
    {
        return $this->size;
    }

    public function getInReplyTo(): ?Message
    {
        return $this->inReplyTo;
    }

    public function getAttempts(): int
    {
        return $this->attempts;
    }

    public function getLastError(): ?string
    {
        return $this->lastError;
    }

    public function getClaimedBy(): ?string
    {
        return $this->claimedBy;
    }

    public function getSentAt(): ?\DateTimeImmutable
    {
        return $this->sentAt;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    /** Scheduled messages become due at their send time. */
    public function makeDue(): void
    {
        if (OutgoingStatus::Scheduled === $this->status) {
            $this->status = OutgoingStatus::Queued;
        }
    }

    public function cancel(): void
    {
        if (!\in_array($this->status, [OutgoingStatus::Scheduled, OutgoingStatus::Queued], true)) {
            throw new \LogicException(\sprintf('A message that is %s cannot be cancelled.', $this->status->value));
        }
        $this->status = OutgoingStatus::Cancelled;
    }

    /** A worker takes the message; until the claim expires no other worker will. */
    public function claim(string $workerId, \DateTimeImmutable $until): void
    {
        $this->status = OutgoingStatus::Sending;
        $this->claimedBy = $workerId;
        $this->claimedUntil = $until;
        ++$this->attempts;
    }

    /** @param ?string $note a problem that did not stop the message, e.g. its copy could not be filed in Sent */
    public function markSent(\DateTimeImmutable $at, ?string $note = null): void
    {
        $this->status = OutgoingStatus::Sent;
        $this->sentAt = $at;
        $this->lastError = null === $note ? null : mb_substr($note, 0, 500);
        $this->release();
    }

    public function markFailed(string $error): void
    {
        $this->status = OutgoingStatus::Failed;
        $this->lastError = mb_substr($error, 0, 500);
        $this->release();
    }

    /** A temporary failure: try again later, unless it failed too often already. */
    public function retryAt(\DateTimeImmutable $at, string $error): void
    {
        if ($this->attempts >= self::MAX_ATTEMPTS) {
            $this->markFailed($error);

            return;
        }
        $this->status = OutgoingStatus::Scheduled;
        $this->sendAt = self::utc($at);
        $this->lastError = mb_substr($error, 0, 500);
        $this->release();
    }

    private static function utc(\DateTimeImmutable $moment): \DateTimeImmutable
    {
        return $moment->setTimezone(new \DateTimeZone('UTC'));
    }

    private function release(): void
    {
        $this->claimedBy = null;
        $this->claimedUntil = null;
    }

    public function getChangeOwner(): User
    {
        return $this->mailAccount->getOwner();
    }

    public static function clientFields(): ?array
    {
        return ['status', 'sendAt', 'subject', 'recipients', 'lastError', 'sentAt'];
    }

    public static function changeType(): string
    {
        return 'outgoingMessage';
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
