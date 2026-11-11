<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20261112090000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'The CalDAV address a sync worker found for an account, for the user to confirm';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE mail_account ADD calendar_found_url VARCHAR(2048) DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE mail_account DROP calendar_found_url');
    }
}
