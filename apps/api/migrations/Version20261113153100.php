<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Indexes for WhatsApp files on `chat_message`: the relay takes an account's requests oldest first, a scan verdict and
 * the collector find a file's messages by its content, and the scan sweeper finds files still waiting for a verdict.
 * Built without blocking reads and writes of `chat_message`, which can be large: `CREATE INDEX CONCURRENTLY` cannot run
 * in a transaction, so this migration runs without one. A build that is cut off leaves an invalid index behind; the
 * migration is then not recorded as done, and its next run drops it before building it again.
 */
final class Version20261113153100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Indexes of WhatsApp message files by request, content and scan, built concurrently';
    }

    public function isTransactional(): bool
    {
        return false;
    }

    public function up(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_message_media_request');
        $this->addSql('CREATE INDEX CONCURRENTLY chat_message_media_request ON chat_message (chat_account_id, media_state, media_requested_at)');
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_message_media_sha');
        $this->addSql('CREATE INDEX CONCURRENTLY chat_message_media_sha ON chat_message (media_sha256)');
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_message_media_scan');
        $this->addSql('CREATE INDEX CONCURRENTLY chat_message_media_scan ON chat_message (media_scan_status, media_scan_requested_at)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_message_media_scan');
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_message_media_sha');
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_message_media_request');
    }
}
