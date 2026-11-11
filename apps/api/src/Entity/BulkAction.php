<?php

declare(strict_types=1);

namespace App\Entity;

use App\Bulk\BulkScope;
use App\Enum\BulkActionStatus;
use App\Enum\BulkArea;
use App\Enum\MessageAction;
use App\Repository\BulkActionRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * One action on every conversation in a scope (a smart inbox, one of its senders, mail older than an age), worked
 * through in short batches by {@see \App\Bulk\BulkActions}. It only takes mail that reached Tresso before it started:
 * message ids are time-ordered (UUIDv7), so a message whose id sorts below this action's id is older than the action.
 * What it moved is kept as {@see BulkActionMove} rows, so it can be undone the way a single action is.
 */
#[ORM\Entity(repositoryClass: BulkActionRepository::class)]
#[ORM\Index(columns: ['owner_id', 'created_at'])]
class BulkAction
{
    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $owner;

    #[ORM\Column(length: 16, enumType: MessageAction::class)]
    private MessageAction $action;

    /** For a move; null once the folder is gone, which stops the run. */
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(onDelete: 'SET NULL')]
    private ?Folder $targetFolder;

    #[ORM\Column(length: 16, enumType: BulkArea::class)]
    private BulkArea $area;

    /** For {@see BulkArea::SmartInbox}; null once the smart inbox is deleted, which stops the run. */
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(onDelete: 'SET NULL')]
    private ?Category $smartInbox;

    /** Only this account's conversations (a move stays within one account). */
    #[ORM\ManyToOne]
    #[ORM\JoinColumn(onDelete: 'CASCADE')]
    private ?MailAccount $mailAccount;

    /** Only conversations with a message from this address. */
    #[ORM\Column(length: 320, nullable: true)]
    private ?string $sender;

    /** Only conversations whose newest message is older than this. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $lastMessageBefore;

    /** Only conversations with a message of at least this many bytes. */
    #[ORM\Column(type: Types::BIGINT, nullable: true)]
    private ?int $largerThan;

    #[ORM\Column(length: 16, enumType: BulkActionStatus::class)]
    private BulkActionStatus $status = BulkActionStatus::Running;

    /** The account the next batch looks at; null for a smart inbox, which spans them, and while undoing. */
    #[ORM\Column(type: UuidType::NAME, nullable: true)]
    private ?Uuid $resumeAccount = null;

    /** Where the next batch starts: the last thread id looked at, or while undoing the last move row id put back. */
    #[ORM\Column(type: UuidType::NAME, nullable: true)]
    private ?Uuid $resumeAfter = null;

    /** Conversations worked through. */
    #[ORM\Column]
    private int $conversations = 0;

    /** Messages that changed; the others already were that way. */
    #[ORM\Column]
    private int $changed = 0;

    /** Changed messages an undo cannot put back exactly (they were in several folders, or archived into All Mail). */
    #[ORM\Column]
    private int $unrestorable = 0;

    /** Messages the undo put back. */
    #[ORM\Column]
    private int $restored = 0;

    /** Why it stopped, for {@see BulkActionStatus::Failed}. */
    #[ORM\Column(length: 255, nullable: true)]
    private ?string $error = null;

    /** Since when the run waits for a mail server that is behind; null while it goes on. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $waitingSince = null;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $finishedAt = null;

    /**
     * When a run last handled it (a batch, an undo batch, a wait). A run under way handles it at least every 30
     * seconds, so one that has not for a while lost its queue message: see {@see \App\Bulk\SweepBulkActionsHandler}.
     */
    #[ORM\Column]
    private \DateTimeImmutable $updatedAt;

    public function __construct(User $owner, MessageAction $action, ?Folder $targetFolder, BulkScope $scope, \DateTimeImmutable $now)
    {
        $this->id = Uuid::v7();
        $this->owner = $owner;
        $this->action = $action;
        $this->targetFolder = $targetFolder;
        $this->area = $scope->area;
        $this->smartInbox = $scope->smartInbox;
        $this->mailAccount = $scope->mailAccount;
        $this->sender = $scope->sender;
        $this->lastMessageBefore = $scope->before;
        $this->largerThan = $scope->largerThan;
        $this->createdAt = $now;
        $this->updatedAt = $now;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getOwner(): User
    {
        return $this->owner;
    }

    public function getAction(): MessageAction
    {
        return $this->action;
    }

    public function getTargetFolder(): ?Folder
    {
        return $this->targetFolder;
    }

    /** The scope as it was asked for; null once the smart inbox it was about is gone. */
    public function getScope(): ?BulkScope
    {
        if (BulkArea::SmartInbox === $this->area && null === $this->smartInbox) {
            return null;
        }

        return new BulkScope($this->area, $this->smartInbox, $this->mailAccount, $this->sender, $this->lastMessageBefore, $this->largerThan);
    }

    public function getArea(): BulkArea
    {
        return $this->area;
    }

    public function getSmartInbox(): ?Category
    {
        return $this->smartInbox;
    }

    public function getMailAccount(): ?MailAccount
    {
        return $this->mailAccount;
    }

    public function getSender(): ?string
    {
        return $this->sender;
    }

    public function getLastMessageBefore(): ?\DateTimeImmutable
    {
        return $this->lastMessageBefore;
    }

    public function getLargerThan(): ?int
    {
        return $this->largerThan;
    }

    public function getStatus(): BulkActionStatus
    {
        return $this->status;
    }

    public function getResumeAccount(): ?Uuid
    {
        return $this->resumeAccount;
    }

    public function getResumeAfter(): ?Uuid
    {
        return $this->resumeAfter;
    }

    public function getConversations(): int
    {
        return $this->conversations;
    }

    public function getChanged(): int
    {
        return $this->changed;
    }

    public function getUnrestorable(): int
    {
        return $this->unrestorable;
    }

    public function getRestored(): int
    {
        return $this->restored;
    }

    public function getError(): ?string
    {
        return $this->error;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getUpdatedAt(): \DateTimeImmutable
    {
        return $this->updatedAt;
    }

    /** A run handles it now. */
    public function touch(\DateTimeImmutable $now): void
    {
        $this->updatedAt = $now;
    }

    public function getWaitingSince(): ?\DateTimeImmutable
    {
        return $this->waitingSince;
    }

    /** Notes that the run waits, from now unless it waited already; returns since when. */
    public function waitFrom(\DateTimeImmutable $now): \DateTimeImmutable
    {
        return $this->waitingSince ??= $now;
    }

    public function resume(): void
    {
        $this->waitingSince = null;
    }

    /** Whether it can be stopped: it, or its undo, is under way. */
    public function canCancel(): bool
    {
        return \in_array($this->status, [BulkActionStatus::Running, BulkActionStatus::Undoing], true);
    }

    public function getFinishedAt(): ?\DateTimeImmutable
    {
        return $this->finishedAt;
    }

    /** Whether an undo can start: the action moved mail and is no longer running. */
    public function canUndo(): bool
    {
        return \in_array($this->status, [BulkActionStatus::Done, BulkActionStatus::Failed], true)
            && \in_array($this->action, [MessageAction::Archive, MessageAction::Trash, MessageAction::Move], true);
    }

    public function recordBatch(?Uuid $account, ?Uuid $after, int $conversations, int $changed, int $unrestorable): void
    {
        $this->resumeAccount = $account;
        $this->resumeAfter = $after;
        $this->conversations += $conversations;
        $this->changed += $changed;
        $this->unrestorable += $unrestorable;
    }

    public function recordRestored(Uuid $lastMoveId, int $restored): void
    {
        $this->resumeAfter = $lastMoveId;
        $this->restored += $restored;
    }

    public function finish(\DateTimeImmutable $now): void
    {
        $this->waitingSince = null;
        $this->status = BulkActionStatus::Undoing === $this->status ? BulkActionStatus::Undone : BulkActionStatus::Done;
        $this->resumeAccount = null;
        $this->resumeAfter = null;
        $this->finishedAt = $now;
    }

    public function fail(string $error, \DateTimeImmutable $now): void
    {
        $this->waitingSince = null;
        $this->status = BulkActionStatus::Failed;
        $this->error = mb_substr($error, 0, 255);
        $this->resumeAccount = null;
        $this->resumeAfter = null;
        $this->finishedAt = $now;
    }

    public function startUndo(): void
    {
        if (!$this->canUndo()) {
            throw new \LogicException('This bulk action cannot be undone.');
        }
        $this->status = BulkActionStatus::Undoing;
        $this->resumeAccount = null;
        $this->resumeAfter = null;
        $this->restored = 0;
        $this->error = null;
        $this->finishedAt = null;
    }
}
