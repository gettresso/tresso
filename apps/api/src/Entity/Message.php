<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\ScanStatus;
use App\Enum\Verdict;
use App\Repository\MessageRepository;
use Doctrine\DBAL\Types\Types;
use App\Sync\Change\TracksChanges;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * Message metadata. The raw MIME lives in object storage under $rawObjectKey.
 *
 * A message can live in several folders at once (Gmail labels, IMAP copies); see MessageLocation.
 */
#[ORM\Entity(repositoryClass: MessageRepository::class)]
#[ORM\Index(columns: ['mail_account_id', 'received_at'])]
#[ORM\Index(columns: ['mail_account_id', 'message_id_header'])]
#[ORM\Index(columns: ['thread_id'])]
#[ORM\Index(columns: ['mail_account_id', 'change_seq'])]
// Per-sender lookups of bulk actions and cleanup suggestions, and their "large mail" rule.
#[ORM\Index(columns: ['mail_account_id', 'from_address', 'received_at'])]
#[ORM\Index(columns: ['mail_account_id', 'size'])]
#[ORM\Index(name: 'message_unclassified', columns: ['mail_account_id', 'received_at'], options: ['where' => '(classified_at IS NULL)'])]
#[ORM\Index(name: 'message_held', columns: ['held_until'], options: ['where' => '(held_until IS NOT NULL)'])]
#[ORM\Index(name: 'message_orphaned', columns: ['orphaned_at'], options: ['where' => '(orphaned_at IS NOT NULL)'])]
class Message implements TracksChanges
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private MailAccount $mailAccount;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Thread $thread;

    #[ORM\Column(length: 998, nullable: true)]
    private ?string $messageIdHeader;

    #[ORM\Column(length: 998, nullable: true)]
    private ?string $inReplyTo = null;

    #[ORM\Column(length: 998)]
    private string $subject;

    #[ORM\Column(length: 320)]
    private string $fromAddress;

    #[ORM\Column(length: 255, nullable: true)]
    private ?string $fromName;

    /**
     * Recipients per header, e.g. ['to' => [['address' => 'a@b.c', 'name' => 'A']], 'cc' => [...]].
     *
     * @var array<'to'|'cc'|'bcc'|'replyTo', list<array{address: string, name: ?string}>>
     */
    #[ORM\Column(type: Types::JSON)]
    private array $recipients = [];

    /** The snippet of a message from before encryption; new messages keep it sealed in $sealedSnippet. */
    #[ORM\Column(length: 512)]
    private string $snippet = '';

    /** The snippet sealed with the owner's field key; see {@see \App\Mail\MessageFields}. */
    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $sealedSnippet = null;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $sentAt = null;

    #[ORM\Column]
    private \DateTimeImmutable $receivedAt;

    #[ORM\Column]
    private bool $seen = false;

    #[ORM\Column]
    private bool $flagged = false;

    #[ORM\Column]
    private bool $answered = false;

    #[ORM\Column]
    private bool $draft = false;

    #[ORM\Column]
    private bool $hasAttachments = false;

    /**
     * The scan state of all attachments together (inline ones included): infected as soon as one is, then pending
     * while any is still waiting, then failed, else clean. Null without attachments.
     */
    #[ORM\Column(length: 16, nullable: true, enumType: ScanStatus::class)]
    private ?ScanStatus $attachmentScan = null;

    #[ORM\Column(type: Types::BIGINT)]
    private int $size = 0;

    #[ORM\Column(length: 255)]
    private string $rawObjectKey;

    /** The key version the raw MIME is encrypted with; null for plaintext stored before encryption. */
    #[ORM\Column(nullable: true)]
    private ?int $rawKeyVersion;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(onDelete: 'SET NULL')]
    private ?Category $category = null;

    #[ORM\Column(length: 16, nullable: true, enumType: Verdict::class)]
    private ?Verdict $verdict = null;

    /** One-line AI summary, used in the daily brief and in delegation notes. */
    #[ORM\Column(length: 512, nullable: true)]
    private ?string $summary = null;

    /** When classification looked at this message; null while it waits for its turn. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $classifiedAt = null;

    /** When the user deleted the automatic todo made from this message: none is made for it again. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $todoDeclinedAt = null;

    /**
     * The batch this message waits for: its smart inbox delivers in batches, so clients keep it out of the lists and
     * notifications until then. Null once delivered.
     */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $heldUntil = null;

    /** The batch that delivered this message; null when it was delivered as it came. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $batchedAt = null;

    /**
     * When the message lost its last folder. It is deleted once it stayed in none for
     * {@see \App\Sync\Ingest\MessageJanitor::GRACE}, so a copy that shows up in another folder meanwhile (a move made in
     * another mail app) keeps the message, its todo and its hand-over. Null while it is in a folder.
     */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $orphanedAt = null;

    public function __construct(
        MailAccount $mailAccount,
        Thread $thread,
        ?string $messageIdHeader,
        string $subject,
        string $fromAddress,
        ?string $fromName,
        \DateTimeImmutable $receivedAt,
        string $rawObjectKey,
        int $rawKeyVersion,
    ) {
        $this->id = Uuid::v7();
        $this->mailAccount = $mailAccount;
        $this->thread = $thread;
        $this->messageIdHeader = $messageIdHeader;
        $this->subject = $subject;
        $this->fromAddress = mb_strtolower($fromAddress);
        $this->fromName = $fromName;
        // Stored without a zone and read back as UTC: the worker may send any offset.
        $this->receivedAt = self::utc($receivedAt);
        $this->rawObjectKey = $rawObjectKey;
        $this->rawKeyVersion = $rawKeyVersion;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getMailAccount(): MailAccount
    {
        return $this->mailAccount;
    }

    public function getThread(): Thread
    {
        return $this->thread;
    }

    /** Used when two partial threads turn out to be one conversation. */
    public function moveToThread(Thread $thread): void
    {
        $this->thread = $thread;
    }

    public function getMessageIdHeader(): ?string
    {
        return $this->messageIdHeader;
    }

    public function getInReplyTo(): ?string
    {
        return $this->inReplyTo;
    }

    public function setInReplyTo(?string $inReplyTo): void
    {
        $this->inReplyTo = $inReplyTo;
    }

    public function getSubject(): string
    {
        return $this->subject;
    }

    public function getFromAddress(): string
    {
        return $this->fromAddress;
    }

    public function getFromName(): ?string
    {
        return $this->fromName;
    }

    /** @return array<'to'|'cc'|'bcc'|'replyTo', list<array{address: string, name: ?string}>> */
    public function getRecipients(): array
    {
        return $this->recipients;
    }

    /** @param array<'to'|'cc'|'bcc'|'replyTo', list<array{address: string, name: ?string}>> $recipients */
    public function setRecipients(array $recipients): void
    {
        $this->recipients = $recipients;
    }

    /** The snippet from before encryption; empty once it is sealed. */
    public function getLegacySnippet(): string
    {
        return $this->snippet;
    }

    public function getSealedSnippet(): ?string
    {
        return $this->sealedSnippet;
    }

    public function sealSnippet(string $sealed): void
    {
        $this->sealedSnippet = $sealed;
        $this->snippet = '';
    }

    public function getSentAt(): ?\DateTimeImmutable
    {
        return $this->sentAt;
    }

    /** The Date header, which carries the sender's offset; kept in UTC like every other time. */
    public function setSentAt(?\DateTimeImmutable $sentAt): void
    {
        $this->sentAt = null === $sentAt ? null : self::utc($sentAt);
    }

    private static function utc(\DateTimeImmutable $moment): \DateTimeImmutable
    {
        return $moment->setTimezone(new \DateTimeZone('UTC'));
    }

    public function getReceivedAt(): \DateTimeImmutable
    {
        return $this->receivedAt;
    }

    public function isSeen(): bool
    {
        return $this->seen;
    }

    public function isFlagged(): bool
    {
        return $this->flagged;
    }

    public function isAnswered(): bool
    {
        return $this->answered;
    }

    public function isDraft(): bool
    {
        return $this->draft;
    }

    public function updateFlags(bool $seen, bool $flagged, bool $answered, bool $draft): void
    {
        $this->seen = $seen;
        $this->flagged = $flagged;
        $this->answered = $answered;
        $this->draft = $draft;
    }

    public function hasAttachments(): bool
    {
        return $this->hasAttachments;
    }

    public function setHasAttachments(bool $hasAttachments): void
    {
        $this->hasAttachments = $hasAttachments;
    }

    public function getAttachmentScan(): ?ScanStatus
    {
        return $this->attachmentScan;
    }

    /**
     * @param list<ScanStatus> $attachmentStatuses the scan status of every attachment of the message
     */
    public function summarizeAttachmentScans(array $attachmentStatuses): void
    {
        $this->attachmentScan = ScanStatus::summarize($attachmentStatuses);
    }

    public function getSize(): int
    {
        return $this->size;
    }

    public function setSize(int $size): void
    {
        $this->size = $size;
    }

    public function getRawObjectKey(): string
    {
        return $this->rawObjectKey;
    }

    public function getRawKeyVersion(): ?int
    {
        return $this->rawKeyVersion;
    }

    /** The raw MIME was encrypted again (or for the first time) and is now stored at $key. */
    public function rawReencrypted(string $key, int $keyVersion): void
    {
        $this->rawObjectKey = $key;
        $this->rawKeyVersion = $keyVersion;
    }

    public function getCategory(): ?Category
    {
        return $this->category;
    }

    public function getVerdict(): ?Verdict
    {
        return $this->verdict;
    }

    public function getSummary(): ?string
    {
        return $this->summary;
    }

    public function getClassifiedAt(): ?\DateTimeImmutable
    {
        return $this->classifiedAt;
    }

    public function getTodoDeclinedAt(): ?\DateTimeImmutable
    {
        return $this->todoDeclinedAt;
    }

    /** The user deleted the automatic todo made from this message. */
    public function declineTodo(\DateTimeImmutable $at): void
    {
        $this->todoDeclinedAt ??= $at;
    }

    /** The smart inbox and verdict classification gave this message. The thread takes those of its newest one. */
    public function classify(Category $category, Verdict $verdict, \DateTimeImmutable $at): void
    {
        // Unchanged is no change: classifiedAt alone would count as one for clients and resend the message.
        if ($this->category === $category && $this->verdict === $verdict && null !== $this->classifiedAt) {
            return;
        }
        $this->category = $category;
        $this->verdict = $verdict;
        $this->classifiedAt = $at;
    }

    public function getHeldUntil(): ?\DateTimeImmutable
    {
        return $this->heldUntil;
    }

    public function getBatchedAt(): ?\DateTimeImmutable
    {
        return $this->batchedAt;
    }

    public function isHeld(): bool
    {
        return null !== $this->heldUntil;
    }

    /** Keeps the message back until the batch at $until. */
    public function hold(\DateTimeImmutable $until): void
    {
        if ($this->heldUntil == $until) {
            return;
        }
        $this->heldUntil = $until;
        $this->batchedAt = null;
    }

    /**
     * Delivers a held message: with its batch when that time has come ($batch), or right away (null), e.g. because
     * the user moved it or switched batches off.
     */
    public function release(?\DateTimeImmutable $batch): void
    {
        if (null === $this->heldUntil) {
            return;
        }
        $this->heldUntil = null;
        $this->batchedAt = $batch;
    }

    public function getOrphanedAt(): ?\DateTimeImmutable
    {
        return $this->orphanedAt;
    }

    /** It is in a folder (again); see {@see MessageLocation}. */
    public function foundInFolder(): void
    {
        $this->orphanedAt = null;
    }

    public function getChangeOwner(): User
    {
        return $this->mailAccount->getOwner();
    }

    public static function clientFields(): ?array
    {
        return null;
    }

    public static function changeType(): string
    {
        return 'message';
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
