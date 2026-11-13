<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * The meeting link asked of a calendar's provider that is not on the event yet: on the resource (with its nonce) and on
 * the master row. Two nullable columns without a default: Postgres only records them, it rewrites neither large table.
 * The lock timeout makes the short lock fail fast instead of queueing every query behind a long transaction.
 */
final class Version20261113110000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Calendar events: the state of a requested meeting link';
    }

    public function up(Schema $schema): void
    {
        $this->addSql("SET LOCAL lock_timeout = '5s'");
        $this->addSql('ALTER TABLE calendar_object ADD conference_request JSON DEFAULT NULL');
        $this->addSql('ALTER TABLE calendar_event ADD conference_request JSON DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql("SET LOCAL lock_timeout = '5s'");
        $this->addSql('ALTER TABLE calendar_object DROP conference_request');
        $this->addSql('ALTER TABLE calendar_event DROP conference_request');
    }
}
