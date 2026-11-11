<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20261111120000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'The address a new provider sign-in was started for, sent to the provider as login hint';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE provider_authorization_request ADD login_hint VARCHAR(320) DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE provider_authorization_request DROP login_hint');
    }
}
