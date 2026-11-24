<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Mail account import lists: addresses a user wants to add, sealed with the owner's key, for a day. The table is new
 * and empty, so its indexes are built with it (nothing to block); `provider_authorization_request` gets a nullable
 * column, which Postgres adds without rewriting the table.
 */
final class Version20261124141500 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Mail account import lists, and the list a provider sign-in was started from';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE mail_account_import (id UUID NOT NULL, sealed_entries TEXT NOT NULL, created_by VARCHAR(200) DEFAULT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, expires_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, owner_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX mail_account_import_owner ON mail_account_import (owner_id, expires_at)');
        $this->addSql('CREATE INDEX mail_account_import_expires ON mail_account_import (expires_at)');
        $this->addSql('CREATE INDEX IDX_B3D66E477E3C61F9 ON mail_account_import (owner_id)');
        $this->addSql('ALTER TABLE mail_account_import ADD CONSTRAINT FK_B3D66E477E3C61F9 FOREIGN KEY (owner_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE provider_authorization_request ADD import_id VARCHAR(36) DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE mail_account_import DROP CONSTRAINT FK_B3D66E477E3C61F9');
        $this->addSql('DROP TABLE mail_account_import');
        $this->addSql('ALTER TABLE provider_authorization_request DROP import_id');
    }
}
