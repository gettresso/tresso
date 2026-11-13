<?php

declare(strict_types=1);

namespace App\Chat;

use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\ChatProblem;
use App\ApiResource\Input\Chat\QueueReply;
use App\ApiResource\Input\Chat\RelayResult;
use App\Entity\Chat;
use App\Entity\ChatAccount;
use App\Entity\ChatOutgoing;
use App\Entity\User;
use App\Enum\ChatOutgoingError;
use App\Enum\ChatOutgoingStatus;
use App\Repository\ChatOutgoingRepository;
use App\Repository\ChatRepository;
use App\Repository\ChatUploadRepository;
use App\Security\CallerKey;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\EntityNotFoundException;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;
use Symfony\Component\Uid\Uuid;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * The reply queue: replies written on any device wait here until the relaying desktop sends them through the bridge.
 *
 * - A reply's id comes from the client: the same id again returns the reply queued the first time, and the id of a
 *   reply that was cancelled (or went with a chat left out) is refused for good (409 `cancelled`).
 * - The relay claims the oldest waiting reply of its account (`waiting` to `sending`); a claimed reply is never handed
 *   out again. The bridge returns no id and keeps no record, so a send whose answer was lost cannot be resolved: a
 *   reply still `sending` after {@see CLAIM_LEASE} becomes `failed` with `unconfirmed`
 *   ({@see SweepChatRelaysHandler}), and only the user's Try again sends it once more. Sending twice is worse than
 *   asking.
 * - A result names its claim by the claim's token and is final: only that claim takes it, the same result again is
 *   answered as the first time, and `sent: true` still wins over `unconfirmed` of the same claim ({@see report()}).
 *
 * A reply may carry a file the client uploaded to the chat before ({@see ChatUploads}); only our own apps attach files.
 * The reply takes the upload over, and its file goes once the reply went out or is cancelled ({@see ChatMediaCollector}).
 *
 * Every write locks the owner first ({@see ChatOwnerLock}). Every way a reply ends reaches the devices: sent and failed
 * (also by the sweep) as the row with its new state in the delta, a cancelled reply as a removal (tombstone
 * `chatOutgoing`): cancelling deletes the row, or, for one that may have gone out, marks it `cancelled`, which writes the
 * same removal ({@see ChatOutgoing::isHiddenFromClients()}) and is purged after {@see KEEP_CANCELLED}.
 */
final readonly class ChatQueue
{
    /** How long a claimed reply may stay `sending` before it counts as unconfirmed. */
    public const string CLAIM_LEASE = 'PT5M';

    /**
     * The same for a reply that carries a file: the relay fetches it from the server, hands it to its shell and the bridge
     * uploads it to WhatsApp (up to 100 MB), which takes far longer than a text. A lease in the sweep rather than the relay
     * renewing its claim: a lease holds also when the relay crashed or lost its network halfway, which is exactly when a
     * renewal would stop, and it needs no call that could itself fail while the file goes out.
     */
    public const string FILE_CLAIM_LEASE = 'PT30M';

    /**
     * How long a reply cancelled while its sending was unconfirmed is kept (counted from its claim), so its relay's late
     * `sent: true` can still show that it went out. Its removal (the tombstone) stays after it, so its id stays refused;
     * an answer after this is not found, and the relay lets it go ({@see purgeCancelled()}, once a day).
     */
    public const string KEEP_CANCELLED = 'P30D';

    /** How long a claim of this reply lasts before the sweep fails it as unconfirmed. */
    public static function leaseOf(ChatOutgoing $outgoing): \DateInterval
    {
        return new \DateInterval(null === $outgoing->getFileObjectKey() ? self::CLAIM_LEASE : self::FILE_CLAIM_LEASE);
    }

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ChatRepository $chats,
        private ChatOutgoingRepository $outgoing,
        private ChatFields $fields,
        private ChatOwnerLock $ownerLock,
        private ChatClaims $claims,
        private ChatUploadRepository $uploads,
        private ChatMediaCollector $collector,
        #[Autowire(service: 'limiter.chat_reply')]
        private RateLimiterFactoryInterface $limiter,
        #[Autowire(service: 'limiter.chat_reply_caller')]
        private RateLimiterFactoryInterface $callerLimiter,
        #[Autowire(service: 'limiter.chat_reply_caller_day')]
        private RateLimiterFactoryInterface $callerDailyLimiter,
        #[Autowire(service: 'limiter.chat_reply_cancel')]
        private RateLimiterFactoryInterface $cancelLimiter,
        private ChangeSequencer $sequencer,
    ) {
    }

    /**
     * Queues the reply, or returns the one queued with its id before. Replies are limited per user (`chat_reply`, all
     * devices and tokens together) and, for a caller that is not one of our own apps ($caller, a {@see CallerKey}), per
     * caller as well (`chat_reply_caller`, `chat_reply_caller_day`). A repeat of a request queues nothing and counts for
     * no limit.
     *
     * @return array{ChatOutgoing, bool} the reply, and whether this request queued it
     */
    public function queue(User $user, mixed $chatId, QueueReply $input, \DateTimeImmutable $now, string $caller = CallerKey::OURS): array
    {
        $id = Uuid::fromString($input->id);
        if (null !== $input->file && CallerKey::OURS !== $caller) {
            throw new AccessDeniedHttpException('Only Tresso\'s own apps send files on WhatsApp.');
        }
        // The chat first: another user's chat is not found, whatever id the request names.
        $chat = \is_string($chatId) ? $this->chats->findOneOwnedBy($user, $chatId) : null;
        if (!$chat instanceof Chat) {
            throw new NotFoundHttpException('Chat not found.');
        }
        // A request sent again (its answer got lost) gets the reply back, whatever the age of its id says now, and one
        // the user cancelled meanwhile is refused as cancelled: both are looked up before the id's age, so a late repeat
        // never reads as "too old, make a new id", which would queue the cancelled reply again under another id.
        $queued = $this->alreadyQueued($id, $user, $chat);
        if (null !== $queued) {
            return [$queued, false];
        }
        if ($this->isCancelled($user, $id)) {
            $this->refuseCancelledWith($user, $chat, $input);
        }
        $late = $input->idViolations($now);
        if (\count($late) > 0) {
            throw new ValidationException($late);
        }
        self::refuseLeftOut($chat);
        if (CallerKey::OURS !== $caller) {
            $key = $user->getId()->toRfc4122().'|'.$caller;
            foreach ([
                [$this->callerLimiter, 'This app or token queued too many WhatsApp messages in the last 10 minutes. Wait a few minutes, then try again.'],
                [$this->callerDailyLimiter, 'This app or token queued too many WhatsApp messages in the last day. Try again tomorrow.'],
            ] as [$factory, $message]) {
                $callerLimit = $factory->create($key)->consume();
                if (!$callerLimit->isAccepted()) {
                    throw new TooManyRequestsHttpException(max(1, $callerLimit->getRetryAfter()->getTimestamp() - time()), $message);
                }
            }
        }
        $limit = $this->limiter->create($user->getId()->toRfc4122())->consume();
        if (!$limit->isAccepted()) {
            throw new TooManyRequestsHttpException($limit->getRetryAfter()->getTimestamp() - time(), 'Too many WhatsApp replies at once. Wait a few minutes, then try again.');
        }

        try {
            $queued = $this->entityManager->wrapInTransaction(function () use ($user, $id, $chat, $input, $now): ?array {
                // Two requests with one id take turns here, so the second finds the reply of the first.
                $this->ownerLock->lock($user->getId());
                $queued = $this->alreadyQueued($id, $user, $chat);
                if (null !== $queued) {
                    return [$queued, false];
                }
                // Cancelled while this request waited for the lock: refused after this transaction (null).
                if ($this->isCancelled($user, $id)) {
                    return null;
                }
                // Left out or removed while this request waited.
                try {
                    $this->entityManager->refresh($chat);
                } catch (EntityNotFoundException) {
                    throw new NotFoundHttpException('Chat not found.');
                }
                self::refuseLeftOut($chat);

                $outgoing = $this->fields->newOutgoing($id, $chat, trim($input->text), $now);
                if (null !== $input->file) {
                    $upload = $this->uploads->findOneForChat($user, $chat, $input->file->uploadId);
                    if (null !== $upload) {
                        // Taken under its row lock, so the sweep of uploads nobody queued (which skips locked rows) cannot
                        // remove it and its file between here and the commit.
                        try {
                            $this->entityManager->refresh($upload, LockMode::PESSIMISTIC_WRITE);
                        } catch (EntityNotFoundException) {
                            $upload = null;
                        }
                    }
                    if (null === $upload) {
                        throw new ValidationException(new ConstraintViolationList([
                            new ConstraintViolation('This file is not uploaded to this chat, or it waited too long. Upload it again.', null, [], null, 'file.uploadId', null),
                        ]));
                    }
                    // Taken over: the reply refers to the file from here on, so it is never without one.
                    $this->fields->attachFile($outgoing, $input->file->cleanName(), $upload);
                    $this->entityManager->remove($upload);
                }
                $this->entityManager->persist($outgoing);
                $this->entityManager->flush();

                return [$outgoing, true];
            });
        } catch (UniqueConstraintViolationException) {
            // Another user's reply took this id at the same moment.
            throw ChatProblem::idTaken();
        }

        return $queued ?? $this->refuseCancelledWith($user, $chat, $input);
    }

    /**
     * Refuses the queueing of a reply the user cancelled before it arrived (409 `cancelled`). The file uploaded for it
     * goes now (in its own transaction, under the owner's lock and the upload's row lock, as queueing takes it): nothing
     * will ever take it, and until the hourly sweep it would count toward the waiting files of the user and the chat.
     */
    private function refuseCancelledWith(User $user, Chat $chat, QueueReply $input): never
    {
        if (null !== $input->file) {
            $uploadId = $input->file->uploadId;
            $this->entityManager->wrapInTransaction(function () use ($user, $chat, $uploadId): void {
                $this->ownerLock->lock($user->getId());
                $upload = $this->uploads->findOneForChat($user, $chat, $uploadId);
                if (null === $upload) {
                    return;
                }
                try {
                    $this->entityManager->refresh($upload, LockMode::PESSIMISTIC_WRITE);
                } catch (EntityNotFoundException) {
                    return;
                }
                $this->collector->release([$upload->getObjectKey()]);
                $this->entityManager->remove($upload);
                $this->entityManager->flush();
            });
        }

        throw ChatProblem::cancelled();
    }

    /**
     * The oldest reply of the account that waits, now `sending` for its relay, and the claim's token; null when none
     * waits. Inside the relay's transaction.
     *
     * @return array{ChatOutgoing, string}|null
     */
    public function claim(ChatAccount $account, \DateTimeImmutable $now): ?array
    {
        $claim = $this->claims->claim($account->getOwner()->getId(), $account->getId(), $account->getRelayDeviceId(), $now);
        if (null === $claim) {
            return null;
        }
        $outgoing = $this->entityManager->find(ChatOutgoing::class, Uuid::fromString($claim['id'])) ?? throw new \LogicException('A claimed reply exists.');

        return [$outgoing, $claim['token']];
    }

    /**
     * Takes a result for a reply. It must name the claim it reports on: the claim's token, which only the claiming relay
     * got, compared in constant time.
     *
     * - A reply being sent takes the result of its claim.
     * - `sent: true` over `unconfirmed` of the same claim is taken: the reply did go out, and Try again would send it
     *   twice. A definite `sent: false` of the same claim over `unconfirmed` is taken too: nothing went out, and the user
     *   sees why instead of "check your phone". Neither sends anything: it is the claim's answer arriving late.
     * - A desktop that no longer relays the account may still say that a reply it claimed went out ($fromRelay false):
     *   `sent: true`, with its claim's token, from the device that claimed it; anything else is 409 `not_the_relay`.
     * - A reply the user cancelled while it was `unconfirmed` keeps its claim: `sent: true` of that claim turns it into
     *   `sent` (back in every list), any other answer leaves it cancelled.
     * - A result that changes nothing (the same result again, after its answer got lost) is answered as the first time;
     *   the claim may have ended with it, so no token is asked. Any other is refused: 409 `result_final`.
     *
     * Inside the relay's transaction.
     */
    public function report(ChatAccount $account, mixed $outgoingId, RelayResult $result, string $deviceId, bool $fromRelay, \DateTimeImmutable $now): ChatOutgoing
    {
        $outgoing = \is_string($outgoingId) && Uuid::isValid($outgoingId)
            ? $this->entityManager->find(ChatOutgoing::class, Uuid::fromString($outgoingId), LockMode::PESSIMISTIC_WRITE)
            : null;
        if (!$outgoing instanceof ChatOutgoing || !$outgoing->getChatAccount()->getId()->equals($account->getId())) {
            if (!$fromRelay) {
                throw ChatProblem::notTheRelay();
            }
            throw new NotFoundHttpException('No such reply for this account.');
        }
        $this->entityManager->refresh($outgoing);
        $sent = $result->sent ?? throw new \LogicException('Validation guarantees a result.');
        $token = $outgoing->getClaimToken();
        $claimedBy = $outgoing->getClaimedBy();
        $theClaim = null !== $token && hash_equals($token, $result->claimToken)
            && ($fromRelay || (null !== $claimedBy && Uuid::isValid($deviceId) && $claimedBy->equals(Uuid::fromString($deviceId))));

        $status = $outgoing->getStatus();
        // The sweep (or the relay itself) said `unconfirmed`, and the claim's own outcome arrives after all: it is the
        // answer, not a send. `sent: true` (it did go out: Try again would send it twice) and a definite `sent: false`
        // (nothing went out: the user sees the real reason) both replace it; `unconfirmed` again changes nothing.
        $lateOutcome = ChatOutgoingStatus::Failed === $status && ChatOutgoingError::Unconfirmed === $outgoing->getError()
            && ($sent || ChatOutgoingError::Unconfirmed !== $result->error);
        if (ChatOutgoingStatus::Cancelled === $status && $theClaim && ($fromRelay || $sent)) {
            // Cancelled while it may have gone out: `sent: true` says it did, and every device shows it again as sent; any
            // other answer leaves it cancelled. Nothing is sent either way.
            if ($sent) {
                $outgoing->markSent($now);
                $outgoing->getChat()->messageAt($now);
                $this->entityManager->flush();
            }

            return $outgoing;
        }
        if ($theClaim && ($fromRelay || $sent) && (ChatOutgoingStatus::Sending === $status || $lateOutcome)) {
            if ($sent) {
                // It went out: the file it carried is no longer needed here.
                $this->collector->release([$outgoing->markSent($now)]);
                $outgoing->getChat()->messageAt($now);
            } else {
                $outgoing->markFailed($result->error ?? throw new \LogicException('Validation guarantees an error.'));
            }
            $this->entityManager->flush();

            return $outgoing;
        }
        if (self::sameResult($outgoing, $sent, $result->error)) {
            return $outgoing;
        }

        throw $fromRelay ? ChatProblem::resultFinal() : ChatProblem::notTheRelay();
    }

    /**
     * Removes a reply that waits or failed; one that is being sent or was sent stays.
     */
    public function cancel(User $user, mixed $outgoingId, \DateTimeImmutable $now): void
    {
        $this->entityManager->wrapInTransaction(function () use ($user, $outgoingId, $now): void {
            $this->ownerLock->lock($user->getId());
            $outgoing = \is_string($outgoingId) ? $this->outgoing->findOneOwnedBy($user, $outgoingId) : null;
            if (!$outgoing instanceof ChatOutgoing) {
                $this->cancelUnseen($user, $outgoingId, $now);

                return;
            }
            $this->entityManager->refresh($outgoing);
            $status = $outgoing->getStatus();
            if (ChatOutgoingStatus::Cancelled === $status) {
                return;
            }
            if (!\in_array($status, [ChatOutgoingStatus::Waiting, ChatOutgoingStatus::Failed], true)) {
                throw ChatProblem::alreadyGoingOut();
            }
            if (ChatOutgoingError::Unconfirmed === $outgoing->getError() && null !== $outgoing->getClaimToken()) {
                // It may have gone out, and its relay may still say so: kept as cancelled with its claim (out of every
                // list, never handed out again), so a late `sent: true` can still show on every device that it did go.
                $this->collector->release([$outgoing->markCancelled()]);
                $this->entityManager->flush();

                return;
            }
            $this->collector->release([$outgoing->getFileObjectKey()]);
            $this->entityManager->remove($outgoing);
            $this->entityManager->flush();
        });
    }

    /**
     * A cancel for a reply the server has not seen: its queueing may still be on its way (the cancel overtook it). When
     * the id is one a new reply could have (a UUIDv7 made in the last 10 minutes) and nobody holds it, the removal is
     * written now, so that queueing, arriving later, is refused for good (409 `cancelled`, {@see refuseCancelledWith()}).
     * Limited per user (`chat_reply_cancel`). Another id is not found. Inside the cancel's transaction, under the owner's
     * lock, which queueing takes too.
     */
    private function cancelUnseen(User $user, mixed $outgoingId, \DateTimeImmutable $now): void
    {
        if (!\is_string($outgoingId) || !Uuid::isValid($outgoingId)) {
            throw new NotFoundHttpException('Reply not found.');
        }
        $id = Uuid::fromString($outgoingId);
        if (null !== $this->entityManager->find(ChatOutgoing::class, $id) || !QueueReply::freshId($id, $now)) {
            throw new NotFoundHttpException('Reply not found.');
        }
        if ($this->isCancelled($user, $id)) {
            return;
        }
        $limit = $this->cancelLimiter->create($user->getId()->toRfc4122())->consume();
        if (!$limit->isAccepted()) {
            throw new TooManyRequestsHttpException(max(1, $limit->getRetryAfter()->getTimestamp() - time()), 'Too many replies cancelled at once. Wait a few minutes, then try again.');
        }
        $this->sequencer->tombstones($user->getId(), ChatOutgoing::changeType(), [$id->toRfc4122()], $this->sequencer->next($user->getId()));
    }

    /**
     * Removes replies cancelled while their sending was unconfirmed whose claim is older than {@see KEEP_CANCELLED}: their
     * sealed text and claim token are not kept without limit. Their tombstone, written when they were cancelled, stays,
     * so the devices keep them removed and their id stays refused. Their file went when they were cancelled. A batch at
     * a time, skipping rows a report holds. Returns how many went.
     */
    public function purgeCancelled(\DateTimeImmutable $now): int
    {
        return (int) $this->connection->executeStatement(
            'DELETE FROM chat_outgoing WHERE id IN (SELECT id FROM chat_outgoing WHERE status = :cancelled AND claimed_at < :before ORDER BY claimed_at LIMIT 1000 FOR UPDATE SKIP LOCKED)',
            ['cancelled' => ChatOutgoingStatus::Cancelled->value, 'before' => $now->sub(new \DateInterval(self::KEEP_CANCELLED))->format('Y-m-d H:i:s')],
        );
    }

    /**
     * The user's Try again: a reply that failed waits for the relay again.
     */
    public function retry(User $user, mixed $outgoingId, \DateTimeImmutable $now): ChatOutgoing
    {
        return $this->entityManager->wrapInTransaction(function () use ($user, $outgoingId, $now): ChatOutgoing {
            $outgoing = $this->lockedOwned($user, $outgoingId);
            if (ChatOutgoingStatus::Failed !== $outgoing->getStatus()) {
                throw ChatProblem::notFailed();
            }
            // A reply that may have gone out whose claim still runs: its relay may still be sending it, and handing it out
            // again now could send it twice. It waits until the claim's lease is over (its own answer may come meanwhile).
            $claimedAt = $outgoing->getClaimedAt();
            if (ChatOutgoingError::Unconfirmed === $outgoing->getError() && null !== $outgoing->getClaimToken() && null !== $claimedAt && $claimedAt->add(self::leaseOf($outgoing)) > $now) {
                throw ChatProblem::stillSending();
            }
            $outgoing->retry();
            $this->entityManager->flush();

            return $outgoing;
        });
    }

    private function lockedOwned(User $user, mixed $outgoingId): ChatOutgoing
    {
        $this->ownerLock->lock($user->getId());
        $outgoing = \is_string($outgoingId) ? $this->outgoing->findOneOwnedBy($user, $outgoingId) : null;
        if (!$outgoing instanceof ChatOutgoing) {
            throw new NotFoundHttpException('Reply not found.');
        }
        $this->entityManager->refresh($outgoing);

        return $outgoing;
    }

    /**
     * A reply the user cancelled (or that went with a chat left out) is gone, and its removal is all that is left of it:
     * a repeat of the request that queued it must not queue it again. The type is written into the statement, not bound,
     * so the planner sees that the partial index on it applies (sync_tombstone_chat_outgoing) for a generic plan too.
     */
    private function isCancelled(User $user, Uuid $id): bool
    {
        return false !== $this->connection->fetchOne(
            \sprintf("SELECT 1 FROM sync_tombstone WHERE user_id = :user AND entity_type = '%s' AND entity_id = :id", ChatOutgoing::changeType()),
            ['user' => $user->getId()->toRfc4122(), 'id' => $id->toRfc4122()],
        );
    }

    private function alreadyQueued(Uuid $id, User $user, Chat $chat): ?ChatOutgoing
    {
        $existing = $this->entityManager->find(ChatOutgoing::class, $id);
        if (null === $existing) {
            return null;
        }
        if (!$existing->getChat()->getId()->equals($chat->getId()) || !$existing->getChatAccount()->getOwner()->getId()->equals($user->getId())) {
            throw ChatProblem::idTaken();
        }
        if (ChatOutgoingStatus::Cancelled === $existing->getStatus()) {
            // Cancelled while it may have gone out: never queued again under its id.
            throw ChatProblem::cancelled();
        }

        return $existing;
    }

    private static function sameResult(ChatOutgoing $outgoing, bool $sent, ?ChatOutgoingError $error): bool
    {
        return $sent
            ? ChatOutgoingStatus::Sent === $outgoing->getStatus()
            : ChatOutgoingStatus::Failed === $outgoing->getStatus() && $error === $outgoing->getError();
    }

    private static function refuseLeftOut(Chat $chat): void
    {
        if ($chat->isLeftOut()) {
            throw new ValidationException(new ConstraintViolationList([
                new ConstraintViolation('This chat is left out of Tresso; nothing is sent to it.', null, [], null, 'chatId', null),
            ]));
        }
    }
}
