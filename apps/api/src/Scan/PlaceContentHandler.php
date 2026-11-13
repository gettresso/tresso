<?php

declare(strict_types=1);

namespace App\Scan;

use App\Entity\Attachment;
use App\Storage\ObjectNotFound;
use App\Storage\ObjectStorage;
use Doctrine\DBAL\Connection;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Uid\Uuid;

/**
 * Moves content to quarantine while any attachment (or WhatsApp file) with it is infected, and back to every key an attachment still
 * refers to once none is. Storage errors make Messenger retry; the downloads follow the committed verdict meanwhile.
 */
#[AsMessageHandler]
final readonly class PlaceContentHandler
{
    public function __construct(
        private Connection $connection,
        private ObjectStorage $storage,
        private LoggerInterface $logger,
    ) {
    }

    public function __invoke(PlaceContent $message): void
    {
        // The same lock as recording a verdict: the verdict cannot change while content moves, and two placements of
        // the same content (a quarantine and a release) never interleave.
        $this->connection->transactional(function () use ($message): void {
            $this->connection->executeStatement("SELECT pg_advisory_xact_lock(hashtextextended('scan:' || :sha, 0))", ['sha' => $message->sha256]);
            $this->place($message->sha256);
        });
    }

    private function place(string $sha256): void
    {
        $owner = $this->contentOwner($sha256);
        if (false === $owner) {
            return;
        }
        $quarantine = Attachment::quarantineKey($sha256, $owner);
        $liveKeys = $this->liveKeys($sha256, $owner);

        if ($this->infected($sha256)) {
            foreach ($liveKeys as $key) {
                try {
                    $this->storage->move($key, $quarantine);
                } catch (ObjectNotFound) {
                    continue;
                }
                $this->logger->info('Quarantined {key}.', ['key' => $key]);
            }

            return;
        }

        if ([] === $liveKeys) {
            return;
        }
        try {
            foreach ($liveKeys as $key) {
                $this->storage->copy($quarantine, $key);
            }
        } catch (ObjectNotFound) {
            return;
        }
        $this->storage->delete($quarantine);
        $this->logger->info('Released {sha256} from quarantine.', ['sha256' => $sha256]);
    }

    private function infected(string $sha256): bool
    {
        return (bool) $this->connection->fetchOne(
            "SELECT EXISTS (SELECT 1 FROM attachment WHERE sha256 = :sha AND scan_status = 'infected')
                 OR EXISTS (SELECT 1 FROM draft_attachment WHERE sha256 = :sha AND scan_status = 'infected')
                 OR EXISTS (SELECT 1 FROM chat_message WHERE media_sha256 = :sha AND media_scan_status = 'infected')",
            ['sha' => $sha256],
        );
    }

    /**
     * Whose key the content is encrypted with: one owner, since a fingerprint names content within one owner; null
     * for content from before encryption; false when no attachment has the content any more.
     */
    private function contentOwner(string $sha256): Uuid|false|null
    {
        /** @var array{owner_id: string, encrypted: bool}|false $holder */
        $holder = $this->connection->fetchAssociative(
            '(SELECT m.owner_id, a.key_version IS NOT NULL AS encrypted FROM attachment a JOIN mail_account m ON m.id = a.mail_account_id WHERE a.sha256 = :sha LIMIT 1)
             UNION ALL
             (SELECT d.owner_id, da.key_version IS NOT NULL AS encrypted FROM draft_attachment da JOIN draft d ON d.id = da.draft_id WHERE da.sha256 = :sha LIMIT 1)
             UNION ALL
             (SELECT c.owner_id, true AS encrypted FROM chat_message cm JOIN chat_account c ON c.id = cm.chat_account_id WHERE cm.media_sha256 = :sha LIMIT 1)
             LIMIT 1',
            ['sha' => $sha256],
        );
        if (false === $holder) {
            return false;
        }

        return $holder['encrypted'] ? Uuid::fromString($holder['owner_id']) : null;
    }

    /**
     * Where attachments with this content expect it: the received key, the upload key of draft uploads, and the key of
     * WhatsApp files.
     *
     * @return list<string>
     */
    private function liveKeys(string $sha256, ?Uuid $owner): array
    {
        $keys = $this->connection->fetchOne('SELECT EXISTS (SELECT 1 FROM attachment WHERE sha256 = :sha)', ['sha' => $sha256])
            ? [Attachment::objectKeyFor($sha256, $owner)]
            : [];
        /** @var list<string> $draftKeys */
        $draftKeys = $this->connection->fetchFirstColumn('SELECT DISTINCT object_key FROM draft_attachment WHERE sha256 = :sha', ['sha' => $sha256]);
        /** @var list<string> $chatKeys */
        $chatKeys = $this->connection->fetchFirstColumn('SELECT DISTINCT media_object_key FROM chat_message WHERE media_sha256 = :sha AND media_object_key IS NOT NULL', ['sha' => $sha256]);

        return array_values(array_unique([...$keys, ...$draftKeys, ...$chatKeys]));
    }
}
