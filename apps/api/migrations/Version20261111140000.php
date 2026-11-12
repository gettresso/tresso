<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20261111140000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'When a message lost its last folder: it is deleted only after a grace period, so a move in another mail app keeps it';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        // A nullable column without a default changes only the catalog: the table's lock is held for an instant. The
        // index on it is built without blocking `message` in Version20261111140100.
        $this->addSql('ALTER TABLE message ADD orphaned_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        // Dropping the column also drops an index still on it, should Version20261111140100 not have been reverted.
        $this->addSql('ALTER TABLE message DROP orphaned_at');
    }
}
