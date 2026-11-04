<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20261104141207 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Where a provider sign-in returns to: the web app, or the desktop app through its own link';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('ALTER TABLE provider_authorization_request ADD return_to VARCHAR(16) DEFAULT \'web\' NOT NULL');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('ALTER TABLE provider_authorization_request DROP return_to');
    }
}
