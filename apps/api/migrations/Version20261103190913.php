<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20261103190913 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Personal access tokens: a hashed secret per token, its scopes, expiry, last use and revocation';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TABLE personal_access_token (id UUID NOT NULL, name VARCHAR(80) NOT NULL, token_hash VARCHAR(64) NOT NULL, prefix VARCHAR(32) NOT NULL, scopes JSON NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, expires_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, last_used_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, revoked_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, owner_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_5017171AB3BC57DA ON personal_access_token (token_hash)');
        $this->addSql('CREATE INDEX IDX_5017171A7E3C61F98B8E8428 ON personal_access_token (owner_id, created_at)');
        $this->addSql('CREATE INDEX IDX_5017171A7E3C61F9 ON personal_access_token (owner_id)');
        $this->addSql('ALTER TABLE personal_access_token ADD CONSTRAINT FK_5017171A7E3C61F9 FOREIGN KEY (owner_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('ALTER TABLE personal_access_token DROP CONSTRAINT FK_5017171A7E3C61F9');
        $this->addSql('DROP TABLE personal_access_token');
    }
}
