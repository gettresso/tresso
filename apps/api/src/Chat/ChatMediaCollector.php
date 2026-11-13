<?php

declare(strict_types=1);

namespace App\Chat;

use App\Realtime\AfterCommitDispatcher;
use App\Storage\BlobKey;
use App\Storage\BlobKind;
use App\Storage\ObjectStorage;
use Doctrine\DBAL\Connection;

/**
 * Removes WhatsApp files nobody needs any more. A file is stored under its owner and the fingerprint of its content
 * ({@see BlobKey}), so two messages or replies with the same content share one object, and an object is only removed
 * once no message, reply or upload refers to it. Storing a file and removing it take the same lock on its key, so a
 * file is never removed between being stored and being referred to.
 *
 * What lets go of a file, and when its object goes:
 * - a reply that went out (its file is no longer needed; its name and size stay as the record);
 * - a reply that is cancelled, an upload nobody queued within {@see ChatUploads::KEEP_UNQUEUED};
 * - a chat left out, group chats taken off the server, the chat account removed (with all of its files);
 * - the user removed: every object under the user goes ({@see \App\Account\PurgeDeletedUserHandler}).
 *
 * Content that was quarantined goes too once no attachment, draft file or chat file of its owner has that content.
 */
final readonly class ChatMediaCollector
{
    public function __construct(
        private Connection $connection,
        private ObjectStorage $storage,
        private AfterCommitDispatcher $afterCommit,
    ) {
    }

    /** Holds the key until the transaction ends. Call it inside the transaction that stores or removes the file. */
    public function lock(string $objectKey): void
    {
        $this->connection->executeStatement('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', ['key' => $objectKey]);
    }

    /**
     * The files are no longer referred to by the rows that are going: each is checked once the transaction is in.
     *
     * @param iterable<mixed> $objectKeys null entries (rows without a file) are skipped
     */
    public function release(iterable $objectKeys): void
    {
        $keys = [];
        foreach ($objectKeys as $key) {
            if (\is_string($key)) {
                $keys[$key] = true;
            }
        }
        foreach (array_keys($keys) as $key) {
            $this->afterCommit->dispatch(new CollectChatMedia($key));
        }
    }

    /**
     * The keys of every file of an account, or of some of its chats, for {@see release()} before the rows go.
     *
     * @param list<string>|null $chatIds null for all chats of the account
     *
     * @return list<string>
     */
    public function keysOf(string $accountId, ?array $chatIds = null): array
    {
        if ([] === $chatIds) {
            return [];
        }
        $filter = null === $chatIds ? '' : ' AND chat_id = ANY(CAST(:chats AS UUID[]))';
        $parameters = ['account' => $accountId] + (null === $chatIds ? [] : ['chats' => '{'.implode(',', $chatIds).'}']);

        /** @var list<string> */
        return $this->connection->fetchFirstColumn(
            'SELECT media_object_key FROM chat_message WHERE chat_account_id = :account AND media_object_key IS NOT NULL'.$filter.'
             UNION SELECT file_object_key FROM chat_outgoing WHERE chat_account_id = :account AND file_object_key IS NOT NULL'.$filter.'
             UNION SELECT object_key FROM chat_upload WHERE chat_account_id = :account'.$filter,
            $parameters,
        );
    }

    /** Removes the file when nothing refers to it any more. */
    public function collect(string $objectKey): void
    {
        $parsed = BlobKey::parse($objectKey);
        if (null === $parsed || BlobKind::ChatMedia !== $parsed->kind) {
            throw new \LogicException('Only WhatsApp files are collected here.');
        }
        $this->connection->transactional(function () use ($objectKey, $parsed): void {
            // The verdict's lock first, then the key's, in the order re-encryption takes them: content cannot be
            // quarantined, released or written again while its last copy goes.
            $this->connection->executeStatement("SELECT pg_advisory_xact_lock(hashtextextended('scan:' || :sha, 0))", ['sha' => $parsed->fingerprint]);
            $this->lock($objectKey);
            $parameters = ['key' => $objectKey, 'fingerprint' => $parsed->fingerprint];
            $referenced = (bool) $this->connection->fetchOne(
                'SELECT EXISTS (SELECT 1 FROM chat_message WHERE media_sha256 = :fingerprint AND media_object_key = :key)
                     OR EXISTS (SELECT 1 FROM chat_outgoing WHERE file_sha256 = :fingerprint AND file_object_key = :key)
                     OR EXISTS (SELECT 1 FROM chat_upload WHERE sha256 = :fingerprint AND object_key = :key)',
                $parameters,
            );
            if ($referenced) {
                return;
            }
            $this->storage->delete($objectKey);
            $held = (bool) $this->connection->fetchOne(
                'SELECT EXISTS (SELECT 1 FROM attachment WHERE sha256 = :fingerprint)
                     OR EXISTS (SELECT 1 FROM draft_attachment WHERE sha256 = :fingerprint)
                     OR EXISTS (SELECT 1 FROM chat_message WHERE media_sha256 = :fingerprint)',
                ['fingerprint' => $parsed->fingerprint],
            );
            if (!$held) {
                $this->storage->delete(BlobKey::of(BlobKind::Quarantine, $parsed->owner, $parsed->fingerprint));
            }
        });
    }
}
