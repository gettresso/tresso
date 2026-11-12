<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * The index the reply queue reads to refuse the id of a reply that was removed, built without blocking reads and writes
 * of `sync_tombstone`, which is large. Partial: only removals of WhatsApp replies are in it.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run in a transaction, so this migration runs without one. A build that is cut off
 * leaves an invalid index of that name behind; the migration is then not recorded as done, and its next run drops that
 * index before building it again.
 */
final class Version20261112184500 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Index of removed WhatsApp replies per user, built concurrently';
    }

    public function isTransactional(): bool
    {
        return false;
    }

    public function up(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS sync_tombstone_chat_outgoing');
        $this->addSql("CREATE INDEX CONCURRENTLY sync_tombstone_chat_outgoing ON sync_tombstone (user_id, entity_id) WHERE ((entity_type)::text = 'chatOutgoing'::text)");
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS sync_tombstone_chat_outgoing');
    }
}
