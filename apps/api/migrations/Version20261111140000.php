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
        $this->addSql('ALTER TABLE message ADD orphaned_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
        $this->addSql('CREATE INDEX message_orphaned ON message (orphaned_at) WHERE (orphaned_at IS NOT NULL)');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('DROP INDEX message_orphaned');
        $this->addSql('ALTER TABLE message DROP orphaned_at');
    }
}
