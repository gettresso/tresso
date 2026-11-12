<?php

declare(strict_types=1);

namespace App\Storage;

use App\Chat\ChatField;
use App\Chat\ChatFields;
use App\Entity\Attachment;
use App\Entity\MailAccount;
use App\Entity\ProviderGrant;
use App\Entity\User;
use App\Mail\MessageFields;
use App\Outbox\UploadCollector;
use App\Security\Crypto\CredentialVault;
use App\Security\Crypto\CryptoException;
use App\Security\Crypto\UserKeys;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Brings a user's stored data to their current key version: content from before encryption (plaintext under its
 * plain SHA-256) and content encrypted with an older version after a rotation. Then it deletes the older versions.
 *
 * Every step selects only rows not on the current version yet, in id order a batch at a time, and updates each row in
 * its own short transaction after its new object is written, guarded by the value it read. So it can be stopped and
 * run again at any time, and rows written meanwhile (by sync or by users) are fine: they are on the current version
 * already, or the next run takes them. A row that fails is logged and skipped; the next run tries it again.
 */
final readonly class Reencryption
{
    private const string HAS_WORK = 'u.keys_shredded_at IS NULL
        AND (u.data_key_version IS NULL
             OR u.data_key_version < (SELECT MAX(k.version) FROM user_key k WHERE k.owner_id = u.id)
             OR EXISTS (SELECT 1 FROM user_key k WHERE k.owner_id = u.id AND k.version < u.data_key_version))';

    public const array STEPS = ['credentials', 'messages', 'attachments', 'draftFiles', 'outgoing', 'bodyTexts', 'snippets', 'notificationBodies', 'chatFields'];

    public function __construct(
        private Connection $connection,
        private EntityManagerInterface $entityManager,
        private UserKeys $keys,
        private BlobVault $blobs,
        private ObjectStorage $storage,
        private CredentialVault $credentials,
        private MessageFields $fields,
        private ChatFields $chatFields,
        private UploadCollector $uploads,
        private LoggerInterface $logger,
    ) {
    }

    /**
     * Re-encrypts what is not on the owner's current version yet, until $until if given (whatever is left then is for
     * the next run). $progress hears each step with how many rows it moved and how many failed.
     *
     * @param callable(string, int, int): void $progress
     */
    public function run(Uuid $owner, int $batch, callable $progress, ?\DateTimeImmutable $until = null): ReencryptionResult
    {
        $this->keys->ensure($owner);
        $current = $this->keys->current($owner)->version;
        $failed = 0;
        foreach (self::STEPS as $step) {
            if (self::past($until)) {
                // The rest is for the next run; counting it below shows how much is left.
                break;
            }
            [$moved, $stepFailed] = match ($step) {
                'credentials' => $this->credentials($owner),
                'messages' => $this->messages($owner, $current, $batch, $until),
                'attachments' => $this->attachments($owner, $current, $batch, $until),
                'draftFiles' => $this->draftFiles($owner, $current, $batch, $until),
                'outgoing' => $this->outgoing($owner, $current, $batch, $until),
                'bodyTexts' => $this->bodyTexts($owner, $current, $batch, $until),
                'snippets' => $this->snippets($owner, $current, $batch, $until),
                'notificationBodies' => $this->notificationBodies($owner, $current, $batch, $until),
                'chatFields' => $this->chatFields($owner, $current, $batch, $until),
            };
            $failed += $stepFailed;
            $progress($step, $moved, $stepFailed);
        }

        $retired = [];
        $left = array_sum($this->remaining($owner));
        if (0 === $left) {
            // What the background job and its sweep go by: all data is on this version.
            $this->connection->executeStatement('UPDATE app_user SET data_key_version = :current WHERE id = :owner', ['current' => $current, 'owner' => $owner->toRfc4122()]);
            // Counted again under the lock retiring takes: an ingest naming an older version holds a shared lock on the
            // owner until it commits, so its rows are seen.
            $retired = $this->keys->retireOlderVersions($owner, new \DateTimeImmutable(), fn (): bool => 0 === array_sum($this->remaining($owner)));
        }
        $this->keys->reset();

        return new ReencryptionResult($current, $failed, $left, $retired, $this->keys->versions($owner));
    }

    /**
     * Rows of the owner not on their current key version yet, per step.
     *
     * @return array<string, int>
     */
    public function remaining(Uuid $owner): array
    {
        // Counting never sets up keys: without any, nothing is on a current version yet.
        $versions = $this->keys->hasKeys($owner) ? $this->keys->versions($owner) : [];
        $current = [] === $versions ? 0 : max($versions);
        $parameters = ['owner' => $owner->toRfc4122(), 'current' => $current, 'sealed' => 'f1.'.$current.'.%'];

        return [
            'credentials' => self::count($this->connection->fetchOne(
                'SELECT (SELECT COUNT(*) FROM mail_account WHERE owner_id = :owner AND encrypted_credentials IS NOT NULL AND encrypted_credentials NOT LIKE :sealed)
                      + (SELECT COUNT(*) FROM provider_grant WHERE owner_id = :owner AND encrypted_tokens NOT LIKE :sealed)',
                $parameters,
            )),
            'messages' => self::count($this->connection->fetchOne(
                'SELECT COUNT(*) FROM message m JOIN mail_account a ON a.id = m.mail_account_id WHERE a.owner_id = :owner AND m.raw_key_version IS DISTINCT FROM :current',
                $parameters,
            )),
            'attachments' => self::count($this->connection->fetchOne(
                'SELECT COUNT(*) FROM attachment t JOIN mail_account a ON a.id = t.mail_account_id WHERE a.owner_id = :owner AND t.key_version IS DISTINCT FROM :current',
                $parameters,
            )),
            'draftFiles' => self::count($this->connection->fetchOne(
                'SELECT COUNT(*) FROM draft_attachment f JOIN draft d ON d.id = f.draft_id WHERE d.owner_id = :owner AND f.key_version IS DISTINCT FROM :current',
                $parameters,
            )),
            'outgoing' => self::count($this->connection->fetchOne(
                'SELECT COUNT(*) FROM outgoing_message o JOIN mail_account a ON a.id = o.mail_account_id WHERE a.owner_id = :owner AND o.raw_key_version IS DISTINCT FROM :current',
                $parameters,
            )),
            'bodyTexts' => self::count($this->connection->fetchOne(
                'SELECT COUNT(*) FROM message_text t JOIN message m ON m.id = t.message_id JOIN mail_account a ON a.id = m.mail_account_id
                 WHERE a.owner_id = :owner AND (t.sealed_text IS NULL OR t.sealed_text NOT LIKE :sealed)',
                $parameters,
            )),
            'snippets' => self::count($this->connection->fetchOne(
                'SELECT COUNT(*) FROM message m JOIN mail_account a ON a.id = m.mail_account_id WHERE a.owner_id = :owner AND (m.sealed_snippet IS NULL OR m.sealed_snippet NOT LIKE :sealed)',
                $parameters,
            )),
            'notificationBodies' => self::count($this->connection->fetchOne(
                "SELECT COUNT(*) FROM mail_notification WHERE user_id = :owner AND ((sealed_body IS NULL AND body <> '') OR sealed_body NOT LIKE :sealed)",
                $parameters,
            )),
            // Every sealed chat column, counted per column: a row with two old values is two values to reseal.
            'chatFields' => self::count($this->connection->fetchOne(
                'SELECT '.implode(' + ', array_map(
                    static fn (ChatField $field): string => \sprintf('(SELECT COUNT(*) FROM %1$s AND x.%2$s IS NOT NULL AND x.%2$s NOT LIKE :sealed)', $field->ownedRows(), $field->column()),
                    ChatField::cases(),
                )),
                ['owner' => $parameters['owner'], 'sealed' => $parameters['sealed']],
            )),
        ];
    }

    /**
     * Rows anywhere that still refer to content from before encryption, under its plain SHA-256.
     */
    public function legacyContentLeft(): int
    {
        return self::count($this->connection->fetchOne(
            'SELECT (SELECT COUNT(*) FROM message WHERE raw_key_version IS NULL)
                  + (SELECT COUNT(*) FROM attachment WHERE key_version IS NULL)
                  + (SELECT COUNT(*) FROM draft_attachment WHERE key_version IS NULL)
                  + (SELECT COUNT(*) FROM outgoing_message WHERE raw_key_version IS NULL)',
        ));
    }

    /**
     * Deletes the plaintext objects stored before encryption. They may be shared between users, so this only runs once
     * no row anywhere refers to one. It deletes those re-encryption recorded (`legacy_object`), and lists only
     * `drafts/`, whose copies no row ever referred to; with $scanBucket it lists every kind, for content no row knew of
     * (say an upload whose ingest batch never arrived). Returns how many were deleted.
     */
    public function purgeLegacyObjects(bool $scanBucket = false): int
    {
        if (0 !== $this->legacyContentLeft()) {
            throw new \LogicException('Content from before encryption is still in use; re-encrypt every user first.');
        }
        $deleted = 0;
        do {
            /** @var list<string> $keys */
            $keys = $this->connection->fetchFirstColumn('SELECT object_key FROM legacy_object ORDER BY object_key LIMIT 500');
            foreach ($keys as $key) {
                if ($this->storage->exists($key)) {
                    $this->storage->delete($key);
                    ++$deleted;
                }
                $this->connection->executeStatement('DELETE FROM legacy_object WHERE object_key = :key', ['key' => $key]);
            }
        } while ([] !== $keys);

        foreach ($scanBucket ? BlobKind::cases() : [BlobKind::Drafts] as $kind) {
            foreach ($this->storage->list($kind->value.'/') as $key) {
                if (!BlobKey::isLegacy($key)) {
                    continue;
                }
                $this->storage->delete($key);
                ++$deleted;
            }
        }

        return $deleted;
    }

    /**
     * Users whose data is not all on their current key version yet, or who still have older versions to retire: the
     * background re-encryption's work list. Users whose keys were shredded are left out.
     *
     * @return list<string> user ids
     */
    public function usersWithWork(int $limit): array
    {
        /** @var list<string> */
        return $this->connection->fetchFirstColumn('SELECT u.id FROM app_user u WHERE '.self::HAS_WORK.' ORDER BY u.id LIMIT '.$limit);
    }

    public function countUsersWithWork(): int
    {
        return self::count($this->connection->fetchOne('SELECT COUNT(*) FROM app_user u WHERE '.self::HAS_WORK));
    }

    /**
     * Verdicts cached before the cache was keyed (or under another master key) are never matched; they only leak.
     */
    public function dropUnkeyedScanResults(string $currentKeyId): int
    {
        return (int) $this->connection->executeStatement('DELETE FROM scan_result WHERE key_id IS DISTINCT FROM :current', ['current' => $currentKeyId]);
    }

    /**
     * @return array{int, int}
     */
    private function credentials(Uuid $owner): array
    {
        $moved = $failed = 0;
        $user = $this->entityManager->getReference(User::class, $owner);
        foreach ($this->entityManager->getRepository(MailAccount::class)->findBy(['owner' => $user]) as $account) {
            if (!$this->credentials->needsReseal($account)) {
                continue;
            }
            try {
                $this->credentials->seal($account, $this->credentials->open($account));
                ++$moved;
            } catch (CryptoException $exception) {
                $this->failed('credentials', $account->getId(), $exception);
                ++$failed;
            }
        }
        foreach ($this->entityManager->getRepository(ProviderGrant::class)->findBy(['owner' => $user]) as $grant) {
            if (!$this->credentials->grantNeedsReseal($grant)) {
                continue;
            }
            try {
                $this->credentials->sealGrant($grant, $this->credentials->openGrant($grant));
                ++$moved;
            } catch (CryptoException $exception) {
                $this->failed('provider tokens', $grant->getId(), $exception);
                ++$failed;
            }
        }
        $this->entityManager->flush();
        $this->entityManager->clear();

        return [$moved, $failed];
    }

    /**
     * @return array{int, int}
     */
    private function messages(Uuid $owner, int $current, int $batch, ?\DateTimeImmutable $until): array
    {
        return $this->walk(
            'SELECT m.id, m.raw_object_key AS key FROM message m JOIN mail_account a ON a.id = m.mail_account_id
             WHERE a.owner_id = :owner AND m.raw_key_version IS DISTINCT FROM :current AND m.id > CAST(:after AS UUID) ORDER BY m.id LIMIT :batch',
            $owner,
            $current,
            $batch,
            $until,
            function (array $row) use ($owner): bool {
                $stored = $this->blobs->reencrypt($owner, BlobKind::Raw, self::string($row['key']));
                $this->rememberLegacy(self::string($row['key']));

                return 1 === $this->connection->executeStatement(
                    'UPDATE message SET raw_object_key = :key, raw_key_version = :version WHERE id = :id AND raw_object_key = :old',
                    ['key' => $stored->key, 'version' => $stored->keyVersion, 'id' => $row['id'], 'old' => $row['key']],
                );
            },
        );
    }

    /**
     * Received attachments, live or in quarantine; the content stays where it is (live or quarantined) under its new
     * name, under the scan lock of the old and the new content so a verdict or a quarantine cannot move it meanwhile.
     *
     * @return array{int, int}
     */
    private function attachments(Uuid $owner, int $current, int $batch, ?\DateTimeImmutable $until): array
    {
        return $this->walk(
            'SELECT t.id, t.sha256, t.key_version FROM attachment t JOIN mail_account a ON a.id = t.mail_account_id
             WHERE a.owner_id = :owner AND t.key_version IS DISTINCT FROM :current AND t.id > CAST(:after AS UUID) ORDER BY t.id LIMIT :batch',
            $owner,
            $current,
            $batch,
            $until,
            function (array $row) use ($owner): bool {
                $sha = self::string($row['sha256']);
                $contentOwner = null === $row['key_version'] ? null : $owner;

                return $this->connection->transactional(function () use ($row, $owner, $sha, $contentOwner): bool {
                    $this->lockContent($sha, $this->fingerprintOf($owner, $sha, $contentOwner));
                    [$from, $kind] = $this->locate([
                        [Attachment::objectKeyFor($sha, $contentOwner), BlobKind::Attachments],
                        [Attachment::quarantineKey($sha, $contentOwner), BlobKind::Quarantine],
                    ]);
                    $stored = $this->blobs->reencrypt($owner, $kind, $from);
                    $this->rememberLegacy(Attachment::objectKeyFor($sha, $contentOwner), Attachment::quarantineKey($sha, $contentOwner));

                    return 1 === $this->connection->executeStatement(
                        'UPDATE attachment SET sha256 = :fingerprint, key_version = :version WHERE id = :id AND sha256 = :old AND key_version IS NOT DISTINCT FROM :oldVersion',
                        ['fingerprint' => $stored->fingerprint, 'version' => $stored->keyVersion, 'id' => $row['id'], 'old' => $sha, 'oldVersion' => $row['key_version']],
                    );
                });
            },
        );
    }

    /**
     * Files on drafts: uploads, and received files a forward took along. A quarantined one stays in quarantine, and
     * the draft file then names the key it goes back to once released.
     *
     * @return array{int, int}
     */
    private function draftFiles(Uuid $owner, int $current, int $batch, ?\DateTimeImmutable $until): array
    {
        return $this->walk(
            'SELECT f.id, f.sha256, f.object_key AS key, f.key_version FROM draft_attachment f JOIN draft d ON d.id = f.draft_id
             WHERE d.owner_id = :owner AND f.key_version IS DISTINCT FROM :current AND f.id > CAST(:after AS UUID) ORDER BY f.id LIMIT :batch',
            $owner,
            $current,
            $batch,
            $until,
            function (array $row) use ($owner): bool {
                $sha = self::string($row['sha256']);
                $key = self::string($row['key']);
                $contentOwner = null === $row['key_version'] ? null : $owner;
                $liveKind = str_starts_with($key, BlobKind::Uploads->value.'/') ? BlobKind::Uploads : BlobKind::Attachments;

                return $this->connection->transactional(function () use ($row, $owner, $sha, $key, $contentOwner, $liveKind): bool {
                    $fingerprint = $this->fingerprintOf($owner, $sha, $contentOwner);
                    $this->lockContent($sha, $fingerprint);
                    // Like an upload: the collector must not take the new object before the row refers to it.
                    $this->uploads->lock(BlobKey::of($liveKind, $owner, $fingerprint));
                    [$from, $kind] = $this->locate([
                        [$key, $liveKind],
                        [Attachment::quarantineKey($sha, $contentOwner), BlobKind::Quarantine],
                    ]);
                    $stored = $this->blobs->reencrypt($owner, $kind, $from);
                    $this->rememberLegacy($key, Attachment::quarantineKey($sha, $contentOwner));

                    return 1 === $this->connection->executeStatement(
                        'UPDATE draft_attachment SET object_key = :key, sha256 = :fingerprint, key_version = :version
                         WHERE id = :id AND object_key = :oldKey AND key_version IS NOT DISTINCT FROM :oldVersion',
                        [
                            'key' => BlobKey::of($liveKind, $owner, $stored->fingerprint),
                            'fingerprint' => $stored->fingerprint,
                            'version' => $stored->keyVersion,
                            'id' => $row['id'],
                            'oldKey' => $key,
                            'oldVersion' => $row['key_version'],
                        ],
                    );
                });
            },
        );
    }

    /**
     * @return array{int, int}
     */
    private function outgoing(Uuid $owner, int $current, int $batch, ?\DateTimeImmutable $until): array
    {
        return $this->walk(
            'SELECT o.id, o.raw_object_key AS key FROM outgoing_message o JOIN mail_account a ON a.id = o.mail_account_id
             WHERE a.owner_id = :owner AND o.raw_key_version IS DISTINCT FROM :current AND o.id > CAST(:after AS UUID) ORDER BY o.id LIMIT :batch',
            $owner,
            $current,
            $batch,
            $until,
            function (array $row) use ($owner): bool {
                $stored = $this->blobs->reencrypt($owner, BlobKind::Outgoing, self::string($row['key']));
                $this->rememberLegacy(self::string($row['key']));

                return 1 === $this->connection->executeStatement(
                    'UPDATE outgoing_message SET raw_object_key = :key, raw_key_version = :version WHERE id = :id AND raw_object_key = :old',
                    ['key' => $stored->key, 'version' => $stored->keyVersion, 'id' => $row['id'], 'old' => $row['key']],
                );
            },
        );
    }

    /**
     * @return array{int, int}
     */
    private function bodyTexts(Uuid $owner, int $current, int $batch, ?\DateTimeImmutable $until): array
    {
        return $this->walk(
            'SELECT t.message_id AS id, t.text, t.sealed_text FROM message_text t JOIN message m ON m.id = t.message_id JOIN mail_account a ON a.id = m.mail_account_id
             WHERE a.owner_id = :owner AND (t.sealed_text IS NULL OR t.sealed_text NOT LIKE :sealed) AND t.message_id > CAST(:after AS UUID) ORDER BY t.message_id LIMIT :batch',
            $owner,
            $current,
            $batch,
            $until,
            function (array $row) use ($owner): bool {
                $messageId = Uuid::fromString(self::string($row['id']));
                $sealed = self::nullableString($row['sealed_text']);

                return 1 === $this->connection->executeStatement(
                    'UPDATE message_text SET sealed_text = :sealed, text = NULL WHERE message_id = :id AND sealed_text IS NOT DISTINCT FROM :old',
                    [
                        'sealed' => $this->fields->resealText($owner, $messageId, $sealed, self::nullableString($row['text'])),
                        'id' => $messageId->toRfc4122(),
                        'old' => $sealed,
                    ],
                );
            },
        );
    }

    /**
     * @return array{int, int}
     */
    private function snippets(Uuid $owner, int $current, int $batch, ?\DateTimeImmutable $until): array
    {
        return $this->walk(
            'SELECT m.id, m.snippet, m.sealed_snippet FROM message m JOIN mail_account a ON a.id = m.mail_account_id
             WHERE a.owner_id = :owner AND (m.sealed_snippet IS NULL OR m.sealed_snippet NOT LIKE :sealed) AND m.id > CAST(:after AS UUID) ORDER BY m.id LIMIT :batch',
            $owner,
            $current,
            $batch,
            $until,
            function (array $row) use ($owner): bool {
                $messageId = Uuid::fromString(self::string($row['id']));
                $sealed = self::nullableString($row['sealed_snippet']);

                return 1 === $this->connection->executeStatement(
                    "UPDATE message SET sealed_snippet = :sealed, snippet = '' WHERE id = :id AND sealed_snippet IS NOT DISTINCT FROM :old",
                    [
                        'sealed' => $this->fields->resealSnippet($owner, $messageId, $sealed, self::string($row['snippet'])),
                        'id' => $messageId->toRfc4122(),
                        'old' => $sealed,
                    ],
                );
            },
        );
    }

    /**
     * What mail notifications say: plaintext from before, or sealed with an older key. An empty body stays none.
     *
     * @return array{int, int}
     */
    private function notificationBodies(Uuid $owner, int $current, int $batch, ?\DateTimeImmutable $until): array
    {
        return $this->walk(
            "SELECT id, body, sealed_body FROM mail_notification
             WHERE user_id = :owner AND ((sealed_body IS NULL AND body <> '') OR sealed_body NOT LIKE :sealed) AND id > CAST(:after AS UUID) ORDER BY id LIMIT :batch",
            $owner,
            $current,
            $batch,
            $until,
            function (array $row) use ($owner): bool {
                $id = Uuid::fromString(self::string($row['id']));
                $sealed = self::nullableString($row['sealed_body']);

                return 1 === $this->connection->executeStatement(
                    "UPDATE mail_notification SET sealed_body = :sealed, body = '' WHERE id = :id AND sealed_body IS NOT DISTINCT FROM :old",
                    [
                        'sealed' => $this->fields->resealNotificationBody($owner, $id, $sealed, self::string($row['body'])),
                        'id' => $id->toRfc4122(),
                        'old' => $sealed,
                    ],
                );
            },
        );
    }

    /**
     * What chats say and who they are with ({@see ChatField}), sealed with an older key: resealed with the current one,
     * column by column. Nothing a client sees changes, so no change number is taken.
     *
     * @return array{int, int}
     */
    private function chatFields(Uuid $owner, int $current, int $batch, ?\DateTimeImmutable $until): array
    {
        $moved = $failed = 0;
        foreach (ChatField::cases() as $field) {
            [$fieldMoved, $fieldFailed] = $this->walk(
                \sprintf(
                    'SELECT x.id, x.%2$s AS sealed FROM %1$s AND x.%2$s IS NOT NULL AND x.%2$s NOT LIKE :sealed AND x.id > CAST(:after AS UUID) ORDER BY x.id LIMIT :batch',
                    $field->ownedRows(),
                    $field->column(),
                ),
                $owner,
                $current,
                $batch,
                $until,
                function (array $row) use ($owner, $field): bool {
                    $id = Uuid::fromString(self::string($row['id']));
                    $sealed = self::string($row['sealed']);

                    return 1 === $this->connection->executeStatement(
                        \sprintf('UPDATE %1$s SET %2$s = :sealed WHERE id = :id AND %2$s = :old', $field->table(), $field->column()),
                        ['sealed' => $this->chatFields->reseal($owner, $field, $id, $sealed), 'id' => $id->toRfc4122(), 'old' => $sealed],
                    );
                },
            );
            $moved += $fieldMoved;
            $failed += $fieldFailed;
        }

        return [$moved, $failed];
    }

    /**
     * Runs $move on every selected row, a batch at a time in id order, until $until (then the next run goes on). A row
     * whose move throws, or finds the row changed meanwhile (false), is left for the next run.
     *
     * @param callable(array<string, mixed>): bool $move
     *
     * @return array{int, int} rows moved, rows failed
     */
    private function walk(string $select, Uuid $owner, int $current, int $batch, ?\DateTimeImmutable $until, callable $move): array
    {
        $moved = $failed = 0;
        $after = '00000000-0000-0000-0000-000000000000';
        do {
            $rows = $this->connection->fetchAllAssociative($select, ['owner' => $owner->toRfc4122(), 'current' => $current, 'sealed' => 'f1.'.$current.'.%', 'after' => $after, 'batch' => $batch]);
            foreach ($rows as $row) {
                // Checked per row: a row is one object at most, so a run overshoots its time by one object, not a batch.
                if (self::past($until)) {
                    return [$moved, $failed];
                }
                $id = self::string($row['id']);
                $after = $id;
                try {
                    // False: the row changed meanwhile; the next run looks at it again.
                    $move($row) ? ++$moved : ++$failed;
                } catch (ObjectNotFound|CryptoException $exception) {
                    $this->failed('row', Uuid::fromString($id), $exception);
                    ++$failed;
                }
            }
        } while (\count($rows) === $batch);

        return [$moved, $failed];
    }

    private static function past(?\DateTimeImmutable $until): bool
    {
        return null !== $until && new \DateTimeImmutable() >= $until;
    }

    /**
     * The first of the places that holds the content, and which kind of place it is.
     *
     * @param non-empty-list<array{string, BlobKind}> $places
     *
     * @return array{string, BlobKind}
     */
    private function locate(array $places): array
    {
        foreach ($places as [$key, $kind]) {
            if ($this->storage->exists($key)) {
                return [$key, $kind];
            }
        }

        throw ObjectNotFound::forKey($places[0][0]);
    }

    /**
     * The fingerprint the content gets: content already encrypted keeps its own (the index key never changes), older
     * content gets the owner's fingerprint of its SHA-256.
     */
    private function fingerprintOf(Uuid $owner, string $sha256, ?Uuid $contentOwner): string
    {
        return null === $contentOwner ? $this->blobs->fingerprint($owner, $sha256) : $sha256;
    }

    /** Plaintext objects from before encryption this moved away from, for {@see purgeLegacyObjects()}. */
    private function rememberLegacy(string ...$keys): void
    {
        foreach ($keys as $key) {
            if (BlobKey::isLegacy($key)) {
                $this->connection->executeStatement('INSERT INTO legacy_object (object_key) VALUES (:key) ON CONFLICT DO NOTHING', ['key' => $key]);
            }
        }
    }

    /** The same lock a verdict and a quarantine take, for both names of the content, always in the same order. */
    private function lockContent(string ...$contents): void
    {
        $contents = array_values(array_unique($contents));
        sort($contents);
        foreach ($contents as $content) {
            $this->connection->executeStatement("SELECT pg_advisory_xact_lock(hashtextextended('scan:' || :sha, 0))", ['sha' => $content]);
        }
    }

    private function failed(string $what, Uuid $id, \Throwable $exception): void
    {
        $this->logger->warning('Re-encrypting {what} {id} failed; the next run tries again: {error}', ['what' => $what, 'id' => $id->toRfc4122(), 'error' => $exception->getMessage(), 'exception' => $exception]);
    }

    private static function count(mixed $value): int
    {
        return is_numeric($value) ? (int) $value : throw new \UnexpectedValueException('Expected a count from the database.');
    }

    private static function string(mixed $value): string
    {
        return \is_string($value) ? $value : throw new \UnexpectedValueException('Expected a text column.');
    }

    private static function nullableString(mixed $value): ?string
    {
        return null === $value ? null : self::string($value);
    }
}
