<?php

declare(strict_types=1);

namespace App\Scan;

use App\Chat\ChatOwnerLock;
use App\Enum\ScanStatus;
use App\Realtime\AfterCommitDispatcher;
use App\Sync\Change\ChangeSequencer;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Uuid;

/**
 * Records a verdict for a piece of content on every attachment that holds it, received or attached to a draft, and on
 * every WhatsApp file with it ({@see \App\Entity\ChatMessage}), and keeps what depends on it in step.
 *
 * Writes are bulk SQL under a lock per content, so concurrent jobs for the same file see each other's results, and
 * only rows whose verdict actually changes are written: a first scan (or a cached verdict) only settles attachments
 * still waiting for one, and a failure never replaces a clean or infected verdict. Each message or draft with a
 * changed file counts as changed for its owner's clients; messages also get their attachment summary updated.
 * Moving content in or out of quarantine happens after the commit ({@see PlaceContent}).
 */
final readonly class AttachmentScans
{
    private const int BATCH = 500;

    public function __construct(
        private EntityManagerInterface $entityManager,
        private Connection $connection,
        private ChangeSequencer $sequencer,
        private AfterCommitDispatcher $afterCommit,
        private ChatOwnerLock $chatOwnerLock,
    ) {
    }

    /**
     * @param string        $sha256   the content: an owner's fingerprint, or the SHA-256 of content from before encryption
     * @param bool          $rescan   whether the verdict may replace clean and infected verdicts too
     * @param ?ScanCacheKey $cacheKey where to cache a verdict the scanner ($engine) just gave; null for a cached or failed one
     */
    public function record(string $sha256, ScanOutcome $outcome, bool $rescan, ?ScanCacheKey $cacheKey = null, ?string $engine = null): void
    {
        $this->entityManager->wrapInTransaction(function () use ($sha256, $outcome, $rescan, $cacheKey, $engine): void {
            $this->connection->executeStatement("SELECT pg_advisory_xact_lock(hashtextextended('scan:' || :sha, 0))", ['sha' => $sha256]);

            if (null !== $cacheKey && $outcome->isDefinitive()) {
                $this->cache($cacheKey, $outcome, $engine ?? throw new \LogicException('A cached verdict names the scanner that gave it.'));
            }
            $wasInfected = $this->anyInfected($sha256);

            $replaceable = $outcome->isDefinitive() && $rescan
                ? "scan_status IN ('pending', 'failed', 'clean', 'infected')"
                : "scan_status IN ('pending', 'failed')";
            $values = [
                'sha' => $sha256,
                'status' => $outcome->status->value,
                'signature' => $outcome->signature,
                'failure' => $outcome->failure?->value,
                'now' => new \DateTimeImmutable()->format('Y-m-d H:i:s'),
            ];
            $changed = $replaceable.' AND (scan_status, scan_signature, scan_failure) IS DISTINCT FROM (:status, CAST(:signature AS VARCHAR), CAST(:failure AS VARCHAR))';

            // Lock order, as everywhere else that changes these rows: the drafts and messages first (by id), then their
            // attachment rows, then each owner's change counter (by owner). Two verdicts, or a verdict and an edit,
            // then never wait on each other in a circle.
            $draftIds = self::sorted($this->connection->fetchFirstColumn('SELECT DISTINCT draft_id FROM draft_attachment WHERE sha256 = :sha AND '.$changed, $values));
            $messageIds = self::sorted($this->connection->fetchFirstColumn('SELECT DISTINCT message_id FROM attachment WHERE sha256 = :sha AND '.$changed, $values));
            foreach (array_chunk($draftIds, self::BATCH) as $batch) {
                $this->connection->executeStatement('SELECT id FROM draft WHERE id = ANY(CAST(:ids AS UUID[])) ORDER BY id FOR UPDATE', ['ids' => self::array($batch)]);
            }
            foreach (array_chunk($messageIds, self::BATCH) as $batch) {
                $this->connection->executeStatement('SELECT id FROM message WHERE id = ANY(CAST(:ids AS UUID[])) ORDER BY id FOR UPDATE', ['ids' => self::array($batch)]);
            }

            // Only the rows of the drafts and messages locked above: one stored meanwhile (the same file in new mail) is
            // left pending for its own scan job, which records it, summarizes its message and tells its clients.
            foreach (array_chunk($draftIds, self::BATCH) as $batch) {
                $this->connection->executeStatement(
                    'UPDATE draft_attachment SET scan_status = :status, scan_signature = :signature, scan_failure = :failure, scanned_at = :now
                     WHERE sha256 = :sha AND draft_id = ANY(CAST(:ids AS UUID[])) AND '.$changed,
                    $values + ['ids' => self::array($batch)],
                );
            }
            foreach (array_chunk($messageIds, self::BATCH) as $batch) {
                $this->connection->executeStatement(
                    'UPDATE attachment SET scan_status = :status, scan_signature = :signature, scan_failure = :failure, scanned_at = :now
                     WHERE sha256 = :sha AND message_id = ANY(CAST(:ids AS UUID[])) AND '.$changed,
                    $values + ['ids' => self::array($batch)],
                );
            }
            foreach (array_chunk($messageIds, self::BATCH) as $batch) {
                $this->summarize($batch);
            }

            $drafts = $this->owners('SELECT id, owner_id FROM draft WHERE id = ANY(CAST(:ids AS UUID[]))', $draftIds);
            $messages = $this->owners('SELECT m.id, a.owner_id FROM message m JOIN mail_account a ON a.id = m.mail_account_id WHERE m.id = ANY(CAST(:ids AS UUID[]))', $messageIds);
            foreach (ScanTouches::plan($drafts, $messages) as [$kind, $ownerId, $ids]) {
                if ('draft' === $kind) {
                    $this->sequencer->touchDrafts(Uuid::fromString($ownerId), $ids);
                    continue;
                }
                $this->sequencer->touchMessages(Uuid::fromString($ownerId), $ids);
            }

            $this->recordChatFiles($values, $replaceable);

            $infected = ScanStatus::Infected === $outcome->status;
            if ($outcome->isDefinitive() && ($infected || $wasInfected)) {
                $this->afterCommit->dispatch(new PlaceContent($sha256));
            }
        });
        $this->entityManager->clear();
    }

    /**
     * The verdict on the WhatsApp files with this content. Chat rows are written after the owner's row is taken, as
     * every chat write does ({@see ChatOwnerLock}); mail rows above come first and take the owner's change counter only
     * after their own rows, so no two writers wait on each other in a circle. A file's content is named by its owner's
     * fingerprint, so its rows belong to one owner.
     *
     * @param array<string, mixed> $values
     */
    private function recordChatFiles(array $values, string $replaceable): void
    {
        $replaceable = str_replace('scan_status', 'media_scan_status', $replaceable);
        $changed = $replaceable.' AND (media_scan_status, media_scan_failure) IS DISTINCT FROM (:status, CAST(:failure AS VARCHAR))';
        /** @var list<array{id: string, owner_id: string}> $rows */
        $rows = $this->connection->fetchAllAssociative(
            'SELECT m.id, a.owner_id FROM chat_message m JOIN chat_account a ON a.id = m.chat_account_id WHERE m.media_sha256 = :sha AND '.$changed,
            ['sha' => $values['sha'], 'status' => $values['status'], 'failure' => $values['failure']],
        );
        $byOwner = [];
        foreach ($rows as $row) {
            $byOwner[$row['owner_id']][] = $row['id'];
        }
        ksort($byOwner, \SORT_STRING);
        foreach ($byOwner as $ownerId => $ids) {
            $owner = Uuid::fromString((string) $ownerId);
            $this->chatOwnerLock->lock($owner);
            /** @var list<string> $updated */
            $updated = $this->connection->fetchFirstColumn(
                'UPDATE chat_message SET media_scan_status = :status, media_scan_failure = :failure
                 WHERE media_sha256 = :sha AND id = ANY(CAST(:ids AS UUID[])) AND '.$changed.' RETURNING id',
                ['sha' => $values['sha'], 'status' => $values['status'], 'failure' => $values['failure'], 'ids' => self::array(self::sorted($ids))],
            );
            $this->sequencer->touchChatMessages($owner, $updated);
        }
    }

    private function cache(ScanCacheKey $key, ScanOutcome $outcome, string $engine): void
    {
        $this->connection->executeStatement(
            'INSERT INTO scan_result (content_key, key_id, status, signature, engine, scanned_at) VALUES (:key, :keyId, :status, :signature, :engine, :now)
             ON CONFLICT (content_key) DO UPDATE SET key_id = EXCLUDED.key_id, status = EXCLUDED.status, signature = EXCLUDED.signature, engine = EXCLUDED.engine, scanned_at = EXCLUDED.scanned_at',
            [
                'key' => $key->contentKey,
                'keyId' => $key->keyId,
                'status' => $outcome->status->value,
                'signature' => $outcome->signature,
                'engine' => mb_substr($engine, 0, 255),
                'now' => new \DateTimeImmutable()->format('Y-m-d H:i:s'),
            ],
        );
    }

    private function anyInfected(string $sha256): bool
    {
        return (bool) $this->connection->fetchOne(
            "SELECT EXISTS (SELECT 1 FROM attachment WHERE sha256 = :sha AND scan_status = 'infected')
                 OR EXISTS (SELECT 1 FROM draft_attachment WHERE sha256 = :sha AND scan_status = 'infected')
                 OR EXISTS (SELECT 1 FROM chat_message WHERE media_sha256 = :sha AND media_scan_status = 'infected')",
            ['sha' => $sha256],
        );
    }

    /**
     * @param list<string> $messageIds
     */
    private function summarize(array $messageIds): void
    {
        /** @var list<array{message_id: string, scan_status: string}> $rows */
        $rows = $this->connection->fetchAllAssociative(
            'SELECT message_id, scan_status FROM attachment WHERE message_id = ANY(CAST(:ids AS UUID[]))',
            ['ids' => self::array($messageIds)],
        );
        $statuses = [];
        foreach ($rows as $row) {
            $statuses[$row['message_id']][] = ScanStatus::from($row['scan_status']);
        }

        $parameters = [];
        $values = [];
        foreach ($statuses as $messageId => $list) {
            $values[] = \sprintf('(CAST(:m%1$d AS UUID), CAST(:s%1$d AS VARCHAR))', \count($values));
            $parameters['m'.(\count($values) - 1)] = $messageId;
            $parameters['s'.(\count($values) - 1)] = ScanStatus::summarize($list)?->value;
        }
        if ([] === $values) {
            return;
        }
        $this->connection->executeStatement(
            'UPDATE message m SET attachment_scan = v.summary FROM (VALUES '.implode(', ', $values).') AS v (id, summary) WHERE m.id = v.id',
            $parameters,
        );
    }

    /**
     * @param list<string> $ids
     *
     * @return list<array{id: string, owner_id: string}>
     */
    private function owners(string $sql, array $ids): array
    {
        $rows = [];
        foreach (array_chunk($ids, self::BATCH) as $batch) {
            /** @var list<array{id: string, owner_id: string}> $found */
            $found = $this->connection->fetchAllAssociative($sql, ['ids' => self::array($batch)]);
            array_push($rows, ...$found);
        }

        return $rows;
    }

    /**
     * @param list<mixed> $ids
     *
     * @return list<string>
     */
    private static function sorted(array $ids): array
    {
        $ids = array_values(array_unique(array_filter($ids, \is_string(...))));
        sort($ids, \SORT_STRING);

        return $ids;
    }

    /**
     * @param list<string> $ids
     */
    private static function array(array $ids): string
    {
        return '{'.implode(',', $ids).'}';
    }
}
