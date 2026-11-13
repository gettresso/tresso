<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * A partial index of the calendar resources that have a meeting request, so the sweep of stale requests
 * (App\Sync\Calendar\SweepMeetingRequestsHandler, every minute) reads those few rows instead of the whole table. Built
 * without blocking writes of `calendar_object`: `CREATE INDEX CONCURRENTLY` cannot run in a transaction, so this
 * migration runs without one. A build that is cut off leaves an invalid index behind; the migration is then not recorded
 * as done, and its next run drops it before building it again.
 */
final class Version20261113152700 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Partial index of calendar resources with a meeting request, built concurrently';
    }

    public function isTransactional(): bool
    {
        return false;
    }

    public function up(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS calendar_object_conference_request');
        $this->addSql('CREATE INDEX CONCURRENTLY calendar_object_conference_request ON calendar_object (id) WHERE (conference_request IS NOT NULL)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS calendar_object_conference_request');
    }
}
