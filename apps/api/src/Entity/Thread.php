<?php

declare(strict_types=1);

namespace App\Entity;

use App\Classification\ClassificationReason;
use App\Enum\Verdict;
use App\Mail\SubjectNormalizer;
use App\Sync\Change\TracksChanges;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

#[ORM\Entity]
#[ORM\Index(columns: ['mail_account_id', 'last_message_at'])]
#[ORM\Index(columns: ['mail_account_id', 'normalized_subject'])]
#[ORM\Index(columns: ['mail_account_id', 'change_seq'])]
#[ORM\Index(name: 'thread_held', columns: ['held_until'], options: ['where' => '(held_until IS NOT NULL)'])]
// Bulk actions walk a smart inbox's, or an account's, conversations in id order.
#[ORM\Index(columns: ['category_id', 'id'])]
#[ORM\Index(columns: ['mail_account_id', 'id'])]
class Thread implements TracksChanges
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private MailAccount $mailAccount;

    #[ORM\Column(length: 998)]
    private string $subject;

    /** Subject without reply/forward prefixes, for threading mail that has no References header. */
    #[ORM\Column(length: 255)]
    private string $normalizedSubject;

    #[ORM\Column]
    private \DateTimeImmutable $lastMessageAt;

    #[ORM\Column]
    private int $messageCount = 0;

    /** The smart inbox the conversation is in; null until its first incoming message was classified. */
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(onDelete: 'SET NULL')]
    private ?Category $category = null;

    #[ORM\Column(length: 16, nullable: true, enumType: Verdict::class)]
    private ?Verdict $verdict = null;

    /** Why the conversation is where it is; see {@see ClassificationReason}. */
    #[ORM\Column(length: 32, nullable: true)]
    private ?string $classificationReason = null;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $classifiedAt = null;

    /** The batch the conversation waits for, as its newest incoming message does (see {@see Message::getHeldUntil()}). */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $heldUntil = null;

    /** The batch that delivered its newest incoming message; null when that one was delivered as it came. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $batchedAt = null;

    /** New with every placement by the user, so taking one back never takes back a later one; null otherwise. */
    #[ORM\Column(type: UuidType::NAME, nullable: true)]
    private ?Uuid $placementId = null;

    public function __construct(MailAccount $mailAccount, string $subject, \DateTimeImmutable $lastMessageAt)
    {
        $this->id = Uuid::v7();
        $this->mailAccount = $mailAccount;
        $this->subject = $subject;
        $this->normalizedSubject = SubjectNormalizer::normalize($subject);
        $this->lastMessageAt = $lastMessageAt;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getMailAccount(): MailAccount
    {
        return $this->mailAccount;
    }

    public function getSubject(): string
    {
        return $this->subject;
    }

    public function getLastMessageAt(): \DateTimeImmutable
    {
        return $this->lastMessageAt;
    }

    public function getMessageCount(): int
    {
        return $this->messageCount;
    }

    public function getNormalizedSubject(): string
    {
        return $this->normalizedSubject;
    }

    public function recordMessage(\DateTimeImmutable $receivedAt): void
    {
        ++$this->messageCount;
        if ($receivedAt > $this->lastMessageAt) {
            $this->lastMessageAt = $receivedAt;
        }
    }

    /**
     * Recomputed from the remaining messages after messages were removed.
     */
    public function recount(int $messageCount, ?\DateTimeImmutable $lastMessageAt): void
    {
        $this->messageCount = $messageCount;
        if (null !== $lastMessageAt) {
            $this->lastMessageAt = $lastMessageAt;
        }
    }

    public function getCategory(): ?Category
    {
        return $this->category;
    }

    public function getVerdict(): ?Verdict
    {
        return $this->verdict;
    }

    public function getClassificationReason(): ?string
    {
        return $this->classificationReason;
    }

    public function getClassifiedAt(): ?\DateTimeImmutable
    {
        return $this->classifiedAt;
    }

    /** Whether the user put the conversation where it is; automatic classification then leaves it alone. */
    public function isClassifiedByUser(): bool
    {
        return ClassificationReason::USER === $this->classificationReason;
    }

    public function classify(Category $category, Verdict $verdict, string $reason, \DateTimeImmutable $at): void
    {
        if ($this->category === $category && $this->verdict === $verdict && $this->classificationReason === $reason) {
            return;
        }
        $this->category = $category;
        $this->verdict = $verdict;
        $this->classificationReason = $reason;
        $this->classifiedAt = $at;
        if (ClassificationReason::USER !== $reason) {
            $this->placementId = null;
        }
    }

    /** Back to not classified, as before its first incoming message was looked at. */
    public function unclassify(): void
    {
        $this->category = null;
        $this->verdict = null;
        $this->classificationReason = null;
        $this->classifiedAt = null;
        $this->placementId = null;
    }

    /** The user puts the conversation here; every placement gets a new id, also one identical to the last. */
    public function placeByUser(Category $category, Verdict $verdict, \DateTimeImmutable $at): Uuid
    {
        $this->classify($category, $verdict, ClassificationReason::USER, $at);
        $this->placementId = Uuid::v7();

        return $this->placementId;
    }

    /**
     * $other is merged into this conversation: a placement the user gave it carries over, unless this conversation has
     * a newer one of the user's own. A conversation the user placed and could see stays visible: a hold on this one
     * goes with it.
     */
    public function adoptUserPlacement(self $other): void
    {
        if (!$other->isClassifiedByUser()) {
            return;
        }
        if ($this->isClassifiedByUser() && null !== $this->classifiedAt && (null === $other->classifiedAt || $this->classifiedAt >= $other->classifiedAt)) {
            return;
        }
        $this->category = $other->category;
        $this->verdict = $other->verdict;
        $this->classificationReason = $other->classificationReason;
        $this->classifiedAt = $other->classifiedAt;
        $this->placementId = $other->placementId;
        if (null === $other->heldUntil) {
            $this->release($other->batchedAt);
        }
    }

    public function getPlacementId(): ?Uuid
    {
        return $this->placementId;
    }

    public function getHeldUntil(): ?\DateTimeImmutable
    {
        return $this->heldUntil;
    }

    public function getBatchedAt(): ?\DateTimeImmutable
    {
        return $this->batchedAt;
    }

    /** The conversation is delivered the way its newest incoming message is: held, from a batch, or as it came. */
    public function followDelivery(Message $newestIncoming): void
    {
        if ($this->heldUntil != $newestIncoming->getHeldUntil()) {
            $this->heldUntil = $newestIncoming->getHeldUntil();
        }
        if ($this->batchedAt != $newestIncoming->getBatchedAt()) {
            $this->batchedAt = $newestIncoming->getBatchedAt();
        }
    }

    /** See {@see Message::hold()}. */
    public function hold(\DateTimeImmutable $until): void
    {
        if ($this->heldUntil == $until) {
            return;
        }
        $this->heldUntil = $until;
        $this->batchedAt = null;
    }

    /** See {@see Message::release()}. */
    public function release(?\DateTimeImmutable $batch): void
    {
        if (null === $this->heldUntil) {
            return;
        }
        $this->heldUntil = null;
        $this->batchedAt = $batch;
    }

    public function getChangeOwner(): User
    {
        return $this->mailAccount->getOwner();
    }

    public static function clientFields(): ?array
    {
        return ['subject', 'messageCount', 'lastMessageAt', 'category', 'verdict', 'classificationReason', 'heldUntil', 'batchedAt'];
    }

    public static function changeType(): string
    {
        return 'thread';
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
