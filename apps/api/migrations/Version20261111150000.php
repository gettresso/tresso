<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20261111150000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'When a run last handled a bulk action, so a sweep finds the ones whose queue message got lost';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        // Nullable: an API host still on the old code inserts without it during a rolling deploy (the sweep then goes
        // by created_at). A default would be the database session's local time, not UTC.
        $this->addSql('ALTER TABLE bulk_action ADD updated_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
        $this->addSql('UPDATE bulk_action SET updated_at = COALESCE(finished_at, created_at)');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('ALTER TABLE bulk_action DROP updated_at');
    }
}
