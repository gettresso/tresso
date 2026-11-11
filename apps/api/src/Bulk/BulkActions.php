<?php

declare(strict_types=1);

namespace App\Bulk;

use App\Entity\BulkAction;
use App\Entity\BulkActionMove;
use App\Entity\Folder;
use App\Entity\MailAccount;
use App\Entity\Message;
use App\Entity\User;
use App\Enum\BulkActionStatus;
use App\Enum\FolderRole;
use App\Enum\MessageAction;
use App\Mailbox\MessageActions;
use App\Mailbox\MissingFolder;
use App\Realtime\AfterCommitDispatcher;
use App\Repository\BulkActionRepository;
use App\Repository\MessageRepository;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Runs an action on every conversation of a {@see BulkScope}, however many there are, through the same
 * {@see MessageActions} a single action uses. The work goes in short transactions of at most
 * {@see self::CONVERSATIONS_PER_BATCH} conversations and about {@see self::MESSAGES_PER_BATCH} messages each, so no
 * lock is held for long and the clients see the mail change batch by batch through the delta.
 *
 * Archive, trash and move can be undone like a single action (`undoPlan` in packages/core): only the messages the
 * action moved go back, each from where it went into the one folder it came from. Messages that came from several
 * folders, or that were archived into Gmail's All Mail, stay where they are and are counted.
 */
final readonly class BulkActions
{
    public const int CONVERSATIONS_PER_BATCH = 200;
    public const int MESSAGES_PER_BATCH = 500;
    public const int MOVES_PER_UNDO_BATCH = 500;

    /** An account's changes still to be made on its mail server above which a run waits. */
    public const int MAX_PENDING_CHANGES = 1000;

    /** How long a run waits for a mail server that is behind before it stops. */
    public const int MAX_WAIT_SECONDS = 3600;

    /** How long a finished bulk action can still be undone. */
    public const string KEPT_FOR = '-1 day';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private BulkSelection $selection,
        private MessageActions $actions,
        private MessageRepository $messages,
        private BulkActionRepository $bulkActions,
        private AfterCommitDispatcher $dispatcher,
        private int $conversationsPerBatch = self::CONVERSATIONS_PER_BATCH,
        private int $messagesPerBatch = self::MESSAGES_PER_BATCH,
        private int $movesPerUndoBatch = self::MOVES_PER_UNDO_BATCH,
        private int $maxPendingChanges = self::MAX_PENDING_CHANGES,
        private int $scanPerBatch = BulkSelection::SCAN_PER_BATCH,
        private int $maxWaitSeconds = self::MAX_WAIT_SECONDS,
    ) {
    }

    /**
     * Starts the action; the first batches run in the background once the caller's transaction commits.
     *
     * @throws MissingFolder     when an account in scope has no folder to archive or trash into; nothing starts then
     * @throws BulkActionRunning when the user has one under way already
     */
    public function start(User $owner, BulkScope $scope, MessageAction $action, ?Folder $target, \DateTimeImmutable $now): BulkAction
    {
        $this->oneAtATime($owner);
        $bulkAction = new BulkAction($owner, $action, $target, $scope, $now);

        // Every account in scope must have the folder before anything changes, as for a single action.
        foreach ($this->selection->count($owner, $scope, $bulkAction->getId())['mailAccountIds'] as $accountId) {
            $account = $this->entityManager->find(MailAccount::class, Uuid::fromString($accountId)) ?? throw new \LogicException('The account was just found.');
            $this->actions->folderFor($account, $action);
        }

        $this->bulkActions->deleteFinished($owner, $now->modify(self::KEPT_FOR));
        $this->entityManager->persist($bulkAction);
        $this->entityManager->flush();
        $this->dispatcher->dispatch(new RunBulkAction($bulkAction->getId()->toRfc4122()));

        return $bulkAction;
    }

    /**
     * Starts putting back what the action moved; the caller holds the action's row lock.
     *
     * @throws BulkActionRunning when the user has another one under way
     */
    public function undo(BulkAction $bulkAction): void
    {
        $this->oneAtATime($bulkAction->getOwner());
        $bulkAction->startUndo();
        $bulkAction->touch(new \DateTimeImmutable());
        $this->entityManager->flush();
        $this->dispatcher->dispatch(new RunBulkAction($bulkAction->getId()->toRfc4122()));
    }

    /**
     * Works through up to $maxBatches batches, each in its own transaction, for at most about $seconds.
     *
     * @phpstan-impure
     */
    public function run(Uuid $id, ?int $maxBatches = null, ?float $seconds = null): BulkRun
    {
        $deadline = null === $seconds ? null : microtime(true) + $seconds;
        for ($batch = 0; null === $maxBatches || $batch < $maxBatches; ++$batch) {
            $outcome = $this->entityManager->wrapInTransaction(fn (): BulkRun => $this->batch($id));
            $this->entityManager->clear();
            if (BulkRun::More !== $outcome) {
                return $outcome;
            }
            if (null !== $deadline && microtime(true) >= $deadline) {
                break;
            }
        }

        return BulkRun::More;
    }

    /** Stops the action or its undo; what it did so far stays, and can be undone. The caller holds its row lock. */
    public function cancel(BulkAction $bulkAction): void
    {
        $bulkAction->fail('You stopped it. What was done stays done, and can be undone.', new \DateTimeImmutable());
        $this->entityManager->flush();
    }

    /**
     * Marks the action as stopped, for when its run keeps failing; what it did so far stays and can be undone. Written
     * with plain SQL: after a batch failed, the entity manager is closed, and this must still work.
     */
    public function fail(Uuid $id, string $error): void
    {
        $this->connection->executeStatement(
            'UPDATE bulk_action SET status = :failed, error = :error, resume_account = NULL, resume_after = NULL, waiting_since = NULL, finished_at = :now
             WHERE id = :id AND status IN (:running, :undoing)',
            [
                'failed' => BulkActionStatus::Failed->value,
                'error' => mb_substr($error, 0, 255),
                'now' => (new \DateTimeImmutable())->format('Y-m-d H:i:s'),
                'id' => $id->toRfc4122(),
                'running' => BulkActionStatus::Running->value,
                'undoing' => BulkActionStatus::Undoing->value,
            ],
        );
    }

    private function batch(Uuid $id): BulkRun
    {
        $bulkAction = $this->entityManager->find(BulkAction::class, $id, LockMode::PESSIMISTIC_WRITE);
        $status = $bulkAction?->getStatus();
        if (null === $bulkAction || !\in_array($status, [BulkActionStatus::Running, BulkActionStatus::Undoing], true)) {
            return BulkRun::Done;
        }
        $bulkAction->touch(new \DateTimeImmutable());

        return BulkActionStatus::Running === $status ? $this->actBatch($bulkAction) : $this->undoBatch($bulkAction);
    }

    /**
     * One bulk action (or undo) per user at a time: the lock makes two requests at once take turns, so the second
     * sees the first.
     *
     * @throws BulkActionRunning
     */
    private function oneAtATime(User $owner): void
    {
        $this->connection->executeStatement('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', ['key' => 'bulk:'.$owner->getId()->toRfc4122()]);
        $running = $this->connection->fetchOne(
            'SELECT 1 FROM bulk_action WHERE owner_id = :owner AND status IN (:running, :undoing) LIMIT 1',
            ['owner' => $owner->getId()->toRfc4122(), 'running' => BulkActionStatus::Running->value, 'undoing' => BulkActionStatus::Undoing->value],
        );
        if (false !== $running) {
            throw new BulkActionRunning();
        }
    }

    /**
     * Whether the batch has to wait: each moved or flagged message is one change the worker makes on the mail server,
     * oldest first, so while an account the batch touches has a backlog, more would only hold up what the user does to
     * single conversations meanwhile. Only those accounts count: a stuck account elsewhere holds nothing up. An action
     * that has waited {@see self::MAX_WAIT_SECONDS} stops, keeping what it did, so the user can undo it or start again.
     *
     * @param list<Message> $messages the batch's messages
     *
     * @return BulkRun|null Wait or Done when the batch must not go on, null when it may
     */
    private function blocked(BulkAction $bulkAction, array $messages, \DateTimeImmutable $now): ?BulkRun
    {
        $accounts = [];
        foreach ($messages as $message) {
            $accounts[$message->getMailAccount()->getId()->toRfc4122()] = $message->getMailAccount();
        }
        $behind = [] === $accounts ? false : $this->connection->fetchOne(
            'SELECT mail_account_id FROM mailbox_change WHERE mail_account_id = ANY(CAST(:accounts AS UUID[]))
             GROUP BY mail_account_id HAVING COUNT(*) >= :max ORDER BY mail_account_id LIMIT 1',
            ['accounts' => '{'.implode(',', array_keys($accounts)).'}', 'max' => $this->maxPendingChanges],
        );
        if (false === $behind) {
            $bulkAction->resume();

            return null;
        }

        $since = $bulkAction->waitFrom($now);
        if ($now->getTimestamp() - $since->getTimestamp() >= $this->maxWaitSeconds) {
            $account = \is_string($behind) ? $accounts[$behind] ?? null : null;
            if (null === $account) {
                throw new \LogicException('The account behind is one of the batch\'s.');
            }

            return $this->stop($bulkAction, \sprintf('The mail server of %s has not taken the changes for an hour. What was done stays done, and can be undone.', $account->getEmailAddress()), $now);
        }
        $this->entityManager->flush();

        return BulkRun::Wait;
    }

    private function actBatch(BulkAction $bulkAction): BulkRun
    {
        $now = new \DateTimeImmutable();
        $scope = $bulkAction->getScope();
        if (null === $scope) {
            return $this->stop($bulkAction, 'The smart inbox was deleted.', $now);
        }
        $action = $bulkAction->getAction();
        $target = $bulkAction->getTargetFolder();
        if (MessageAction::Move === $action && null === $target) {
            return $this->stop($bulkAction, 'The folder to move to was deleted.', $now);
        }

        $owner = $bulkAction->getOwner();
        $batch = $this->selection->nextBatch($owner, $scope, $bulkAction->getId(), $bulkAction->getResumeAccount(), $bulkAction->getResumeAfter(), $this->conversationsPerBatch, $this->messagesPerBatch, $this->scanPerBatch);
        $threadIds = $batch->threadIds;

        $messages = array_values($this->messages->lockOwnedBy($owner, $this->selection->messageIds($threadIds, $bulkAction->getId())));
        $blocked = $this->blocked($bulkAction, $messages, $now);
        if (null !== $blocked) {
            return $blocked;
        }
        // Read after the locks: where each message is now decides what the undo can put back.
        $before = $this->folders($messages);
        try {
            $changed = $this->actions->apply($messages, $action, $target, $now);
        } catch (MissingFolder $missing) {
            return $this->stop($bulkAction, $missing->getMessage(), $now);
        }

        $unrestorable = 0;
        if (\in_array($action, [MessageAction::Archive, MessageAction::Trash, MessageAction::Move], true)) {
            $targets = [];
            foreach ($messages as $message) {
                $account = $message->getMailAccount();
                $to = $targets[$account->getId()->toRfc4122()] ??= $target ?? $this->actions->folderFor($account, $action) ?? throw new \LogicException('An archive or trash has a folder.');
                $moved = $this->movedFrom($action, $to, $before[$message->getId()->toRfc4122()] ?? []);
                if (false === $moved) {
                    continue;
                }
                if (null === $moved[1]) {
                    ++$unrestorable;
                    continue;
                }
                $this->entityManager->persist(new BulkActionMove($bulkAction, $message, $moved[0], $moved[1]));
            }
        }

        $bulkAction->recordBatch($batch->account, $batch->after, \count($threadIds), $changed, $unrestorable);
        if ($batch->done) {
            $bulkAction->finish($now);
        }
        $this->entityManager->flush();

        return $batch->done ? BulkRun::Done : BulkRun::More;
    }

    private function undoBatch(BulkAction $bulkAction): BulkRun
    {
        $query = $this->entityManager->createQueryBuilder()
            ->select('m')
            ->from(BulkActionMove::class, 'm')
            ->where('m.bulkAction = :bulkAction')
            ->setParameter('bulkAction', $bulkAction->getId(), 'uuid')
            ->orderBy('m.id')
            ->setMaxResults($this->movesPerUndoBatch);
        if (null !== $bulkAction->getResumeAfter()) {
            $query->andWhere('m.id > :after')->setParameter('after', $bulkAction->getResumeAfter(), 'uuid');
        }
        /** @var list<BulkActionMove> $moves */
        $moves = $query->getQuery()->getResult();
        $now = new \DateTimeImmutable();
        if ([] === $moves) {
            $bulkAction->finish($now);
            $this->entityManager->flush();

            return BulkRun::Done;
        }

        $locked = $this->messages->lockOwnedBy($bulkAction->getOwner(), array_map(static fn (BulkActionMove $move): string => $move->getMessage()->getId()->toRfc4122(), $moves));
        /** @var array<string, array{Folder, Folder, list<Message>}> $groups */
        $groups = [];
        foreach ($moves as $move) {
            $message = $locked[$move->getMessage()->getId()->toRfc4122()] ?? null;
            if (null === $message) {
                continue;
            }
            $key = $move->getMovedTo()->getId()->toRfc4122().'>'.$move->getMovedFrom()->getId()->toRfc4122();
            $groups[$key] ??= [$move->getMovedTo(), $move->getMovedFrom(), []];
            $groups[$key][2][] = $message;
        }
        $blocked = $this->blocked($bulkAction, array_values($locked), $now);
        if (null !== $blocked) {
            return $blocked;
        }

        $restored = 0;
        foreach ($groups as [$movedTo, $movedFrom, $messages]) {
            // Only the copies still where the action put them go back; mail moved on since stays where it is now.
            $restored += $this->actions->apply($messages, MessageAction::Move, $movedFrom, $now, $movedTo, oneCopy: true);
        }

        $bulkAction->recordRestored($moves[\count($moves) - 1]->getId(), $restored);
        $this->entityManager->flush();

        return BulkRun::More;
    }

    private function stop(BulkAction $bulkAction, string $error, \DateTimeImmutable $now): BulkRun
    {
        $bulkAction->fail($error, $now);
        $this->entityManager->flush();

        return BulkRun::Done;
    }

    /**
     * Whether the action moves the message and how to put it back, as `undoPlan` in packages/core decides: false when
     * it does not move, [where it goes, the one folder it came from], or [where it goes, null] when no move puts it
     * back exactly.
     *
     * @param Folder       $target  where the action takes the message's account's mail
     * @param list<Folder> $folders where the message is before the action
     *
     * @return false|array{Folder, ?Folder}
     */
    private function movedFrom(MessageAction $action, Folder $target, array $folders): false|array
    {
        $leaving = array_filter($folders, static fn (Folder $folder): bool => $folder !== $target && (MessageAction::Archive !== $action || FolderRole::Inbox === $folder->getRole()));
        if ([] === $leaving) {
            return false;
        }
        $original = array_values(array_filter($folders, static fn (Folder $folder): bool => FolderRole::All !== $folder->getRole()));

        if (MessageAction::Archive === $action) {
            // Archiving into Gmail's All Mail cannot be undone by a move: moving out of All Mail deletes.
            $inboxes = array_values(array_filter($original, static fn (Folder $folder): bool => FolderRole::Inbox === $folder->getRole()));
            $from = FolderRole::Archive === $target->getRole() && 1 === \count($inboxes) && !\in_array($target, $folders, true) ? $inboxes[0] : null;
        } else {
            $from = 1 === \count($original) ? $original[0] : null;
        }
        if (null !== $from && \in_array($from->getRole(), [FolderRole::Drafts, FolderRole::All], true)) {
            $from = null;
        }

        return [$target, $from];
    }

    /**
     * @param list<Message> $messages
     *
     * @return array<string, list<Folder>> the folders each message has a copy in, by message id
     */
    private function folders(array $messages): array
    {
        if ([] === $messages) {
            return [];
        }
        /** @var list<array{message_id: string, folder_id: string}> $rows */
        $rows = $this->connection->fetchAllAssociative(
            'SELECT message_id, folder_id FROM message_location WHERE message_id = ANY(CAST(:ids AS UUID[]))',
            ['ids' => '{'.implode(',', array_map(static fn (Message $message): string => $message->getId()->toRfc4122(), $messages)).'}'],
        );
        $folders = [];
        foreach ($rows as $row) {
            $folder = $this->entityManager->find(Folder::class, Uuid::fromString($row['folder_id'])) ?? throw new \LogicException('A copy is in a folder.');
            if (!\in_array($folder, $folders[$row['message_id']] ?? [], true)) {
                $folders[$row['message_id']][] = $folder;
            }
        }

        return $folders;
    }
}
