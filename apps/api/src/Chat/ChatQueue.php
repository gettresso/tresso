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
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\EntityNotFoundException;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
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
 * - A result names its claim and is final: only the claim it names takes it, the same result again is answered as the
 *   first time, and `sent: true` still wins over `unconfirmed` of the same claim ({@see report()}).
 *
 * Every write locks the owner first ({@see ChatOwnerLock}). Every way a reply ends reaches the devices: sent and failed
 * (also by the sweep) as the row with its new state in the delta, a cancelled reply as a removal (tombstone
 * `chatOutgoing`), since cancelling deletes the row. Nothing writes the status `cancelled`, which the delta would leave
 * out without a removal.
 */
final readonly class ChatQueue
{
    /** How long a claimed reply may stay `sending` before it counts as unconfirmed. */
    public const string CLAIM_LEASE = 'PT5M';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ChatRepository $chats,
        private ChatOutgoingRepository $outgoing,
        private ChatFields $fields,
        private ChatOwnerLock $ownerLock,
        private ChatClaims $claims,
        #[Autowire(service: 'limiter.chat_reply')]
        private RateLimiterFactoryInterface $limiter,
    ) {
    }

    /**
     * Queues the reply, or returns the one queued with its id before.
     *
     * @return array{ChatOutgoing, bool} the reply, and whether this request queued it
     */
    public function queue(User $user, mixed $chatId, QueueReply $input, \DateTimeImmutable $now): array
    {
        $id = Uuid::fromString($input->id);
        // The chat first: another user's chat is not found, whatever id the request names.
        $chat = \is_string($chatId) ? $this->chats->findOneOwnedBy($user, $chatId) : null;
        if (!$chat instanceof Chat) {
            throw new NotFoundHttpException('Chat not found.');
        }
        // A request sent again (its answer got lost) gets the reply back, whatever the age of its id says now.
        $queued = $this->alreadyQueued($id, $user, $chat);
        if (null !== $queued) {
            return [$queued, false];
        }
        $late = $input->idViolations($now);
        if (\count($late) > 0) {
            throw new ValidationException($late);
        }
        self::refuseLeftOut($chat);
        $limit = $this->limiter->create($user->getId()->toRfc4122())->consume();
        if (!$limit->isAccepted()) {
            throw new TooManyRequestsHttpException($limit->getRetryAfter()->getTimestamp() - time(), 'Too many WhatsApp replies at once. Wait a few minutes, then try again.');
        }

        try {
            return $this->entityManager->wrapInTransaction(function () use ($user, $id, $chat, $input, $now): array {
                // Two requests with one id take turns here, so the second finds the reply of the first.
                $this->ownerLock->lock($user->getId());
                $queued = $this->alreadyQueued($id, $user, $chat);
                if (null !== $queued) {
                    return [$queued, false];
                }
                // A reply the user cancelled (or that went with a chat left out) is gone, and its removal is all that is
                // left of it: a repeat of the request that queued it must not queue it again.
                if (false !== $this->connection->fetchOne(
                    'SELECT 1 FROM sync_tombstone WHERE user_id = :user AND entity_type = :type AND entity_id = :id',
                    ['user' => $user->getId()->toRfc4122(), 'type' => ChatOutgoing::changeType(), 'id' => $id->toRfc4122()],
                )) {
                    throw ChatProblem::cancelled();
                }
                // Left out or removed while this request waited.
                try {
                    $this->entityManager->refresh($chat);
                } catch (EntityNotFoundException) {
                    throw new NotFoundHttpException('Chat not found.');
                }
                self::refuseLeftOut($chat);

                $outgoing = $this->fields->newOutgoing($id, $chat, trim($input->text), $now);
                $this->entityManager->persist($outgoing);
                $this->entityManager->flush();

                return [$outgoing, true];
            });
        } catch (UniqueConstraintViolationException) {
            // Another user's reply took this id at the same moment.
            throw ChatProblem::idTaken();
        }
    }

    /**
     * The oldest reply of the account that waits, now `sending`; null when none waits. Inside the relay's transaction.
     */
    public function claim(ChatAccount $account, \DateTimeImmutable $now): ?ChatOutgoing
    {
        $id = $this->claims->claim($account->getOwner()->getId(), $account->getId(), $now);

        return null === $id ? null : $this->entityManager->find(ChatOutgoing::class, Uuid::fromString($id));
    }

    /**
     * Takes a result for a reply. It is bound to the claim it reports on (`claimedAt` as the claim answered it): a
     * result of an earlier claim, or for a reply nobody claimed, is refused.
     *
     * - A reply being sent takes the result.
     * - The same result again (its answer got lost) is answered as the first time.
     * - `sent: true` over `unconfirmed` of the same claim is taken: the reply did go out, and Try again would send it
     *   twice. Any other result over a final one is refused (409 `result_final`).
     * - A desktop that no longer relays the account may still say that a reply it claimed went out ($fromRelay false):
     *   `sent: true` with its claim only; anything else is 409 `not_the_relay`.
     *
     * Inside the relay's transaction.
     */
    public function report(ChatAccount $account, mixed $outgoingId, RelayResult $result, bool $fromRelay, \DateTimeImmutable $now): ChatOutgoing
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
        $claim = $result->claimedAt ?? throw new \LogicException('Validation guarantees the claim.');
        $sameClaim = $outgoing->getClaimedAt()?->getTimestamp() === $claim->getTimestamp();
        if (!$fromRelay && (!$sameClaim || !$sent)) {
            throw ChatProblem::notTheRelay();
        }
        if (!$sameClaim) {
            throw ChatProblem::resultFinal();
        }

        $status = $outgoing->getStatus();
        $wentOutAfterAll = $sent && ChatOutgoingStatus::Failed === $status && ChatOutgoingError::Unconfirmed === $outgoing->getError();
        if (ChatOutgoingStatus::Sending === $status || $wentOutAfterAll) {
            if ($sent) {
                $outgoing->markSent($now);
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

        throw ChatProblem::resultFinal();
    }

    /**
     * Removes a reply that waits or failed; one that is being sent or was sent stays.
     */
    public function cancel(User $user, mixed $outgoingId): void
    {
        $this->entityManager->wrapInTransaction(function () use ($user, $outgoingId): void {
            $outgoing = $this->lockedOwned($user, $outgoingId);
            if (!\in_array($outgoing->getStatus(), [ChatOutgoingStatus::Waiting, ChatOutgoingStatus::Failed], true)) {
                throw ChatProblem::alreadyGoingOut();
            }
            $this->entityManager->remove($outgoing);
            $this->entityManager->flush();
        });
    }

    /**
     * The user's Try again: a reply that failed waits for the relay again.
     */
    public function retry(User $user, mixed $outgoingId): ChatOutgoing
    {
        return $this->entityManager->wrapInTransaction(function () use ($user, $outgoingId): ChatOutgoing {
            $outgoing = $this->lockedOwned($user, $outgoingId);
            if (ChatOutgoingStatus::Failed !== $outgoing->getStatus()) {
                throw ChatProblem::notFailed();
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

    private function alreadyQueued(Uuid $id, User $user, Chat $chat): ?ChatOutgoing
    {
        $existing = $this->entityManager->find(ChatOutgoing::class, $id);
        if (null === $existing) {
            return null;
        }
        if (!$existing->getChat()->getId()->equals($chat->getId()) || !$existing->getChatAccount()->getOwner()->getId()->equals($user->getId())) {
            throw ChatProblem::idTaken();
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
