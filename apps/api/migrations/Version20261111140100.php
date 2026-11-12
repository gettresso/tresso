<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * The index the orphan sweep reads, built without blocking reads and writes of `message`.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run in a transaction, so this migration runs without one. A build that is cut off
 * leaves an invalid index of that name behind; the migration is then not recorded as done, and its next run drops that
 * index before building it again.
 */
final class Version20261111140100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Index of orphaned messages per account, built concurrently';
    }

    public function isTransactional(): bool
    {
        return false;
    }

    public function up(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS message_orphaned');
        $this->addSql('CREATE INDEX CONCURRENTLY message_orphaned ON message (mail_account_id, orphaned_at) WHERE (orphaned_at IS NOT NULL)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS message_orphaned');
    }
}
