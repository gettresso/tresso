<?php

declare(strict_types=1);

namespace App\Chat;

use App\ApiResource\ChatProblem;
use App\Entity\ChatAccount;
use App\Entity\ChatMessage;
use App\Entity\User;
use App\Enum\ChatMediaError;
use App\Enum\ChatMediaState;
use App\Realtime\AfterCommitDispatcher;
use App\Repository\ChatMessageRepository;
use App\Scan\ScanAttachment;
use App\Scan\ScanTarget;
use App\Storage\BlobKey;
use App\Storage\BlobKind;
use App\Storage\BlobVault;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\DelayStamp;
use Symfony\Component\Uid\Uuid;

/**
 * Files of chat messages, brought from the relaying Mac on request ("All my devices"). A file stays on the Mac until
 * the user asks for it on another device; nothing is downloaded without that.
 *
 * 1. The user asks ({@see request()}): `remote` or `failed` to `requested`. A file asked for already or stored stays.
 * 2. The relay takes the oldest request of its account ({@see claim()}); a request it took is handed out again only
 *    after {@see CLAIM_LEASE}, when that relay did not answer.
 * 3. The relay downloads the file through its bridge, checks it against the SHA-256 the bridge's store holds, and
 *    uploads it ({@see store()}: sealed with the owner's key, `stored`, scanned before it is served), or says why it
 *    could not ({@see fail()}: `failed` with a {@see ChatMediaError}; the user may ask again).
 *
 * A stored file is kept as long as its message; it goes with a chat left out, group chats taken off the server and the
 * chat account ({@see ChatMediaCollector}).
 */
final readonly class ChatMedia
{
    /** How long a request the relay took stays its own before it is handed out again. */
    public const string CLAIM_LEASE = 'PT15M';

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ChatMessageRepository $messages,
        private ChatOwnerLock $ownerLock,
        private ChatRelayGuard $guard,
        private BlobVault $blobs,
        private ChatMediaCollector $collector,
        private AfterCommitDispatcher $afterCommit,
        private MessageBusInterface $bus,
    ) {
    }

    /**
     * The user asks for the message's file. Another user's message, and a message without a file, are not found.
     */
    public function request(User $user, mixed $messageId, \DateTimeImmutable $now): ChatMessage
    {
        return $this->entityManager->wrapInTransaction(function () use ($user, $messageId, $now): ChatMessage {
            $this->ownerLock->lock($user->getId());
            $message = $this->owned($user, $messageId);
            $this->entityManager->refresh($message, LockMode::PESSIMISTIC_WRITE);
            if (null === $message->getMediaState()) {
                throw new NotFoundHttpException('This message has no file.');
            }
            if ($message->getChat()->isLeftOut()) {
                throw new NotFoundHttpException('Chat message not found.');
            }
            $message->requestMedia($now);
            $this->entityManager->flush();

            return $message;
        });
    }

    /** The message's file as the user reads it: their own message with a file, or not found. */
    public function find(User $user, mixed $messageId): ChatMessage
    {
        $message = $this->owned($user, $messageId);
        if (null === $message->getMediaState()) {
            throw new NotFoundHttpException('This message has no file.');
        }

        return $message;
    }

    /**
     * The oldest request of the account that no relay holds, now held by the relay; null when none waits. Inside the
     * relay's transaction ({@see ChatRelayGuard}).
     */
    public function claim(ChatAccount $account, \DateTimeImmutable $now): ?ChatMessage
    {
        $id = $this->connection->fetchOne(
            'SELECT id FROM chat_message
              WHERE chat_account_id = :account AND media_state = :requested AND (media_claimed_at IS NULL OR media_claimed_at < :stale)
              ORDER BY media_requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED',
            [
                'account' => $account->getId()->toRfc4122(),
                'requested' => ChatMediaState::Requested->value,
                'stale' => $now->sub(new \DateInterval(self::CLAIM_LEASE))->format('Y-m-d H:i:s'),
            ],
        );
        if (!\is_string($id)) {
            return null;
        }
        $message = $this->entityManager->find(ChatMessage::class, Uuid::fromString($id)) ?? throw new \LogicException('A claimed message exists.');
        $this->entityManager->refresh($message);
        $message->claimMedia($now);
        $this->entityManager->flush();

        return $message;
    }

    /**
     * The relay brought a file it was asked for. It is stored under the owner and the fingerprint of its content, sealed
     * with the owner's key, then the message refers to it and a scan is queued. The same file again (its answer got
     * lost) changes nothing; a file nobody asked for is 409 `not_requested`.
     *
     * The object is written before the relay's lock is taken (a large file takes a while), under the lock on its key, so
     * it is not collected before the message refers to it; a write that is not referred to in the end is collected.
     */
    public function store(User $user, mixed $accountId, mixed $messageId, string $deviceId, ReceivedChatFile $file, \DateTimeImmutable $now): ChatMessage
    {
        // Checked first, so a desktop that does not relay the account, or a file nobody asked for, costs no storage.
        $this->entityManager->wrapInTransaction(function () use ($user, $accountId, $messageId, $deviceId, $now): void {
            $account = $this->guard->relayedAccount($user, $accountId, $deviceId, $now);
            $message = $this->ofAccount($account, $messageId);
            if (ChatMediaState::Requested !== $message->getMediaState() && ChatMediaState::Stored !== $message->getMediaState()) {
                throw ChatProblem::notRequested();
            }
        });
        $this->entityManager->clear();

        $owner = $user->getId();
        $key = BlobKey::of(BlobKind::ChatMedia, $owner, $this->blobs->fingerprint($owner, $file->sha256));
        try {
            $message = $this->entityManager->wrapInTransaction(function () use ($user, $accountId, $messageId, $deviceId, $file, $key, $now, $owner): ChatMessage {
                $this->collector->lock($key);
                $handle = $file->open();
                try {
                    $stored = $this->blobs->store($owner, BlobKind::ChatMedia, $handle);
                } finally {
                    fclose($handle);
                }
                $account = $this->guard->relayedAccount($user, $accountId, $deviceId, $now);
                $message = $this->ofAccount($account, $messageId);
                $this->entityManager->refresh($message, LockMode::PESSIMISTIC_WRITE);
                if (ChatMediaState::Stored === $message->getMediaState() && $message->getMediaSha256() === $stored->fingerprint) {
                    return $message;
                }
                if (ChatMediaState::Requested !== $message->getMediaState()) {
                    throw ChatProblem::notRequested();
                }
                $message->storeMedia($stored->key, $stored->keyVersion, $stored->fingerprint, $file->size, $file->contentType, $now);
                $this->entityManager->flush();
                $this->afterCommit->dispatch(new ScanAttachment($message->getId()->toRfc4122(), ScanTarget::Chat));

                return $message;
            });
        } catch (\Throwable $exception) {
            // Written but maybe not referred to: it goes again unless a message, reply or upload has it.
            $this->bus->dispatch(new CollectChatMedia($key), [new DelayStamp(60_000)]);
            throw $exception;
        }

        return $message;
    }

    /**
     * The relay could not bring a file it was asked for. The same failure again changes nothing; a file that is stored
     * meanwhile, or that nobody asked for, is 409 `not_requested`. Inside the relay's transaction.
     */
    public function fail(ChatAccount $account, mixed $messageId, ChatMediaError $error): ChatMessage
    {
        $message = $this->ofAccount($account, $messageId);
        $this->entityManager->refresh($message, LockMode::PESSIMISTIC_WRITE);
        if (ChatMediaState::Failed === $message->getMediaState() && $error === $message->getMediaError()) {
            return $message;
        }
        if (ChatMediaState::Requested !== $message->getMediaState()) {
            throw ChatProblem::notRequested();
        }
        $message->failMedia($error);
        $this->entityManager->flush();

        return $message;
    }

    private function owned(User $user, mixed $messageId): ChatMessage
    {
        $message = \is_string($messageId) ? $this->messages->findOneOwnedBy($user, $messageId) : null;
        if (!$message instanceof ChatMessage) {
            throw new NotFoundHttpException('Chat message not found.');
        }

        return $message;
    }

    private function ofAccount(ChatAccount $account, mixed $messageId): ChatMessage
    {
        $message = \is_string($messageId) && Uuid::isValid($messageId) ? $this->entityManager->find(ChatMessage::class, Uuid::fromString($messageId)) : null;
        if (!$message instanceof ChatMessage || !$message->getChatAccount()->getId()->equals($account->getId()) || null === $message->getMediaState()) {
            throw new NotFoundHttpException('No such file for this account.');
        }

        return $message;
    }
}
