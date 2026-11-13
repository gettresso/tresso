<?php

declare(strict_types=1);

namespace App\Chat;

use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\ChatProblem;
use App\Entity\Chat;
use App\Entity\ChatUpload;
use App\Entity\User;
use App\Repository\ChatRepository;
use App\Storage\BlobKey;
use App\Storage\BlobKind;
use App\Storage\BlobVault;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\EntityNotFoundException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\DelayStamp;
use Symfony\Component\Uid\Uuid;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * Files a browser or phone uploads for a reply, before it queues the reply ({@see ChatQueue::queue()} with `file`). The
 * id comes from the client, so an upload sent again (its answer got lost) names the same one: the same content is
 * answered with the upload it made, other content under that id is 409 `id_taken`. An upload is kept until a reply takes
 * it over, and at most {@see KEEP_UNQUEUED}; a chat holds at most {@see MAX_UNQUEUED} at a time.
 */
final readonly class ChatUploads
{
    /** How long an upload nobody queued a reply with is kept. */
    public const string KEEP_UNQUEUED = 'PT1H';

    /** Uploads one chat may hold that no reply took yet. */
    public const int MAX_UNQUEUED = 20;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ChatRepository $chats,
        private ChatOwnerLock $ownerLock,
        private BlobVault $blobs,
        private ChatMediaCollector $collector,
        private MessageBusInterface $bus,
    ) {
    }

    /**
     * @return array{ChatUpload, bool} the upload, and whether this request made it
     */
    public function upload(User $user, mixed $chatId, mixed $uploadId, ReceivedChatFile $file, \DateTimeImmutable $now): array
    {
        if (!\is_string($uploadId) || !Uuid::isValid($uploadId)) {
            throw new ValidationException(new ConstraintViolationList([new ConstraintViolation('The upload id is not a UUID.', null, [], null, 'id', null)]));
        }
        $id = Uuid::fromString($uploadId);
        $chat = \is_string($chatId) ? $this->chats->findOneOwnedBy($user, $chatId) : null;
        if (!$chat instanceof Chat) {
            throw new NotFoundHttpException('Chat not found.');
        }
        self::refuseLeftOut($chat);

        $owner = $user->getId();
        $key = BlobKey::of(BlobKind::ChatMedia, $owner, $this->blobs->fingerprint($owner, $file->sha256));
        try {
            return $this->entityManager->wrapInTransaction(function () use ($user, $chat, $id, $file, $key, $owner, $now): array {
                $this->collector->lock($key);
                $existing = $this->entityManager->find(ChatUpload::class, $id);
                if (null !== $existing) {
                    return [$this->same($existing, $user, $chat, $key), false];
                }
                $handle = $file->open();
                try {
                    $stored = $this->blobs->store($owner, BlobKind::ChatMedia, $handle);
                } finally {
                    fclose($handle);
                }
                $this->ownerLock->lock($owner);
                try {
                    $this->entityManager->refresh($chat);
                } catch (EntityNotFoundException) {
                    throw new NotFoundHttpException('Chat not found.');
                }
                self::refuseLeftOut($chat);
                $waiting = $this->connection->fetchOne('SELECT COUNT(*) FROM chat_upload WHERE chat_id = :chat', ['chat' => $chat->getId()->toRfc4122()]);
                if (is_numeric($waiting) && (int) $waiting >= self::MAX_UNQUEUED) {
                    throw new TooManyRequestsHttpException(600, 'Too many files wait in this chat. Send or remove some first.');
                }
                $upload = new ChatUpload($id, $chat, $stored->key, $stored->keyVersion, $stored->fingerprint, $file->size, $file->contentType, $now);
                $this->entityManager->persist($upload);
                $this->entityManager->flush();

                return [$upload, true];
            });
        } catch (\Throwable $exception) {
            // Written but maybe not referred to: it goes again unless a message, reply or upload has it.
            $this->bus->dispatch(new CollectChatMedia($key), [new DelayStamp(60_000)]);
            throw $exception;
        }
    }

    /**
     * Removes uploads nobody queued a reply with in time, with their files. Returns how many went.
     */
    public function sweep(\DateTimeImmutable $now): int
    {
        return $this->entityManager->wrapInTransaction(function () use ($now): int {
            /** @var list<array{id: string, object_key: string}> $rows */
            $rows = $this->connection->fetchAllAssociative(
                'DELETE FROM chat_upload WHERE id IN (SELECT id FROM chat_upload WHERE created_at < :before ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED) RETURNING id, object_key',
                ['before' => $now->sub(new \DateInterval(self::KEEP_UNQUEUED))->format('Y-m-d H:i:s')],
            );
            $this->collector->release(array_column($rows, 'object_key'));

            return \count($rows);
        });
    }

    private function same(ChatUpload $existing, User $user, Chat $chat, string $key): ChatUpload
    {
        if (!$existing->getChat()->getId()->equals($chat->getId()) || !$existing->getChatAccount()->getOwner()->getId()->equals($user->getId()) || $existing->getObjectKey() !== $key) {
            throw ChatProblem::idTaken();
        }

        return $existing;
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
